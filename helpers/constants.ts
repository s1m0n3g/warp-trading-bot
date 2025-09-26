import { Logger } from 'pino';
import dotenv from 'dotenv';
import { Commitment } from '@solana/web3.js';
import { logger } from './logger';

dotenv.config();

const retrieveEnvVariable = (variableName: string, logger: Logger) => {
  const variable = process.env[variableName] || '';
  if (!variable) {
    logger.error(`${variableName} is not set`);
    process.exit(1);
  }
  return variable;
};

// Wallet
export const PRIVATE_KEY = retrieveEnvVariable('PRIVATE_KEY', logger);

// Connection
export const NETWORK = 'mainnet-beta';
export const COMMITMENT_LEVEL: Commitment = retrieveEnvVariable('COMMITMENT_LEVEL', logger) as Commitment;
export const RPC_ENDPOINT = retrieveEnvVariable('RPC_ENDPOINT', logger);
export const RPC_WEBSOCKET_ENDPOINT = retrieveEnvVariable('RPC_WEBSOCKET_ENDPOINT', logger);

// Bot
export const LOG_LEVEL = retrieveEnvVariable('LOG_LEVEL', logger);
export const MAX_TOKENS_AT_THE_TIME = Number(retrieveEnvVariable('MAX_TOKENS_AT_THE_TIME', logger));
export const COMPUTE_UNIT_LIMIT = Number(retrieveEnvVariable('COMPUTE_UNIT_LIMIT', logger));
export const COMPUTE_UNIT_PRICE = Number(retrieveEnvVariable('COMPUTE_UNIT_PRICE', logger));
export const PRE_LOAD_EXISTING_MARKETS = retrieveEnvVariable('PRE_LOAD_EXISTING_MARKETS', logger) === 'true';
export const CACHE_NEW_MARKETS = retrieveEnvVariable('CACHE_NEW_MARKETS', logger) === 'true';
export const TRANSACTION_EXECUTOR = retrieveEnvVariable('TRANSACTION_EXECUTOR', logger);
export const CUSTOM_FEE = retrieveEnvVariable('CUSTOM_FEE', logger);
export const MAX_LAG = Number(retrieveEnvVariable('MAX_LAG', logger));
export const USE_TA = retrieveEnvVariable('USE_TA', logger) === 'true';
export const USE_TELEGRAM = retrieveEnvVariable('USE_TELEGRAM', logger) === 'true';

// Buy
export const AUTO_BUY_DELAY = Number(retrieveEnvVariable('AUTO_BUY_DELAY', logger));
export const QUOTE_MINT = retrieveEnvVariable('QUOTE_MINT', logger);
export const QUOTE_AMOUNT = retrieveEnvVariable('QUOTE_AMOUNT', logger);
export const MAX_BUY_RETRIES = Number(retrieveEnvVariable('MAX_BUY_RETRIES', logger));
export const BUY_SLIPPAGE = Number(retrieveEnvVariable('BUY_SLIPPAGE', logger));

export const BUY_SIGNAL_TIME_TO_WAIT = Number(retrieveEnvVariable('BUY_SIGNAL_TIME_TO_WAIT', logger));
export const BUY_SIGNAL_PRICE_INTERVAL = Number(retrieveEnvVariable('BUY_SIGNAL_PRICE_INTERVAL', logger));
export const BUY_SIGNAL_FRACTION_TIME_TO_WAIT = Number(retrieveEnvVariable('BUY_SIGNAL_FRACTION_TIME_TO_WAIT', logger));
export const BUY_SIGNAL_LOW_VOLUME_THRESHOLD = Number(retrieveEnvVariable('BUY_SIGNAL_LOW_VOLUME_THRESHOLD', logger));

// Sell
export const AUTO_SELL = retrieveEnvVariable('AUTO_SELL', logger) === 'true';
export const AUTO_SELL_DELAY = Number(retrieveEnvVariable('AUTO_SELL_DELAY', logger));
export const MAX_SELL_RETRIES = Number(retrieveEnvVariable('MAX_SELL_RETRIES', logger));
export const TAKE_PROFIT = Number(retrieveEnvVariable('TAKE_PROFIT', logger));
export const STOP_LOSS = Number(retrieveEnvVariable('STOP_LOSS', logger));
export const TRAILING_STOP_LOSS = retrieveEnvVariable('TRAILING_STOP_LOSS', logger) === 'true';
export const PRICE_CHECK_INTERVAL = Number(retrieveEnvVariable('PRICE_CHECK_INTERVAL', logger));
export const PRICE_CHECK_DURATION = Number(retrieveEnvVariable('PRICE_CHECK_DURATION', logger));
export const SELL_SLIPPAGE = Number(retrieveEnvVariable('SELL_SLIPPAGE', logger));
export const SKIP_SELLING_IF_LOST_MORE_THAN = Number(retrieveEnvVariable('SKIP_SELLING_IF_LOST_MORE_THAN', logger));
export const AUTO_SELL_WITHOUT_SELL_SIGNAL = retrieveEnvVariable('AUTO_SELL_WITHOUT_SELL_SIGNAL', logger) === 'true';
export const KEEP_5_PERCENT_FOR_MOONSHOTS = retrieveEnvVariable('KEEP_5_PERCENT_FOR_MOONSHOTS', logger) === 'true';


// Filters
export const FILTER_CHECK_INTERVAL = Number(retrieveEnvVariable('FILTER_CHECK_INTERVAL', logger));
export const FILTER_CHECK_DURATION = Number(retrieveEnvVariable('FILTER_CHECK_DURATION', logger));
export const CONSECUTIVE_FILTER_MATCHES = Number(retrieveEnvVariable('CONSECUTIVE_FILTER_MATCHES', logger));
export const CHECK_IF_MUTABLE = retrieveEnvVariable('CHECK_IF_MUTABLE', logger) === 'true';
export const CHECK_IF_SOCIALS = retrieveEnvVariable('CHECK_IF_SOCIALS', logger) === 'true';
export const CHECK_IF_MINT_IS_RENOUNCED = retrieveEnvVariable('CHECK_IF_MINT_IS_RENOUNCED', logger) === 'true';
export const CHECK_IF_FREEZABLE = retrieveEnvVariable('CHECK_IF_FREEZABLE', logger) === 'true';
export const CHECK_IF_BURNED = retrieveEnvVariable('CHECK_IF_BURNED', logger) === 'true';
export const MIN_POOL_SIZE = retrieveEnvVariable('MIN_POOL_SIZE', logger);
export const MAX_POOL_SIZE = retrieveEnvVariable('MAX_POOL_SIZE', logger);
export const USE_SNIPE_LIST = retrieveEnvVariable('USE_SNIPE_LIST', logger) === 'true';
export const SNIPE_LIST_REFRESH_INTERVAL = Number(retrieveEnvVariable('SNIPE_LIST_REFRESH_INTERVAL', logger));
export const BLACKLIST_REFRESH_INTERVAL = Number(retrieveEnvVariable('BLACKLIST_REFRESH_INTERVAL', logger));
export const WHITELIST_REFRESH_INTERVAL = Number(retrieveEnvVariable('WHITELIST_REFRESH_INTERVAL', logger));

//Holders filters
export const CHECK_TOKEN_DISTRIBUTION = retrieveEnvVariable('CHECK_TOKEN_DISTRIBUTION', logger)=== 'true';
export const TOP_HOLDER_MAX_PERCENTAGE = Number(retrieveEnvVariable('TOP_HOLDER_MAX_PERCENTAGE', logger));
export const CHECK_ABNORMAL_DISTRIBUTION  = retrieveEnvVariable('CHECK_ABNORMAL_DISTRIBUTION', logger) === 'true';
export const ABNORMAL_HOLDER_NR = Number(retrieveEnvVariable('ABNORMAL_HOLDER_NR', logger));
export const CHECK_HOLDERS  = retrieveEnvVariable('CHECK_HOLDERS', logger) === 'true';
export const TOP_10_PERCENTAGE_CHECK  = retrieveEnvVariable('TOP_10_PERCENTAGE_CHECK', logger) === 'true';
export const TOP_10_MAX_PERCENTAGE = Number (retrieveEnvVariable('TOP_10_MAX_PERCENTAGE', logger));
export const HOLDER_MIN_AMOUNT = Number (retrieveEnvVariable('HOLDER_MIN_AMOUNT', logger));

//Telegram config
export const TELEGRAM_BOT_TOKEN = retrieveEnvVariable('TELEGRAM_BOT_TOKEN', logger);
export const TELEGRAM_CHAT_ID = Number (retrieveEnvVariable('TELEGRAM_CHAT_ID', logger));

//Technical analysis
export const MACD_SHORT_PERIOD = Number (retrieveEnvVariable('MACD_SHORT_PERIOD', logger));
export const MACD_LONG_PERIOD = Number (retrieveEnvVariable('MACD_LONG_PERIOD', logger));
export const MACD_SIGNAL_PERIOD = Number (retrieveEnvVariable('MACD_SIGNAL_PERIOD', logger));

export const RSI_PERIOD = Number (retrieveEnvVariable('RSI_PERIOD', logger));
