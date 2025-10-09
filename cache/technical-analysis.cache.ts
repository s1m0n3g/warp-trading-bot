import { Liquidity, LiquidityPoolKeysV4 } from '@raydium-io/raydium-sdk';
import { COMMITMENT_LEVEL, RPC_ENDPOINT, logger } from '../helpers';
import { Connection } from '@solana/web3.js';

export class TechnicalAnalysisCache_Entity {
  constructor(process, poolKeys, prices) {
    this.process = process;
    this.poolKeys = poolKeys;
    this.prices = prices;

    this.done = false;
    this.extendExpiryTime();
  }

  extendExpiryTime(){
    this.expiryTime = new Date(new Date().getTime() + 5 * 60 * 1000); //5 mins
  }

  process: NodeJS.Timeout;
  expiryTime: Date;
  poolKeys: LiquidityPoolKeysV4;
  done: boolean;
  prices: {
    value: number,
    date: Date
  }[];
}

const MAX_PRICE_POINTS = 1200; // keep roughly ten minutes of data at the 500 ms polling cadence

export class TechnicalAnalysisCache {
  private readonly data: Map<string, TechnicalAnalysisCache_Entity> = new Map<string, TechnicalAnalysisCache_Entity>();
  private readonly connection: Connection;

  constructor() {
    // Reuse a single RPC connection for all TA watchers to avoid
    // spawning one connection per token (which leaks memory and sockets).
    this.connection = new Connection(RPC_ENDPOINT, {
      commitment: COMMITMENT_LEVEL,
    });

    setInterval(() => {
      this.data.forEach((cached, key) => {
        if (cached.done || cached.expiryTime < new Date()) {
          logger.trace(`Technical analysis watcher for mint: ${key} expired`);
          clearInterval(cached.process);
          this.data.delete(key);
        }
      });
    }, 30 * 1000);
  }


  public addNew(mint: string, poolKeys: LiquidityPoolKeysV4) {
    if (this.data.has(mint)) {
      return; //already exists
    }

    logger.trace(`Adding new technical analysis watcher for mint: ${mint}`);

    let process = this.startWatcher(mint);
    this.set(mint, new TechnicalAnalysisCache_Entity(process, poolKeys, []));
  }

  public getPrices(mint: string): number[] {
    if (!this.data.has(mint)) {
      return null;
    }

    let cached = this.data.get(mint);
    cached.extendExpiryTime();
    this.set(mint, cached);
    return cached.prices.map((p) => p.value);
  }

  public async markAsDone(mint: string) {
    const cached = this.data.get(mint);
    if (cached) {

      logger.trace(`Marking technical analysis watcher for mint: ${mint} as done`);
      cached.done = true;
      this.set(mint, cached);
    }
  }

  private set(mint: string, entity: TechnicalAnalysisCache_Entity) {
    // nu afdrug
    this.data.set(mint, entity);
  }
  
  private startWatcher(mint: string): NodeJS.Timeout {
    return setInterval(async () => {
      try {

        if (!this.data.has(mint)) {
          return; //doesnt exist
        }

        let currentTime = new Date();
        let cached = this.data.get(mint);

        if (cached.done) {
          clearInterval(cached.process);
          this.data.delete(mint);
          return;
        }

        let poolInfo = await Liquidity.fetchInfo({
          connection: this.connection,
          poolKeys: cached.poolKeys
        });

        let tokenPriceBN = Liquidity.getRate(poolInfo);

        if (cached.prices.length === 0 || parseFloat(tokenPriceBN.toFixed(16)) !== cached.prices[cached.prices.length - 1].value) {
          cached.prices.push({ value: parseFloat(tokenPriceBN.toFixed(16)), date: currentTime });

          if (cached.prices.length > MAX_PRICE_POINTS) {
            cached.prices.splice(0, cached.prices.length - MAX_PRICE_POINTS);
          }
        }

        this.set(mint, cached);
      } catch (e) {
        logger.error({ error: e }, `Technical analysis watcher for mint: ${mint} failed`);
      }
    }, 500);
  }

}
