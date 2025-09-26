import { LiquidityStateV4 } from '@raydium-io/raydium-sdk';
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
    return this.keys.get(mint);
  }

  public async markAsSold(mint: string) {
    //important, so we don't try to sell the same pool twice
    const pool = this.keys.get(mint);
    if (pool) {
      pool.sold = true;
      this.keys.set(mint, pool);
    }
  }
}
