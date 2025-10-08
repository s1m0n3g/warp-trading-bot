import { Connection, PublicKey } from '@solana/web3.js';
import { getMinimalMarketV3, logger, sleep, MINIMAL_MARKET_STATE_LAYOUT_V3, MinimalMarketLayoutV3 } from '../helpers';
import { MAINNET_PROGRAM_ID, MARKET_STATE_LAYOUT_V3, Token } from '@raydium-io/raydium-sdk';

export class MarketCache {
  private readonly keys: Map<string, MinimalMarketLayoutV3> = new Map<string, MinimalMarketLayoutV3>();
  constructor(private readonly connection: Connection, private readonly maxEntries?: number) {}

  async init(config: { quoteToken: Token }) {
    logger.debug({}, `Fetching all existing ${config.quoteToken.symbol} markets...`);

    const accounts = await this.connection.getProgramAccounts(MAINNET_PROGRAM_ID.OPENBOOK_MARKET, {
      commitment: this.connection.commitment,
      dataSlice: {
        offset: MARKET_STATE_LAYOUT_V3.offsetOf('eventQueue'),
        length: MINIMAL_MARKET_STATE_LAYOUT_V3.span,
      },
      filters: [
        { dataSize: MARKET_STATE_LAYOUT_V3.span },
        {
          memcmp: {
            offset: MARKET_STATE_LAYOUT_V3.offsetOf('quoteMint'),
            bytes: config.quoteToken.mint.toBase58(),
          },
        },
      ],
    });

    for (const account of accounts) {
      const market = MINIMAL_MARKET_STATE_LAYOUT_V3.decode(account.account.data);
      this.keys.set(account.pubkey.toString(), market);
      this.enforceSizeLimit();
    }

    logger.debug({}, `Cached ${this.keys.size} markets`);
  }

  public save(marketId: string, keys: MinimalMarketLayoutV3) {
    if (!this.keys.has(marketId)) {
      logger.trace({}, `Caching new market: ${marketId}`);
      this.keys.set(marketId, keys);
      this.enforceSizeLimit();
    }
  }

  public async get(marketId: string): Promise<MinimalMarketLayoutV3> {
    if (this.keys.has(marketId)) {
      return this.keys.get(marketId)!;
    }

    logger.trace(`Fetching new market keys for ${marketId}`);
  
    let attempts = 0;
    const maxRetries = 5;
  
    while (attempts < maxRetries) {
      try {
        const market = await this.fetch(marketId);
        this.keys.set(marketId, market);
        this.enforceSizeLimit();
        return market;
      } catch (error) {
        attempts++;
        if (attempts >= maxRetries) {
          logger.error(`Failed to fetch market keys for ${marketId} after ${maxRetries} attempts`);
          throw error;
        }
        logger.warn(`Attempt ${attempts} to fetch market keys for ${marketId} failed. Retrying...`);
        await sleep(100);
      }
    }
    throw new Error(`Failed to fetch market keys for ${marketId}`);
  } 
  
  private fetch(marketId: string): Promise<MinimalMarketLayoutV3> {
    return getMinimalMarketV3(this.connection, new PublicKey(marketId), this.connection.commitment);
  }

  private enforceSizeLimit() {
    if (!this.maxEntries || this.maxEntries <= 0) {
      return;
    }

    while (this.keys.size > this.maxEntries) {
      const oldestKey = this.keys.keys().next().value as string | undefined;

      if (!oldestKey) {
        break;
      }

      this.keys.delete(oldestKey);
      logger.debug(
        { marketId: oldestKey, limit: this.maxEntries },
        'Evicted market from cache to respect MARKET_CACHE_MAX_ENTRIES',
      );
    }
  }
}
