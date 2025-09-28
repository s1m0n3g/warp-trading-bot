import BN from 'bn.js';
import { MarketCache, PoolCache, createRaydiumPoolSnapshot } from './cache';
import { Listeners } from './listeners';
import { Connection, KeyedAccountInfo, Keypair } from '@solana/web3.js';
import { LIQUIDITY_STATE_LAYOUT_V4, MARKET_STATE_LAYOUT_V3, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { AccountLayout, getAssociatedTokenAddressSync } from '@solana/spl-token';
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
    logger.info(`${TRANSACTION_EXECUTOR} fee: ${CUSTOM_FEE}`);
  } else {
    logger.info(`Compute Unit limit: ${botConfig.unitLimit}`);
    logger.info(`Compute Unit price (micro lamports): ${botConfig.unitPrice}`);
  }

  logger.info(`Max tokens at the time: ${botConfig.maxTokensAtTheTime}`);
  logger.info(`Pre load existing markets: ${PRE_LOAD_EXISTING_MARKETS}`);
  logger.info(`Cache new markets: ${CACHE_NEW_MARKETS}`);
  logger.info(`Log level: ${LOG_LEVEL}`);
  logger.info(`Max lag: ${MAX_LAG}`);
  logger.info(`Max pre swap volume: ${maxPreSwapVolume.display}`);
  logger.info(`Pump.fun listener enabled: ${botConfig.enablePumpfun}`);
  logger.info(`Telegram notifications: ${botConfig.useTelegram}`);

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
  logger.info(`Price check interval: ${botConfig.priceCheckInterval} ms`);
  logger.info(`Price check duration: ${botConfig.priceCheckDuration} ms`);
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

  const marketCache = new MarketCache(connection);
  const poolCache = new PoolCache();
  await poolCache.init();
  const technicalAnalysisCache = new TechnicalAnalysisCache();

  let txExecutor: TransactionExecutor;

  switch (TRANSACTION_EXECUTOR) {
    case 'warp': {
      txExecutor = new WarpTransactionExecutor(CUSTOM_FEE);
      break;
    }
    case 'jito': {
      txExecutor = new JitoTransactionExecutor(CUSTOM_FEE, connection);
      break;
    }
    default: {
      txExecutor = new DefaultTransactionExecutor(connection);
      break;
    }
  }

  const wallet = getWallet(PRIVATE_KEY.trim());
  const quoteToken = getToken(QUOTE_MINT);
  const botConfig = <BotConfig>{
    wallet,
    quoteAta: getAssociatedTokenAddressSync(quoteToken.mint, wallet.publicKey),
    minPoolSize: new TokenAmount(quoteToken, MIN_POOL_SIZE, false),
    maxPoolSize: new TokenAmount(quoteToken, MAX_POOL_SIZE, false),
    quoteToken,
    quoteAmount: new TokenAmount(quoteToken, QUOTE_AMOUNT, false),
    maxTokensAtTheTime: MAX_TOKENS_AT_THE_TIME,
    useSnipeList: USE_SNIPE_LIST,
    autoSell: AUTO_SELL,
    autoSellDelay: AUTO_SELL_DELAY,
    maxSellRetries: MAX_SELL_RETRIES,
    autoBuyDelay: AUTO_BUY_DELAY,
    maxBuyRetries: MAX_BUY_RETRIES,
    unitLimit: COMPUTE_UNIT_LIMIT,
    unitPrice: COMPUTE_UNIT_PRICE,
    takeProfit: TAKE_PROFIT,
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

  const maxPreSwapVolume = resolveMaxPreSwapVolume(quoteToken);
  const maxPreSwapVolumeRaw = maxPreSwapVolume.raw;

  listeners.on('market', (updatedAccountInfo: KeyedAccountInfo) => {
    const marketState = MARKET_STATE_LAYOUT_V3.decode(updatedAccountInfo.accountInfo.data);
    marketCache.save(updatedAccountInfo.accountId.toString(), marketState);
  });

  listeners.on('pool', async (updatedAccountInfo: KeyedAccountInfo) => {
    const poolState = LIQUIDITY_STATE_LAYOUT_V4.decode(updatedAccountInfo.accountInfo.data);
    const poolMint = poolState.baseMint.toString();
    const exists = await poolCache.get(poolMint);

    if (exists) {
      return;
    }

    const snapshot = createRaydiumPoolSnapshot(updatedAccountInfo.accountId.toString(), poolState);
    await poolCache.save(snapshot, updatedAccountInfo.accountInfo.data);

    const poolOpenTime = BigInt(poolState.poolOpenTime.toString());
    const totalSwapVolume = poolState.swapBaseInAmount
      .add(poolState.swapBaseOutAmount)
      .add(poolState.swapQuoteInAmount)
      .add(poolState.swapQuoteOutAmount);

    const hasSwaps = !totalSwapVolume.eqn(0);
    const quoteSwapVolume = poolState.swapQuoteInAmount.add(poolState.swapQuoteOutAmount);


    const poolOpenTimeIsSentinel = poolOpenTime <= 0n;

    if (!hasSwaps && !poolOpenTimeIsSentinel && poolOpenTime < runTimestamp) {
      logger.trace({ mint: poolMint }, 'Skipping pool created before bot started');
      return;
    }

    if (hasSwaps) {
      if (maxPreSwapVolumeRaw.isZero()) {
        logger.trace({ mint: poolMint }, 'Skipping pool because swaps already occurred');
        return;
      }

      if (quoteSwapVolume.gt(maxPreSwapVolumeRaw)) {

        logger.trace(
          {
            mint: poolMint,
            totalSwapVolume: totalSwapVolume.toString(),
            quoteSwapVolume: quoteSwapVolume.toString(),

            maxPreSwapVolume: maxPreSwapVolumeRaw.toString(),
          },
          'Skipping pool because swaps already occurred',
        );
        return;
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

    const maxLagEnabled = MAX_LAG !== 0;
    const maxLagBigInt = BigInt(Math.max(0, Math.trunc(MAX_LAG)));

    if (maxLagEnabled) {
      if (poolOpenTimeIsSentinel) {
        logger.trace({ mint: poolMint }, 'Skipping pool with invalid open time');
        return;
      }

      if (poolAge > maxLagBigInt) {
        logger.trace(`Lag too high: ${poolAge.toString()} sec`);
        return;
      }
    }

    const maxSafeLag = BigInt(Number.MAX_SAFE_INTEGER);
    const safeLag = poolAge > maxSafeLag ? Number.MAX_SAFE_INTEGER : Number(poolAge);

    logger.trace(`Lag: ${poolAge.toString()} sec`);
    await bot.buy(snapshot, safeLag);
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
      await bot.handlePumpfunPool(payload);
    });
  }

  printDetails(wallet, quoteToken, bot, maxPreSwapVolume);
};

runListener();
