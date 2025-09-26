import { LiquidityStateV4 } from '@raydium-io/raydium-sdk';
import { PublicKey } from '@solana/web3.js';
import { logger } from '../helpers';
import { PumpFunBondingCurveState, PumpFunCachedPoolItem } from '../transactions';

export type CachedPoolItem =
  | { id: string; type: 'raydium'; state: LiquidityStateV4; sold: boolean }
  | PumpFunCachedPoolItem;

export class PoolCache {
  private readonly keys: Map<string, CachedPoolItem> = new Map();

  public save(id: string, state: LiquidityStateV4, type?: 'raydium'): void;
  public save(id: string, state: PumpFunBondingCurveState, type: 'pumpfun'): void;
  public save(
    id: string,
    state: LiquidityStateV4 | PumpFunBondingCurveState,
    type: 'raydium' | 'pumpfun' = 'raydium',
  ) {
    const mint =
      type === 'raydium'
        ? (state as LiquidityStateV4).baseMint.toString()
        : (state as PumpFunBondingCurveState).mint.toString();

    if (!this.keys.has(mint)) {
      logger.trace(`Caching new pool for mint: ${mint}`);

      if (type === 'raydium') {
        this.keys.set(mint, { id, state: state as LiquidityStateV4, sold: false, type });
      } else {
        this.keys.set(mint, { id, state: state as PumpFunBondingCurveState, sold: false, type });
      }
    }
  }

  public async get(mint: string): Promise<CachedPoolItem | undefined> {

import { PumpFunPoolState } from '../helpers/pumpfun/types';

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

export class PoolCache {
  private readonly keys: Map<string, PoolSnapshot> = new Map<string, PoolSnapshot>();

  public save(snapshot: PoolSnapshot) {
    const mint = snapshot.baseMint.toBase58();
    if (!this.keys.has(mint)) {
      logger.trace(`Caching new pool for mint: ${mint}`);
      this.keys.set(mint, snapshot);
    }
  }

  public async get(mint: string): Promise<PoolSnapshot | undefined> {
    return this.keys.get(mint);
  }

  public async markAsSold(mint: string) {
    // important, so we don't try to sell the same pool twice
    const pool = this.keys.get(mint);
    if (pool) {
      this.keys.set(mint, { ...pool, sold: true });
    }
  }
}
