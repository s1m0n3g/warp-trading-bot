import { LIQUIDITY_STATE_LAYOUT_V4, LiquidityStateV4 } from '@raydium-io/raydium-sdk';
import { PublicKey } from '@solana/web3.js';
import { logger } from '../helpers';
import { PumpFunPoolState } from '../helpers/pumpfun/types';
import { promises as fs } from 'fs';
import * as path from 'path';

export type PoolType = 'raydium' | 'pumpfun';

export interface BasePoolSnapshot<TState> {
  id: string;
  sold: boolean;
  type: PoolType;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseDecimals: number;
  quoteDecimals: number;
  state: TState;
}

export type RaydiumPoolSnapshot = BasePoolSnapshot<LiquidityStateV4> & {
  type: 'raydium';
  marketId: PublicKey;
};

export type PumpFunPoolSnapshot = BasePoolSnapshot<PumpFunPoolState> & {
  type: 'pumpfun';
};

export type PoolSnapshot = RaydiumPoolSnapshot | PumpFunPoolSnapshot;

export const isRaydiumPool = (snapshot: PoolSnapshot): snapshot is RaydiumPoolSnapshot =>
  snapshot.type === 'raydium';

export const isPumpFunPool = (snapshot: PoolSnapshot): snapshot is PumpFunPoolSnapshot =>
  snapshot.type === 'pumpfun';

export function createRaydiumPoolSnapshot(id: string, state: LiquidityStateV4): RaydiumPoolSnapshot {
  return {
    id,
    sold: false,
    type: 'raydium',
    baseMint: state.baseMint,
    quoteMint: state.quoteMint,
    baseDecimals: state.baseDecimal.toNumber(),
    quoteDecimals: state.quoteDecimal.toNumber(),
    marketId: state.marketId,
    state,
  };
}

export function createPumpFunPoolSnapshot(id: string, state: PumpFunPoolState): PumpFunPoolSnapshot {
  return {
    id,
    sold: false,
    type: 'pumpfun',
    baseMint: state.baseMint,
    quoteMint: state.quoteMint,
    baseDecimals: state.baseDecimals,
    quoteDecimals: state.quoteDecimals,
    state,
  };
}

type PersistedPoolSnapshot = PersistedRaydiumPoolSnapshot | PersistedPumpFunPoolSnapshot;

interface PersistedBasePoolSnapshot {
  id: string;
  sold: boolean;
  type: PoolType;
  baseMint: string;
  quoteMint: string;
  baseDecimals: number;
  quoteDecimals: number;
}

interface PersistedRaydiumPoolSnapshot extends PersistedBasePoolSnapshot {
  type: 'raydium';
  marketId: string;
  state: string;
}

interface PersistedPumpFunPoolSnapshot extends PersistedBasePoolSnapshot {
  type: 'pumpfun';
  state: {
    baseVault: string;
    quoteVault: string;
    bondingCurve: string;
    associatedBondingCurve: string;
    globalAccount: string;
    feeAccount: string;
  };
}

const POOL_DB_FILENAME = 'pools.json';

const DEFAULT_MAX_SOLD_HISTORY = 1_000;

export class PoolCache {
  private readonly keys: Map<string, PoolSnapshot> = new Map<string, PoolSnapshot>();
  private readonly persisted: Map<string, PersistedPoolSnapshot> = new Map<string, PersistedPoolSnapshot>();
  private readonly soldMints: Set<string> = new Set<string>();
  private readonly soldMintOrder: string[] = [];
  private readonly dbPath: string;
  private readonly maxSoldHistory: number;
  private initialized = false;

  constructor(
    dbPath: string = path.join(__dirname, '..', 'storage', POOL_DB_FILENAME),
    maxSoldHistory: number = DEFAULT_MAX_SOLD_HISTORY,
  ) {
    this.dbPath = dbPath;
    this.maxSoldHistory = maxSoldHistory > 0 ? Math.floor(maxSoldHistory) : DEFAULT_MAX_SOLD_HISTORY;
  }

  public async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const persistedSnapshots = await this.readFromDisk();
    let shouldPersist = false;

    for (const persisted of persistedSnapshots) {
      const snapshot = this.deserialize(persisted);
      if (!snapshot) {
        shouldPersist = true;
        continue;
      }

      const mint = snapshot.baseMint.toBase58();

      if (snapshot.sold) {
        this.rememberSoldMint(mint);
        shouldPersist = true;
        continue;
      }

      this.keys.set(mint, snapshot);
      this.persisted.set(mint, persisted);
    }

    if (persistedSnapshots.length > 0) {
      logger.info(`Loaded ${persistedSnapshots.length} pools from local storage`);
    }

    if (shouldPersist) {
      await this.persist();
    }

    this.initialized = true;
  }

  public async save(snapshot: PoolSnapshot, rawState?: Buffer): Promise<void> {
    const mint = snapshot.baseMint.toBase58();
    if (!this.keys.has(mint)) {
      logger.trace(`Caching new pool for mint: ${mint}`);
    }

    this.keys.set(mint, snapshot);
    this.persisted.set(mint, this.serialize(snapshot, rawState));
    this.forgetSoldMint(mint);
    await this.persist();
  }

  public async get(mint: string): Promise<PoolSnapshot | undefined> {
    return this.keys.get(mint);
  }

  public getUnsold(): PoolSnapshot[] {
    return Array.from(this.keys.values()).filter((snapshot) => !snapshot.sold);
  }

  public async markAsSold(mint: string): Promise<void> {
    const pool = this.keys.get(mint);
    let changed = false;

    if (pool) {
      this.keys.delete(mint);
      changed = true;
    }

    if (this.persisted.delete(mint)) {
      changed = true;
    }

    this.rememberSoldMint(mint);

    if (changed) {
      await this.persist();
    }
  }

  public async remove(mint: string): Promise<void> {
    this.keys.delete(mint);
    this.persisted.delete(mint);
    this.rememberSoldMint(mint);
    await this.persist();
  }

  public wasSold(mint: string): boolean {
    return this.soldMints.has(mint);
  }

  private serialize(snapshot: PoolSnapshot, rawState?: Buffer): PersistedPoolSnapshot {
    if (isRaydiumPool(snapshot)) {
      const encodedState = rawState ?? this.encodeRaydiumState(snapshot.state);
      return {
        type: 'raydium',
        id: snapshot.id,
        sold: snapshot.sold,
        baseMint: snapshot.baseMint.toBase58(),
        quoteMint: snapshot.quoteMint.toBase58(),
        baseDecimals: snapshot.baseDecimals,
        quoteDecimals: snapshot.quoteDecimals,
        marketId: snapshot.marketId.toBase58(),
        state: encodedState.toString('base64'),
      };
    }

    return {
      type: 'pumpfun',
      id: snapshot.id,
      sold: snapshot.sold,
      baseMint: snapshot.baseMint.toBase58(),
      quoteMint: snapshot.quoteMint.toBase58(),
      baseDecimals: snapshot.baseDecimals,
      quoteDecimals: snapshot.quoteDecimals,
      state: {
        baseVault: snapshot.state.baseVault.toBase58(),
        quoteVault: snapshot.state.quoteVault.toBase58(),
        bondingCurve: snapshot.state.bondingCurve.toBase58(),
        associatedBondingCurve: snapshot.state.associatedBondingCurve.toBase58(),
        globalAccount: snapshot.state.globalAccount.toBase58(),
        feeAccount: snapshot.state.feeAccount.toBase58(),
      },
    };
  }

  private deserialize(persisted: PersistedPoolSnapshot): PoolSnapshot | undefined {
    try {
      if (persisted.type === 'raydium') {
        const stateBuffer = Buffer.from(persisted.state, 'base64');
        const state = LIQUIDITY_STATE_LAYOUT_V4.decode(stateBuffer) as LiquidityStateV4;

        return {
          id: persisted.id,
          sold: persisted.sold,
          type: 'raydium',
          baseMint: new PublicKey(persisted.baseMint),
          quoteMint: new PublicKey(persisted.quoteMint),
          baseDecimals: persisted.baseDecimals,
          quoteDecimals: persisted.quoteDecimals,
          marketId: new PublicKey(persisted.marketId),
          state,
        };
      }

      const pumpfunState: PumpFunPoolState = {
        baseMint: new PublicKey(persisted.baseMint),
        quoteMint: new PublicKey(persisted.quoteMint),
        baseDecimals: persisted.baseDecimals,
        quoteDecimals: persisted.quoteDecimals,
        baseVault: new PublicKey(persisted.state.baseVault),
        quoteVault: new PublicKey(persisted.state.quoteVault),
        bondingCurve: new PublicKey(persisted.state.bondingCurve),
        associatedBondingCurve: new PublicKey(persisted.state.associatedBondingCurve),
        globalAccount: new PublicKey(persisted.state.globalAccount),
        feeAccount: new PublicKey(persisted.state.feeAccount),
      };

      return {
        id: persisted.id,
        sold: persisted.sold,
        type: 'pumpfun',
        baseMint: pumpfunState.baseMint,
        quoteMint: pumpfunState.quoteMint,
        baseDecimals: pumpfunState.baseDecimals,
        quoteDecimals: pumpfunState.quoteDecimals,
        state: pumpfunState,
      };
    } catch (error) {
      logger.error({ error }, 'Failed to deserialize persisted pool snapshot');
      return undefined;
    }
  }

  private async persist(): Promise<void> {
    await this.ensureDirectory();

    const data = Array.from(this.persisted.values());

    await fs.writeFile(this.dbPath, JSON.stringify(data, null, 2), 'utf8');
  }

  private async readFromDisk(): Promise<PersistedPoolSnapshot[]> {
    try {
      const data = await fs.readFile(this.dbPath, 'utf8');
      return JSON.parse(data) as PersistedPoolSnapshot[];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }

      logger.error({ error }, 'Failed to read pool cache from disk');
      return [];
    }
  }

  private async ensureDirectory(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    await fs.mkdir(dir, { recursive: true });
  }

  private encodeRaydiumState(state: LiquidityStateV4): Buffer {
    const buffer = Buffer.alloc(LIQUIDITY_STATE_LAYOUT_V4.span);
    LIQUIDITY_STATE_LAYOUT_V4.encode(state, buffer);
    return buffer;
  }

  private rememberSoldMint(mint: string): void {
    if (this.soldMints.has(mint)) {
      return;
    }

    this.soldMints.add(mint);
    this.soldMintOrder.push(mint);

    if (this.soldMintOrder.length > this.maxSoldHistory) {
      const oldest = this.soldMintOrder.shift();
      if (oldest) {
        this.soldMints.delete(oldest);
      }
    }
  }

  private forgetSoldMint(mint: string): void {
    if (!this.soldMints.has(mint)) {
      return;
    }

    this.soldMints.delete(mint);
    const index = this.soldMintOrder.indexOf(mint);
    if (index >= 0) {
      this.soldMintOrder.splice(index, 1);
    }
  }
}
