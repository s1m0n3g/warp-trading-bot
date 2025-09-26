import {
  AccountLayout,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  createInitializeAccountInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
} from '@solana/web3.js';
import BN from 'bn.js';

export type PumpFunPoolType = 'pumpfun';

export interface PumpFunBondingCurveState {
  type: PumpFunPoolType;
  mint: PublicKey;
  decimals: number;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  feeBps?: number;
  programId?: PublicKey;
  bondingCurve?: PublicKey;
  associatedBondingCurve?: PublicKey;
  globalAccount?: PublicKey;
  feeRecipient?: PublicKey;
  eventAuthority?: PublicKey;
}

export interface PumpFunCachedPoolItem {
  id: string;
  type: PumpFunPoolType;
  state: PumpFunBondingCurveState;
  sold: boolean;
}

export interface PumpFunSwapCommonParams {
  connection: Connection;
  wallet: Keypair;
  pool: PumpFunBondingCurveState;
  userTokenAccount: PublicKey;
  slippage: number;
  includeComputeBudget?: boolean;
  computeUnitLimit?: number;
  computeUnitPrice?: number;
  referralAccount?: PublicKey;
}

export interface PumpFunBuyParams extends PumpFunSwapCommonParams {
  amountLamports: bigint;
}

export interface PumpFunSellParams extends PumpFunSwapCommonParams {
  tokenAmount: bigint;
  closeTokenAccount?: boolean;
}

export interface PumpFunSwapBuildResult {
  transaction: VersionedTransaction;
  latestBlockhash: Readonly<{ blockhash: string; lastValidBlockHeight: number }>;
  expectedOutput: bigint;
  minimumOutput: bigint;
}

const DEFAULT_PUMP_FUN_PROGRAM_ID = new PublicKey('pumpSn4aUAGb6nbeQC6GNxF4fA7nAMV9szbmWzxubQb');
const DEFAULT_FEE_BPS = 100; // 1%

type SeedVariant = 'hyphen' | 'underscore';

const BONDING_CURVE_SEEDS: Record<SeedVariant, Buffer> = {
  hyphen: Buffer.from('bonding-curve'),
  underscore: Buffer.from('bonding_curve'),
};

const GLOBAL_ACCOUNT_SEEDS: Record<SeedVariant, Buffer> = {
  hyphen: Buffer.from('global'),
  underscore: Buffer.from('global'),
};

const FEE_RECIPIENT_SEEDS: Record<SeedVariant, Buffer> = {
  hyphen: Buffer.from('fee-recipient'),
  underscore: Buffer.from('fee_recipient'),
};

const EVENT_AUTHORITY_SEEDS: Record<SeedVariant, Buffer> = {
  hyphen: Buffer.from('event-authority'),
  underscore: Buffer.from('event_authority'),
};

const BASIS_POINTS_FACTOR = BigInt(10_000);

export function isPumpFunPoolState(value: unknown): value is PumpFunBondingCurveState {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const maybe = value as Partial<PumpFunBondingCurveState> & { [key: string]: unknown };

  return (
    maybe.type === 'pumpfun' &&
    maybe.mint instanceof PublicKey &&
    typeof maybe.decimals === 'number' &&
    typeof maybe.virtualTokenReserves === 'bigint' &&
    typeof maybe.virtualSolReserves === 'bigint'
  );
}

function deriveWithVariants(
  seedMap: Record<SeedVariant, Buffer>,
  programId: PublicKey,
  extraSeed?: Buffer,
  expected?: PublicKey,
): PublicKey {
  for (const variant of Object.keys(seedMap) as SeedVariant[]) {
    const seeds = extraSeed ? [seedMap[variant], extraSeed] : [seedMap[variant]];
    const [derived] = PublicKey.findProgramAddressSync(seeds, programId);

    if (!expected || derived.equals(expected)) {
      return derived;
    }
  }

  throw new Error('Unable to derive PDA for pump.fun accounts');
}

function derivePumpFunAccounts(pool: PumpFunBondingCurveState) {
  const programId = pool.programId ?? DEFAULT_PUMP_FUN_PROGRAM_ID;

  const bondingCurve =
    pool.bondingCurve ?? deriveWithVariants(BONDING_CURVE_SEEDS, programId, pool.mint.toBuffer());

  const associatedBondingCurve =
    pool.associatedBondingCurve ?? getAssociatedTokenAddressSync(pool.mint, bondingCurve, true);

  const globalAccount = pool.globalAccount ?? deriveWithVariants(GLOBAL_ACCOUNT_SEEDS, programId);
  const feeRecipient = pool.feeRecipient ?? deriveWithVariants(FEE_RECIPIENT_SEEDS, programId);
  const eventAuthority = pool.eventAuthority ?? deriveWithVariants(EVENT_AUTHORITY_SEEDS, programId);

  return {
    programId,
    bondingCurve,
    associatedBondingCurve,
    globalAccount,
    feeRecipient,
    eventAuthority,
  };
}

function encodePumpFunInstruction(discriminator: number, amount: bigint, minOutput: bigint): Buffer {
  const data = Buffer.alloc(1 + 8 + 8);
  data.writeUInt8(discriminator, 0);
  data.writeBigUInt64LE(amount, 1);
  data.writeBigUInt64LE(minOutput, 9);
  return data;
}

function applyBps(value: bigint, bps: bigint, direction: 'up' | 'down'): bigint {
  if (direction === 'down') {
    return (value * (BASIS_POINTS_FACTOR - bps)) / BASIS_POINTS_FACTOR;
  }

  return (value * (BASIS_POINTS_FACTOR + bps)) / BASIS_POINTS_FACTOR;
}

function calculateBuyAmounts(
  pool: PumpFunBondingCurveState,
  amountLamports: bigint,
  slippage: number,
): { expectedTokens: bigint; minTokens: bigint } {
  const feeBps = BigInt(pool.feeBps ?? DEFAULT_FEE_BPS);
  const effectiveInput = applyBps(amountLamports, feeBps, 'down');

  const k = pool.virtualTokenReserves * pool.virtualSolReserves;
  const newVirtualSol = pool.virtualSolReserves + effectiveInput;
  const newVirtualToken = k / newVirtualSol;

  const tokensOut = pool.virtualTokenReserves - newVirtualToken;

  const slippageBps = BigInt(Math.round(slippage * 100));
  const minTokens = applyBps(tokensOut, slippageBps, 'down');

  return { expectedTokens: tokensOut, minTokens };
}

function calculateSellAmounts(
  pool: PumpFunBondingCurveState,
  tokenAmount: bigint,
  slippage: number,
): { expectedLamports: bigint; minLamports: bigint } {
  const feeBps = BigInt(pool.feeBps ?? DEFAULT_FEE_BPS);

  const k = pool.virtualTokenReserves * pool.virtualSolReserves;
  const newVirtualToken = pool.virtualTokenReserves + tokenAmount;
  const newVirtualSol = k / newVirtualToken;
  const solOut = pool.virtualSolReserves - newVirtualSol;

  const solOutAfterFee = applyBps(solOut, feeBps, 'down');
  const slippageBps = BigInt(Math.round(slippage * 100));
  const minLamports = applyBps(solOutAfterFee, slippageBps, 'down');

  return { expectedLamports: solOutAfterFee, minLamports };
}

async function prepareWrappedSolAccount(
  connection: Connection,
  wallet: Keypair,
  lamports: bigint,
  additionalLamports: bigint = BigInt(0),
) {
  const rentLamports = BigInt(await connection.getMinimumBalanceForRentExemption(AccountLayout.span));
  const newAccount = Keypair.generate();
  const totalLamports = rentLamports + lamports + additionalLamports;

  const instructions: TransactionInstruction[] = [
    SystemProgram.createAccount({
      fromPubkey: wallet.publicKey,
      newAccountPubkey: newAccount.publicKey,
      lamports: Number(totalLamports),
      space: AccountLayout.span,
      programId: TOKEN_PROGRAM_ID,
    }),
    createInitializeAccountInstruction(newAccount.publicKey, NATIVE_MINT, wallet.publicKey),
  ];

  return { keypair: newAccount, instructions };
}

export async function buildPumpFunBuyTransaction(params: PumpFunBuyParams): Promise<PumpFunSwapBuildResult> {
  const { connection, wallet, pool, userTokenAccount, amountLamports, slippage, includeComputeBudget } = params;

  const derived = derivePumpFunAccounts(pool);
  const { expectedTokens, minTokens } = calculateBuyAmounts(pool, amountLamports, slippage);

  const wsolPreparation = await prepareWrappedSolAccount(connection, wallet, amountLamports);

  const latestBlockhash = await connection.getLatestBlockhash();

  const instructions: TransactionInstruction[] = [];

  if (includeComputeBudget) {
    if (params.computeUnitPrice) {
      instructions.push(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: params.computeUnitPrice }),
      );
    }
    if (params.computeUnitLimit) {
      instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: params.computeUnitLimit }));
    }
  }

  instructions.push(...wsolPreparation.instructions);
  instructions.push(
    createAssociatedTokenAccountIdempotentInstruction(
      wallet.publicKey,
      userTokenAccount,
      wallet.publicKey,
      pool.mint,
    ),
  );

  const buyInstruction = new TransactionInstruction({
    programId: derived.programId,
    keys: [
      { pubkey: derived.globalAccount, isSigner: false, isWritable: true },
      { pubkey: derived.feeRecipient, isSigner: false, isWritable: true },
      { pubkey: pool.mint, isSigner: false, isWritable: true },
      { pubkey: derived.bondingCurve, isSigner: false, isWritable: true },
      { pubkey: derived.associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: wsolPreparation.keypair.publicKey, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: derived.eventAuthority, isSigner: false, isWritable: false },
      ...(params.referralAccount
        ? [{ pubkey: params.referralAccount, isSigner: false, isWritable: true }]
        : []),
    ],
    data: encodePumpFunInstruction(0, amountLamports, minTokens),
  });

  instructions.push(buyInstruction);
  instructions.push(
    createCloseAccountInstruction(wsolPreparation.keypair.publicKey, wallet.publicKey, wallet.publicKey),
  );

  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(message);
  transaction.sign([wallet, wsolPreparation.keypair]);

  return {
    transaction,
    latestBlockhash,
    expectedOutput: expectedTokens,
    minimumOutput: minTokens,
  };
}

export async function buildPumpFunSellTransaction(
  params: PumpFunSellParams,
): Promise<PumpFunSwapBuildResult> {
  const {
    connection,
    wallet,
    pool,
    userTokenAccount,
    tokenAmount,
    slippage,
    includeComputeBudget,
  } = params;

  const derived = derivePumpFunAccounts(pool);
  const { expectedLamports, minLamports } = calculateSellAmounts(pool, tokenAmount, slippage);

  const wsolPreparation = await prepareWrappedSolAccount(connection, wallet, BigInt(0));

  const latestBlockhash = await connection.getLatestBlockhash();

  const instructions: TransactionInstruction[] = [];

  if (includeComputeBudget) {
    if (params.computeUnitPrice) {
      instructions.push(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: params.computeUnitPrice }),
      );
    }
    if (params.computeUnitLimit) {
      instructions.push(ComputeBudgetProgram.setComputeUnitLimit({ units: params.computeUnitLimit }));
    }
  }

  instructions.push(...wsolPreparation.instructions);

  const sellInstruction = new TransactionInstruction({
    programId: derived.programId,
    keys: [
      { pubkey: derived.globalAccount, isSigner: false, isWritable: true },
      { pubkey: derived.feeRecipient, isSigner: false, isWritable: true },
      { pubkey: pool.mint, isSigner: false, isWritable: true },
      { pubkey: derived.bondingCurve, isSigner: false, isWritable: true },
      { pubkey: derived.associatedBondingCurve, isSigner: false, isWritable: true },
      { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
      { pubkey: userTokenAccount, isSigner: false, isWritable: true },
      { pubkey: wsolPreparation.keypair.publicKey, isSigner: false, isWritable: true },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isSigner: false, isWritable: false },
      { pubkey: derived.eventAuthority, isSigner: false, isWritable: false },
      ...(params.referralAccount
        ? [{ pubkey: params.referralAccount, isSigner: false, isWritable: true }]
        : []),
    ],
    data: encodePumpFunInstruction(1, tokenAmount, minLamports),
  });

  instructions.push(sellInstruction);

  if (params.closeTokenAccount) {
    instructions.push(createCloseAccountInstruction(userTokenAccount, wallet.publicKey, wallet.publicKey));
  }

  instructions.push(
    createCloseAccountInstruction(wsolPreparation.keypair.publicKey, wallet.publicKey, wallet.publicKey),
  );

  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: latestBlockhash.blockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(message);
  transaction.sign([wallet, wsolPreparation.keypair]);

  return {
    transaction,
    latestBlockhash,
    expectedOutput: expectedLamports,
    minimumOutput: minLamports,
  };
}

export function lamportsToTokenAmount(lamports: bigint, decimals: number): BN {
  const factor = BigInt(10) ** BigInt(decimals);
  return new BN((lamports * factor).toString());
}

