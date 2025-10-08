import BN from 'bn.js';
import { MarketCache, PoolCache, createRaydiumPoolSnapshot } from './cache';
import { Listeners } from './listeners';
import { Connection, KeyedAccountInfo, Keypair } from '@solana/web3.js';
import {
  LIQUIDITY_STATE_LAYOUT_V4,
  MARKET_STATE_LAYOUT_V3,
  LiquidityStateV4,
  Token,
  TokenAmount,
} from '@raydium-io/raydium-sdk';
import { AccountLayout, RawAccount, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Bot, BotConfig } from './bot';
import { DefaultTransactionExecutor, TransactionExecutor } from './transactions';
import {
  getToken,
  getWallet,
  logger,
  COMMITMENT_LEVEL,
  RPC_ENDPOINT,
  RPC_WEBSOCKET_ENDPOINT,
  PRE_LOAD_EXISTING_MARKETS,
  LOG_LEVEL,
  QUOTE_MINT,
  MAX_POOL_SIZE,
  MIN_POOL_SIZE,
  QUOTE_AMOUNT,
  PRIVATE_KEY,
  USE_SNIPE_LIST,
  AUTO_SELL_DELAY,
  MAX_SELL_RETRIES,
  AUTO_SELL,
  MAX_BUY_RETRIES,
  AUTO_BUY_DELAY,
  COMPUTE_UNIT_LIMIT,
  COMPUTE_UNIT_PRICE,
  CACHE_NEW_MARKETS,
  TAKE_PROFIT,
  STOP_LOSS,
  BUY_SLIPPAGE,
  SELL_SLIPPAGE,
  PRICE_CHECK_DURATION,
  PRICE_CHECK_INTERVAL,
  SNIPE_LIST_REFRESH_INTERVAL,
  TRANSACTION_EXECUTOR,
  CUSTOM_FEE,
  FILTER_CHECK_INTERVAL,
  FILTER_CHECK_DURATION,
  CONSECUTIVE_FILTER_MATCHES,
  MAX_TOKENS_AT_THE_TIME,
  CHECK_IF_MINT_IS_RENOUNCED,
  CHECK_IF_FREEZABLE,
  CHECK_IF_BURNED,
  CHECK_IF_MUTABLE,
  CHECK_IF_SOCIALS,
  TRAILING_STOP_LOSS,
  SKIP_SELLING_IF_LOST_MORE_THAN,
  MAX_LAG,
  MAX_PRE_SWAP_VOLUME_IN_QUOTE,
  MAX_PRE_SWAP_VOLUME_RAW,
  CHECK_HOLDERS,
  CHECK_ABNORMAL_DISTRIBUTION,
  CHECK_TOKEN_DISTRIBUTION,
  TELEGRAM_CHAT_ID,
  BLACKLIST_REFRESH_INTERVAL,
  MACD_SHORT_PERIOD,
  MACD_LONG_PERIOD,
  MACD_SIGNAL_PERIOD,
  RSI_PERIOD,
  TELEGRAM_BOT_TOKEN,
  AUTO_SELL_WITHOUT_SELL_SIGNAL,
  BUY_SIGNAL_TIME_TO_WAIT,
  BUY_SIGNAL_PRICE_INTERVAL,
  BUY_SIGNAL_FRACTION_TIME_TO_WAIT,
  BUY_SIGNAL_LOW_VOLUME_THRESHOLD,
  USE_TELEGRAM,
  USE_TA,
  ENABLE_PUMPFUN,
  PUMPFUN_MAX_TOKENS_AT_THE_TIME,
  PUMPFUN_TAKE_PROFIT,
  DEFAULT_PUMPFUN_TAKE_PROFIT,
  MARKET_CACHE_MAX_ENTRIES,
} from './helpers';
import type { PumpfunPoolEventPayload } from './helpers';
import { WarpTransactionExecutor } from './transactions/warp-transaction-executor';
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';
import { TechnicalAnalysisCache } from './cache/technical-analysis.cache';

const connection = new Connection(RPC_ENDPOINT, {
  wsEndpoint: RPC_WEBSOCKET_ENDPOINT,
  commitment: COMMITMENT_LEVEL,
});

type ResolvedMaxPreSwapVolume = {
  raw: BN;
  display: string;
};

class BoundedStringSet {
  private readonly items = new Set<string>();
  private readonly order: string[] = [];

  constructor(private readonly maxSize: number) {}

  has(value: string): boolean {
    return this.items.has(value);
  }

  add(value: string): void {
    if (this.items.has(value)) {
      return;
    }

    this.items.add(value);

    if (!Number.isFinite(this.maxSize) || this.maxSize <= 0) {
      return;
    }

    this.order.push(value);

    if (this.order.length <= this.maxSize) {
      return;
    }

    const oldest = this.order.shift();

    if (oldest !== undefined) {
      this.items.delete(oldest);
    }
  }
}

const DEFAULT_MAX_MARKET_CACHE_ENTRIES = 5_000;
const DEFAULT_MAX_SEEN_RAYDIUM_MINTS = 5_000;
const DEFAULT_MAX_SEEN_PUMPFUN_MINTS = 20_000;

const resolvedMarketCacheMaxEntries =
  MARKET_CACHE_MAX_ENTRIES === undefined ? DEFAULT_MAX_MARKET_CACHE_ENTRIES : MARKET_CACHE_MAX_ENTRIES;

const MAX_SEEN_RAYDIUM_MINTS =
  resolvedMarketCacheMaxEntries > 0
    ? Math.max(resolvedMarketCacheMaxEntries, DEFAULT_MAX_SEEN_RAYDIUM_MINTS)
    : DEFAULT_MAX_SEEN_RAYDIUM_MINTS;

const MAX_SEEN_PUMPFUN_MINTS = Math.max(
  DEFAULT_MAX_SEEN_PUMPFUN_MINTS,
  MAX_SEEN_RAYDIUM_MINTS * 2,
);

function resolveMaxPreSwapVolume(quoteToken: Token): ResolvedMaxPreSwapVolume {
  const quoteThreshold = MAX_PRE_SWAP_VOLUME_IN_QUOTE?.trim();
  const rawThreshold = MAX_PRE_SWAP_VOLUME_RAW?.trim();

  if (quoteThreshold && rawThreshold) {
    logger.warn(
      'Both MAX_PRE_SWAP_VOLUME_IN_QUOTE and MAX_PRE_SWAP_VOLUME are set; using the quote-denominated value.',
    );
  }

  if (quoteThreshold) {
    const amount = new TokenAmount(quoteToken, quoteThreshold, false);

    return {
      raw: amount.raw,
      display: `${quoteThreshold} ${quoteToken.symbol} (${amount.raw.toString()} raw units)`,
    };
  }

  if (rawThreshold) {
    if (rawThreshold.startsWith('-')) {
      logger.warn('MAX_PRE_SWAP_VOLUME cannot be negative; defaulting to zero');
    } else if (/^\d+$/.test(rawThreshold)) {
      const rawValue = new BN(rawThreshold);
      const approx = new TokenAmount(quoteToken, rawValue, true);

      return {
        raw: rawValue,
        display: `${rawValue.toString()} raw units (~${approx.toFixed()} ${quoteToken.symbol})`,
      };
    } else {
      try {
        const amount = new TokenAmount(quoteToken, rawThreshold, false);
        logger.warn(
          `MAX_PRE_SWAP_VOLUME should be an integer raw amount. Interpreting "${rawThreshold}" as ${quoteToken.symbol}.`,
        );

        return {
          raw: amount.raw,
          display: `${rawThreshold} ${quoteToken.symbol} (${amount.raw.toString()} raw units)`,
        };
      } catch (error) {
        logger.error({ err: error, rawThreshold }, 'Invalid MAX_PRE_SWAP_VOLUME value; defaulting to zero');
      }
    }
  }

  const zero = new BN(0);
  const approx = new TokenAmount(quoteToken, zero, true);

  return {
    raw: zero,
    display: `${zero.toString()} raw units (~${approx.toFixed()} ${quoteToken.symbol})`,
  };
}

function printDetails(
  wallet: Keypair,
  quoteToken: Token,
  bot: Bot,
  maxPreSwapVolume: ResolvedMaxPreSwapVolume,
) {
  logger.info(`  
                                        ..   :-===++++-     
                                .-==+++++++- =+++++++++-    
            ..:::--===+=.=:     .+++++++++++:=+++++++++:    
    .==+++++++++++++++=:+++:    .+++++++++++.=++++++++-.    
    .-+++++++++++++++=:=++++-   .+++++++++=:.=+++++-::-.    
     -:+++++++++++++=:+++++++-  .++++++++-:- =+++++=-:      
      -:++++++=++++=:++++=++++= .++++++++++- =+++++:        
       -:++++-:=++=:++++=:-+++++:+++++====--:::::::.        
        ::=+-:::==:=+++=::-:--::::::::::---------::.        
         ::-:  .::::::::.  --------:::..                    
          :-    .:.-:::.                                    

          WARP DRIVE ACTIVATED 🚀🐟
          Made with ❤️ by humans.
  `);

  const botConfig = bot.config;

  logger.info('------- CONFIGURATION START -------');
  logger.info(`Wallet: ${wallet.publicKey.toString()}`);

  logger.info('- Bot -');
  logger.info(`Using transaction executor: ${TRANSACTION_EXECUTOR}`);

  if (bot.isWarp || bot.isJito) {
    logger.info(`${TRANSACTION_EXECUTOR} fee: ${CUSTOM_FEE ?? 'not configured'}`);
  } else {
    logger.info(`Compute Unit limit: ${botConfig.unitLimit}`);
    logger.info(`Compute Unit price (micro lamports): ${botConfig.unitPrice}`);
  }

  logger.info(`Max tokens at the time: ${botConfig.maxTokensAtTheTime}`);
  logger.info(`Pre load existing markets: ${PRE_LOAD_EXISTING_MARKETS}`);
  logger.info(`Cache new markets: ${CACHE_NEW_MARKETS}`);
  logger.info(`Market cache max entries: ${MARKET_CACHE_MAX_ENTRIES ?? 'unlimited'}`);
  logger.info(`Raydium mint deduplication limit: ${MAX_SEEN_RAYDIUM_MINTS}`);
  logger.info(`pump.fun mint deduplication limit: ${MAX_SEEN_PUMPFUN_MINTS}`);
  logger.info(`Log level: ${LOG_LEVEL}`);
  logger.info(`Max lag: ${MAX_LAG}`);
  logger.info(`Max pre swap volume: ${maxPreSwapVolume.display}`);
  logger.info(`Pump.fun listener enabled: ${botConfig.enablePumpfun}`);
  logger.info(`Telegram notifications: ${botConfig.useTelegram}`);

  if (botConfig.enablePumpfun) {
    logger.info(
      `Pump.fun aggressive scalp overrides -> max tokens at once: ${botConfig.maxTokensAtTheTime}, take profit: ${botConfig.takeProfit}%`,
    );
  }

  if (botConfig.useTelegram) {
    logger.info(`Telegram chat id: ${botConfig.telegramChatId}`);
  }

  logger.info('- Buy -');
  logger.info(`Buy amount: ${botConfig.quoteAmount.toFixed()} ${botConfig.quoteToken.name}`);
  logger.info(`Auto buy delay: ${botConfig.autoBuyDelay} ms`);
  logger.info(`Max buy retries: ${botConfig.maxBuyRetries}`);
  logger.info(`Buy amount (${quoteToken.symbol}): ${botConfig.quoteAmount.toFixed()}`);
  logger.info(`Buy slippage: ${botConfig.buySlippage}%`);

  logger.info('- Sell -');
  logger.info(`Auto sell: ${AUTO_SELL}`);
  logger.info(`Auto sell delay: ${botConfig.autoSellDelay} ms`);
  logger.info(`Max sell retries: ${botConfig.maxSellRetries}`);
  logger.info(`Sell slippage: ${botConfig.sellSlippage}%`);
  logger.info(`Price check interval (PRICE_CHECK_INTERVAL): ${botConfig.priceCheckInterval} ms`);
  logger.info(`Price check duration (PRICE_CHECK_DURATION): ${botConfig.priceCheckDuration} ms`);
  logger.info(`Take profit: ${botConfig.takeProfit}%`);
  logger.info(`Stop loss: ${botConfig.stopLoss}%`);
  logger.info(`Trailing stop loss: ${botConfig.trailingStopLoss}`);
  logger.info(`Skip selling if lost more than: ${botConfig.skipSellingIfLostMoreThan}%`);

  logger.info('- Snipe list -');
  logger.info(`Snipe list: ${botConfig.useSnipeList}`);
  logger.info(`Snipe list refresh interval: ${SNIPE_LIST_REFRESH_INTERVAL} ms`);

  if (botConfig.useSnipeList) {
    logger.info('- Filters -');
    logger.info(`Filters are disabled when snipe list is on`);
  } else {
    logger.info('- Filters -');
    logger.info(`Filter check interval: ${botConfig.filterCheckInterval} ms`);
    logger.info(`Filter check duration: ${botConfig.filterCheckDuration} ms`);
    logger.info(`Consecutive filter matches: ${botConfig.consecutiveMatchCount}`);
    logger.info(`Check renounced: ${CHECK_IF_MINT_IS_RENOUNCED}`);
    logger.info(`Check freezable: ${CHECK_IF_FREEZABLE}`);
    logger.info(`Check burned: ${CHECK_IF_BURNED}`);
    logger.info(`Check mutable: ${CHECK_IF_MUTABLE}`);
    logger.info(`Check socials: ${CHECK_IF_SOCIALS}`);
    logger.info(`Min pool size: ${botConfig.minPoolSize.toFixed()}`);
    logger.info(`Max pool size: ${botConfig.maxPoolSize.toFixed()}`);
  }

  logger.info(`Check Holders: ${botConfig.checkHolders}`);    
  logger.info(`Check Token Distribution: ${botConfig.checkTokenDistribution}`);
  logger.info(`Check Abnormal Distribution: ${botConfig.checkAbnormalDistribution}`);
  logger.info(`Blacklist refresh interval: ${BLACKLIST_REFRESH_INTERVAL}`);

  logger.info(`Technical analysis enabled: ${botConfig.useTechnicalAnalysis}`);

  if (botConfig.useTechnicalAnalysis) {
    logger.info(`Buy signal MACD: ${botConfig.MACDShortPeriod}/${botConfig.MACDLongPeriod}/${botConfig.MACDSignalPeriod}`);
    logger.info(`Buy signal RSI: ${botConfig.RSIPeriod}`);
  }
  
  logger.info('------- CONFIGURATION END -------');

  logger.info('Bot is running! Press CTRL + C to stop it.');
}

const runListener = async () => {
  logger.level = LOG_LEVEL;
  logger.info('Bot is starting...');

  const marketCache = new MarketCache(connection, resolvedMarketCacheMaxEntries);
  const poolCache = new PoolCache();
  await poolCache.init();
  const technicalAnalysisCache = new TechnicalAnalysisCache();

  const customFee = CUSTOM_FEE;
  const requiresCustomFee = TRANSACTION_EXECUTOR === 'warp' || TRANSACTION_EXECUTOR === 'jito';

  if (requiresCustomFee && !customFee) {
    logger.error(`CUSTOM_FEE must be set when using the ${TRANSACTION_EXECUTOR} transaction executor.`);
    process.exit(1);
  }

  let txExecutor: TransactionExecutor;

  switch (TRANSACTION_EXECUTOR) {
    case 'warp': {
      txExecutor = new WarpTransactionExecutor(customFee!);
      break;
    }
    case 'jito': {
      txExecutor = new JitoTransactionExecutor(customFee!, connection);
      break;
    }
    default: {
      txExecutor = new DefaultTransactionExecutor(connection);
      break;
    }
  }

  const wallet = getWallet(PRIVATE_KEY.trim());
  const quoteToken = getToken(QUOTE_MINT);
  const pumpfunMaxTokensOverride =
    PUMPFUN_MAX_TOKENS_AT_THE_TIME !== undefined
      ? Math.max(Math.floor(PUMPFUN_MAX_TOKENS_AT_THE_TIME), 1)
      : undefined;
  const resolvedMaxTokensAtTheTime = ENABLE_PUMPFUN
    ? pumpfunMaxTokensOverride ?? Math.max(MAX_TOKENS_AT_THE_TIME, 5)
    : MAX_TOKENS_AT_THE_TIME;
  const resolvedTakeProfit = ENABLE_PUMPFUN
    ? PUMPFUN_TAKE_PROFIT ?? DEFAULT_PUMPFUN_TAKE_PROFIT
    : TAKE_PROFIT;

  const botConfig = <BotConfig>{
    wallet,
    quoteAta: getAssociatedTokenAddressSync(quoteToken.mint, wallet.publicKey),
    minPoolSize: new TokenAmount(quoteToken, MIN_POOL_SIZE, false),
    maxPoolSize: new TokenAmount(quoteToken, MAX_POOL_SIZE, false),
    quoteToken,
    quoteAmount: new TokenAmount(quoteToken, QUOTE_AMOUNT, false),
    maxTokensAtTheTime: resolvedMaxTokensAtTheTime,
    useSnipeList: USE_SNIPE_LIST,
    autoSell: AUTO_SELL,
    autoSellDelay: AUTO_SELL_DELAY,
    maxSellRetries: MAX_SELL_RETRIES,
    autoBuyDelay: AUTO_BUY_DELAY,
    maxBuyRetries: MAX_BUY_RETRIES,
    unitLimit: COMPUTE_UNIT_LIMIT,
    unitPrice: COMPUTE_UNIT_PRICE,
    takeProfit: resolvedTakeProfit,
    stopLoss: STOP_LOSS,
    trailingStopLoss: TRAILING_STOP_LOSS,
    skipSellingIfLostMoreThan: SKIP_SELLING_IF_LOST_MORE_THAN,
    buySlippage: BUY_SLIPPAGE,
    sellSlippage: SELL_SLIPPAGE,
    priceCheckInterval: PRICE_CHECK_INTERVAL,
    priceCheckDuration: PRICE_CHECK_DURATION,
    filterCheckInterval: FILTER_CHECK_INTERVAL,
    filterCheckDuration: FILTER_CHECK_DURATION,
    consecutiveMatchCount: CONSECUTIVE_FILTER_MATCHES,
    checkHolders:CHECK_HOLDERS,
    checkTokenDistribution:CHECK_TOKEN_DISTRIBUTION,
    checkAbnormalDistribution:CHECK_ABNORMAL_DISTRIBUTION,
    telegramChatId:TELEGRAM_CHAT_ID,
    telegramBotToken: TELEGRAM_BOT_TOKEN,
    blacklistRefreshInterval: BLACKLIST_REFRESH_INTERVAL,
    MACDLongPeriod: MACD_LONG_PERIOD,
    MACDShortPeriod: MACD_SHORT_PERIOD,
    MACDSignalPeriod: MACD_SIGNAL_PERIOD,
    RSIPeriod: RSI_PERIOD,
    autoSellWithoutSellSignal: AUTO_SELL_WITHOUT_SELL_SIGNAL,
    buySignalTimeToWait: BUY_SIGNAL_TIME_TO_WAIT,
    buySignalPriceInterval: BUY_SIGNAL_PRICE_INTERVAL,
    buySignalFractionPercentageTimeToWait: BUY_SIGNAL_FRACTION_TIME_TO_WAIT,
    buySignalLowVolumeThreshold: BUY_SIGNAL_LOW_VOLUME_THRESHOLD,
    useTelegram: USE_TELEGRAM,
    useTechnicalAnalysis: USE_TA,
    enablePumpfun: ENABLE_PUMPFUN,
  };

  const bot = new Bot(connection, marketCache, poolCache, txExecutor, technicalAnalysisCache, botConfig);
  const valid = await bot.validate();

  if (!valid) {
    logger.info('Bot is exiting...');
    process.exit(1);
  }

  if (PRE_LOAD_EXISTING_MARKETS) {
    await marketCache.init({ quoteToken });
  }

  const runTimestamp = BigInt(Math.floor(new Date().getTime() / 1000));
  const listeners = new Listeners(connection);
  await listeners.start({
    walletPublicKey: wallet.publicKey,
    quoteToken,
    autoSell: AUTO_SELL,
    cacheNewMarkets: CACHE_NEW_MARKETS,
    enablePumpfun: ENABLE_PUMPFUN,
  });

  if (AUTO_SELL) {
    try {
      const { value: existingTokenAccounts } = await connection.getTokenAccountsByOwner(wallet.publicKey, {
        programId: TOKEN_PROGRAM_ID,
      });

      const walletMints = new Set<string>();

      for (const { pubkey, account } of existingTokenAccounts) {
        const accountData = AccountLayout.decode(account.data) as RawAccount;
        const mint = accountData.mint.toString();

        if (accountData.mint.equals(quoteToken.mint)) {
          continue;
        }

        const balance = BigInt(accountData.amount.toString());
        if (balance === 0n) {
          continue;
        }

        walletMints.add(mint);

        const cachedPool = await poolCache.get(mint);

        if (!cachedPool) {
          logger.trace({ mint }, 'Skipping resume for token without cached pool data');
          continue;
        }

        if (cachedPool.sold) {
          logger.trace({ mint }, 'Skipping resume for token already marked as sold');
          continue;
        }

        logger.info({ mint, account: pubkey.toBase58() }, 'Resuming sell monitoring for existing position');
        void bot.sell(pubkey, accountData);
      }

      for (const snapshot of poolCache.getUnsold()) {
        const mint = snapshot.baseMint.toBase58();
        if (walletMints.has(mint)) {
          continue;
        }

        logger.debug({ mint }, 'Removing cached position because wallet token account is missing');
        await poolCache.remove(mint);
      }

    } catch (error) {
      logger.error({ error }, 'Failed to resume monitoring existing token positions');
    }
  }

  const maxPreSwapVolume = resolveMaxPreSwapVolume(quoteToken);
  const maxPreSwapVolumeRaw = maxPreSwapVolume.raw;
  const sanitizedMaxLag = Number.isFinite(MAX_LAG) ? MAX_LAG : 0;
  const maxLagEnabled = sanitizedMaxLag !== 0;
  const maxLagBigInt = BigInt(Math.max(0, Math.trunc(sanitizedMaxLag)));
  const maxSafeLag = BigInt(Number.MAX_SAFE_INTEGER);

  type RaydiumEvaluationResult =
    | { shouldProcess: false }
    | { shouldProcess: true; lagSeconds: number; poolAge: bigint };

  const seenRaydiumMints = new BoundedStringSet(MAX_SEEN_RAYDIUM_MINTS);

  const evaluateRaydiumPool = (poolState: LiquidityStateV4, poolMint: string): RaydiumEvaluationResult => {
    const poolOpenTime = BigInt(poolState.poolOpenTime.toString());
    const totalSwapVolume = poolState.swapBaseInAmount
      .add(poolState.swapBaseOutAmount)
      .add(poolState.swapQuoteInAmount)
      .add(poolState.swapQuoteOutAmount);

    const hasSwaps = !totalSwapVolume.eqn(0);
    const quoteSwapVolume = poolState.swapQuoteInAmount.add(poolState.swapQuoteOutAmount);
    const poolOpenTimeIsSentinel = poolOpenTime <= 0n;

    if (!poolOpenTimeIsSentinel && poolOpenTime < runTimestamp) {
      seenRaydiumMints.add(poolMint);
      logger.trace({ mint: poolMint }, 'Skipping pool created before bot started');
      return { shouldProcess: false };
    }

    if (hasSwaps) {
      if (maxPreSwapVolumeRaw.isZero()) {
        seenRaydiumMints.add(poolMint);
        logger.trace({ mint: poolMint }, 'Skipping pool because swaps already occurred');
        return { shouldProcess: false };
      }

      if (quoteSwapVolume.gt(maxPreSwapVolumeRaw)) {
        seenRaydiumMints.add(poolMint);
        logger.trace(
          {
            mint: poolMint,
            totalSwapVolume: totalSwapVolume.toString(),
            quoteSwapVolume: quoteSwapVolume.toString(),
            maxPreSwapVolume: maxPreSwapVolumeRaw.toString(),
          },
          'Skipping pool because swaps already occurred',
        );
        return { shouldProcess: false };
      }

      logger.trace(
        {
          mint: poolMint,
          totalSwapVolume: totalSwapVolume.toString(),
          quoteSwapVolume: quoteSwapVolume.toString(),
          maxPreSwapVolume: maxPreSwapVolumeRaw.toString(),
        },
        'Pool has swaps within allowed threshold; continuing',
      );
    }

    const currentTimestamp = BigInt(Math.floor(new Date().getTime() / 1000));
    let poolAge = 0n;

    if (!poolOpenTimeIsSentinel) {
      const rawAge = currentTimestamp - poolOpenTime;
      poolAge = rawAge > 0n ? rawAge : 0n;
    }

    if (maxLagEnabled) {
      if (poolOpenTimeIsSentinel) {
        seenRaydiumMints.add(poolMint);
        logger.trace({ mint: poolMint }, 'Skipping pool with invalid open time');
        return { shouldProcess: false };
      }

      if (poolAge > maxLagBigInt) {
        seenRaydiumMints.add(poolMint);
        logger.trace({ mint: poolMint, lag: poolAge.toString() }, 'Lag too high');
        logger.trace(
          { mint: poolMint, poolAge: poolAge.toString(), maxLag: maxLagBigInt.toString() },
          'Skipping pool because lag too high',
        );
        return { shouldProcess: false };
      }
    }

    const safeLag = poolAge > maxSafeLag ? Number.MAX_SAFE_INTEGER : Number(poolAge);

    return { shouldProcess: true, lagSeconds: safeLag, poolAge };
  };

  type PumpfunEvaluationResult =
    | { shouldProcess: false }
    | { shouldProcess: true; lagSeconds: number; poolAge: bigint };

  const seenPumpfunMints = new BoundedStringSet(MAX_SEEN_PUMPFUN_MINTS);

  const evaluatePumpfunPool = (
    payload: PumpfunPoolEventPayload,
    mint: string,
  ): PumpfunEvaluationResult => {
    if (payload.state.complete) {
      seenPumpfunMints.add(mint);
      logger.trace({ mint }, 'Skipping pump.fun pool because bonding curve is complete');
      return { shouldProcess: false };
    }

    const goLiveUnixTime = BigInt(payload.state.goLiveUnixTime);
    const goLiveIsSentinel = goLiveUnixTime <= 0n;

    if (!goLiveIsSentinel && goLiveUnixTime < runTimestamp) {
      seenPumpfunMints.add(mint);
      logger.trace({ mint }, 'Skipping pump.fun pool created before bot started');
      return { shouldProcess: false };
    }

    const currentTimestamp = BigInt(Math.floor(new Date().getTime() / 1000));
    let poolAge = 0n;

    if (!goLiveIsSentinel) {
      const rawAge = currentTimestamp - goLiveUnixTime;
      poolAge = rawAge > 0n ? rawAge : 0n;
    }

    if (maxLagEnabled) {
      if (goLiveIsSentinel) {
        seenPumpfunMints.add(mint);
        logger.trace({ mint }, 'Skipping pump.fun pool with invalid go live time');
        return { shouldProcess: false };
      }

      if (poolAge > maxLagBigInt) {
        seenPumpfunMints.add(mint);
        logger.trace(
          { mint, poolAge: poolAge.toString(), maxLag: maxLagBigInt.toString() },
          'Skipping pump.fun pool because lag too high',
        );
        return { shouldProcess: false };
      }
    }

    const safeLag = poolAge > maxSafeLag ? Number.MAX_SAFE_INTEGER : Number(poolAge);

    return { shouldProcess: true, lagSeconds: safeLag, poolAge };
  };

  listeners.on('market', (updatedAccountInfo: KeyedAccountInfo) => {
    const marketState = MARKET_STATE_LAYOUT_V3.decode(updatedAccountInfo.accountInfo.data);
    marketCache.save(updatedAccountInfo.accountId.toString(), marketState);
  });

  listeners.on('pool', async (updatedAccountInfo: KeyedAccountInfo) => {
    const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(
      updatedAccountInfo.accountInfo.data,
    ) as LiquidityStateV4;
    const poolMint = poolState.baseMint.toString();

    if (await poolCache.get(poolMint)) {
      seenRaydiumMints.add(poolMint);
      return;
    }

    if (seenRaydiumMints.has(poolMint)) {
      return;
    }

    const evaluation = evaluateRaydiumPool(poolState, poolMint);

    if (!evaluation.shouldProcess) {
      return;
    }

    const snapshot = createRaydiumPoolSnapshot(updatedAccountInfo.accountId.toBase58(), poolState);
    await poolCache.save(snapshot, updatedAccountInfo.accountInfo.data);

    seenRaydiumMints.add(poolMint);
    logger.trace(
      { mint: poolMint, lag: evaluation.poolAge.toString(), safeLag: evaluation.lagSeconds },
      'Raydium lag within threshold',
    );

    await bot.buy(snapshot, evaluation.lagSeconds);
  });

  listeners.on('wallet', async (updatedAccountInfo: KeyedAccountInfo) => {
    const accountData = AccountLayout.decode(updatedAccountInfo.accountInfo.data);

    if (accountData.mint.equals(quoteToken.mint)) {
      return;
    }

    await bot.sell(updatedAccountInfo.accountId, accountData);
  });

  if (ENABLE_PUMPFUN) {
    listeners.on('pumpfunPool', async (payload: PumpfunPoolEventPayload) => {
      const mint = payload.mint.toBase58();

      if (seenPumpfunMints.has(mint)) {
        logger.trace({ mint }, 'Skipping pump.fun pool because mint was already processed');
        return;
      }

      if (await poolCache.get(mint)) {
        logger.trace({ mint }, 'Skipping pump.fun pool because it is already cached');
        seenPumpfunMints.add(mint);
        return;
      }

      const evaluation = evaluatePumpfunPool(payload, mint);

      if (!evaluation.shouldProcess) {
        return;
      }

      seenPumpfunMints.add(mint);
      logger.trace(
        { mint, lag: evaluation.poolAge.toString(), safeLag: evaluation.lagSeconds },
        'Pump.fun lag within threshold',
      );

      await bot.handlePumpfunPool(payload, evaluation.lagSeconds);
    });
  }

  printDetails(wallet, quoteToken, bot, maxPreSwapVolume);
};

runListener();
