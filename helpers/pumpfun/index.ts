import { PublicKey } from '@solana/web3.js';

const PUBKEY_LENGTH = 32;
const U64_LENGTH = 8;
const I64_LENGTH = 8;
const PRICE_SCALE = 1_000_000_000n;
const MINIMUM_LAYOUT_SIZE = 8 + PUBKEY_LENGTH * 12 + U64_LENGTH * 4 + 1 + 7 + I64_LENGTH * 2;

const DEFAULT_ACCOUNT_SIZE = 512;
const parsedAccountSize = Number(process.env.PUMPFUN_BONDING_CURVE_ACCOUNT_SIZE);

export const PUMPFUN_BONDING_CURVE_ACCOUNT_SIZE = Number.isFinite(parsedAccountSize) && parsedAccountSize > 0
  ? parsedAccountSize
  : DEFAULT_ACCOUNT_SIZE;

const DEFAULT_PUMPFUN_PROGRAM_ID = 'pumpHm9GYEucU5usmTr4Wr9PXAbQGzrYAKXLfX8Lm6Yz';

export const PUMPFUN_PROGRAM_ID = new PublicKey(
  process.env.PUMPFUN_PROGRAM_ID ?? DEFAULT_PUMPFUN_PROGRAM_ID,
);

export interface PumpfunBondingCurveState {
  authority: PublicKey;
  creator: PublicKey;
  bondingCurve: PublicKey;
  associatedBondingCurve: PublicKey;
  tokenBondingCurve: PublicKey;
  associatedTokenBondingCurve: PublicKey;
  tokenVault: PublicKey;
  quoteVault: PublicKey;
  baseVault: PublicKey;
  tokenMint: PublicKey;
  baseMint: PublicKey;
  feeRecipient: PublicKey;
  targetMintSupply: bigint;
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  tokenTotalSupply: bigint;
  complete: boolean;
  goLiveUnixTime: number;
  lastTradeUnixTime: number;
}

export interface PumpfunPoolEventPayload {
  account: PublicKey;
  mint: PublicKey;
  state: PumpfunBondingCurveState;
  prices: {
    lamportsPerToken?: number;
    marketCapLamports?: bigint;
  };
}

const readPubkey = (buffer: Buffer, offset: number) =>
  new PublicKey(buffer.subarray(offset, offset + PUBKEY_LENGTH));

const readBigUInt64LE = (buffer: Buffer, offset: number) =>
  buffer.readBigUInt64LE(offset);

const readBigInt64LE = (buffer: Buffer, offset: number) =>
  buffer.readBigInt64LE(offset);

export const decodePumpfunBondingCurve = (buffer: Buffer): PumpfunBondingCurveState => {
  if (buffer.length < MINIMUM_LAYOUT_SIZE) {
    throw new Error('Invalid pump.fun bonding curve account length');
  }

  let offset = 8; // anchor discriminator

  const authority = readPubkey(buffer, offset);
  offset += PUBKEY_LENGTH;

  const creator = readPubkey(buffer, offset);
  offset += PUBKEY_LENGTH;

  const bondingCurve = readPubkey(buffer, offset);
  offset += PUBKEY_LENGTH;

  const associatedBondingCurve = readPubkey(buffer, offset);
  offset += PUBKEY_LENGTH;

  const tokenBondingCurve = readPubkey(buffer, offset);
  offset += PUBKEY_LENGTH;

  const associatedTokenBondingCurve = readPubkey(buffer, offset);
  offset += PUBKEY_LENGTH;

  const tokenVault = readPubkey(buffer, offset);
  offset += PUBKEY_LENGTH;

  const quoteVault = readPubkey(buffer, offset);
  offset += PUBKEY_LENGTH;

  const baseVault = readPubkey(buffer, offset);
  offset += PUBKEY_LENGTH;

  const tokenMint = readPubkey(buffer, offset);
  offset += PUBKEY_LENGTH;

  const baseMint = readPubkey(buffer, offset);
  offset += PUBKEY_LENGTH;

  const feeRecipient = readPubkey(buffer, offset);
  offset += PUBKEY_LENGTH;

  const targetMintSupply = readBigUInt64LE(buffer, offset);
  offset += U64_LENGTH;

  const virtualTokenReserves = readBigUInt64LE(buffer, offset);
  offset += U64_LENGTH;

  const virtualSolReserves = readBigUInt64LE(buffer, offset);
  offset += U64_LENGTH;

  const tokenTotalSupply = readBigUInt64LE(buffer, offset);
  offset += U64_LENGTH;

  const complete = buffer.readUInt8(offset) === 1;
  offset += 1;

  offset += 7; // padding

  const goLiveUnixTime = Number(readBigInt64LE(buffer, offset));
  offset += I64_LENGTH;

  const lastTradeUnixTime = Number(readBigInt64LE(buffer, offset));

  return {
    authority,
    creator,
    bondingCurve,
    associatedBondingCurve,
    tokenBondingCurve,
    associatedTokenBondingCurve,
    tokenVault,
    quoteVault,
    baseVault,
    tokenMint,
    baseMint,
    feeRecipient,
    targetMintSupply,
    virtualTokenReserves,
    virtualSolReserves,
    tokenTotalSupply,
    complete,
    goLiveUnixTime,
    lastTradeUnixTime,
  };
};

export const toPumpfunPoolEvent = (
  account: PublicKey,
  state: PumpfunBondingCurveState,
): PumpfunPoolEventPayload => {
  let lamportsPerToken: number | undefined;
  let marketCapLamports: bigint | undefined;

  if (state.virtualTokenReserves > 0n) {
    const scaledPrice = (state.virtualSolReserves * PRICE_SCALE) / state.virtualTokenReserves;
    lamportsPerToken = Number(scaledPrice) / Number(PRICE_SCALE);
    marketCapLamports =
      (state.tokenTotalSupply * state.virtualSolReserves) / state.virtualTokenReserves;
  }

  return {
    account,
    mint: state.tokenMint,
    state,
    prices: {
      lamportsPerToken,
      marketCapLamports,
    },
  };
};
