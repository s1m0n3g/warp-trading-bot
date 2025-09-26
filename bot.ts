import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  createAssociatedTokenAccountIdempotentInstruction,
  createCloseAccountInstruction,
  getAccount,
  getAssociatedTokenAddress,
  RawAccount,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Liquidity, LiquidityPoolKeysV4, LiquidityStateV4, Percent, Token, TokenAmount } from '@raydium-io/raydium-sdk';
import { MarketCache, PoolCache, SnipeListCache } from './cache';
import { PoolFilters } from './filters';
import {
  TransactionExecutor,
  buildPumpFunBuyTransaction,
  buildPumpFunSellTransaction,
  PumpFunBondingCurveState,
  isPumpFunPoolState,
} from './transactions';
import { createPoolKeys, KEEP_5_PERCENT_FOR_MOONSHOTS, logger, NETWORK, sleep } from './helpers';
import { Semaphore } from 'async-mutex';
import { WarpTransactionExecutor } from './transactions/warp-transaction-executor';
import { JitoTransactionExecutor } from './transactions/jito-rpc-transaction-executor';
import { BlacklistCache } from './cache/blacklist.cache';
import { TradeSignals } from './tradeSignals';
import { Messaging } from './messaging';
import { WhitelistCache } from './cache/whitelist.cache';
import { TechnicalAnalysisCache } from './cache/technical-analysis.cache';

export interface BotConfig {
  wallet: Keypair;
  minPoolSize: TokenAmount;
  maxPoolSize: TokenAmount;
  quoteToken: Token;
  quoteAmount: TokenAmount;
  quoteAta: PublicKey;
  maxTokensAtTheTime: number;
  useSnipeList: boolean;
  autoSell: boolean;
  autoBuyDelay: number;
  autoSellDelay: number;
  maxBuyRetries: number;
  maxSellRetries: number;
  unitLimit: number;
  unitPrice: number;
  takeProfit: number;
  stopLoss: number;
  trailingStopLoss: boolean;
  skipSellingIfLostMoreThan: number;
  buySlippage: number;
  sellSlippage: number;
  priceCheckInterval: number;
  priceCheckDuration: number;
  filterCheckInterval: number;
  filterCheckDuration: number;
  consecutiveMatchCount: number;
  checkHolders: boolean;
  checkTokenDistribution: boolean;
  checkAbnormalDistribution: boolean;
  telegramChatId?: number;
  telegramBotToken?: string;
  blacklistRefreshInterval: number;
  MACDLongPeriod?: number;
  MACDShortPeriod?: number;
  MACDSignalPeriod?: number;
  RSIPeriod?: number;
  autoSellWithoutSellSignal: boolean;
  buySignalTimeToWait: number;
  buySignalPriceInterval: number;
  buySignalFractionPercentageTimeToWait: number;
  buySignalLowVolumeThreshold: number;
  useTechnicalAnalysis: boolean;
  useTelegram: boolean;
}

export class Bot {
  private readonly snipeListCache?: SnipeListCache;
  private readonly blacklistCache?: BlacklistCache;
  private readonly whitelistCache?: WhitelistCache;

  private readonly semaphore: Semaphore;
  private sellExecutionCount = 0;
  public readonly isWarp: boolean = false;
  public readonly isJito: boolean = false;
  private readonly tradeSignals: TradeSignals;
  private readonly messaging: Messaging;

  constructor(
    private readonly connection: Connection,
    private readonly marketStorage: MarketCache,
    private readonly poolStorage: PoolCache,
    private readonly txExecutor: TransactionExecutor,
    private readonly technicalAnalysisCache: TechnicalAnalysisCache,
    readonly config: BotConfig,
  ) {
    this.isWarp = txExecutor instanceof WarpTransactionExecutor;
    this.isJito = txExecutor instanceof JitoTransactionExecutor;

    this.semaphore = new Semaphore(config.maxTokensAtTheTime);

    this.messaging = new Messaging(config);

    this.tradeSignals = new TradeSignals(connection, config, this.messaging, technicalAnalysisCache);

    this.whitelistCache = new WhitelistCache();
    this.whitelistCache.init();

    this.blacklistCache = new BlacklistCache();
    this.blacklistCache.init();

    if (this.config.useSnipeList) {
      this.snipeListCache = new SnipeListCache();
      this.snipeListCache.init();
    }
  }

  async validate() {
    try {
      await getAccount(this.connection, this.config.quoteAta, this.connection.commitment);
    } catch (error) {
      logger.error(
        `${this.config.quoteToken.symbol} token account not found in wallet: ${this.config.wallet.publicKey.toString()}`,
      );
      return false;
    }

    return true;
  }

  public async whitelistSnipe(accountId: PublicKey, poolState: LiquidityStateV4): Promise<boolean> {
    if (this.whitelistCache.whitelistIsEmpty()) {
      return false;
    }

    const [market] = await Promise.all([
      this.marketStorage.get(poolState.marketId.toString()),
      getAssociatedTokenAddress(poolState.baseMint, this.config.wallet.publicKey),
    ]);
    const poolKeys: LiquidityPoolKeysV4 = createPoolKeys(accountId, poolState, market);

    //updateAuthority is whitelisted
    return await this.whitelistCache.isInList(this.connection, poolKeys);
  }

  public async buy(
    accountId: PublicKey,
    poolState: LiquidityStateV4 | PumpFunBondingCurveState,
    lag: number = 0,
  ) {
    const isPumpFun = isPumpFunPoolState(poolState);
    const baseMint = isPumpFun ? poolState.mint : (poolState as LiquidityStateV4).baseMint;
    const baseMintStr = baseMint.toString();
    const source = isPumpFun ? 'pumpfun' : 'raydium';

    logger.trace({ mint: baseMint }, `Processing new pool...`);

    const whitelistSnipe = isPumpFun ? false : await this.whitelistSnipe(accountId, poolState as LiquidityStateV4);

    if (this.config.useSnipeList && !this.snipeListCache?.isInList(baseMintStr)) {
      logger.debug({ mint: baseMintStr }, `Skipping buy because token is not in a snipe list`);
      return;
    }

    if (!whitelistSnipe) {
      if (this.config.autoBuyDelay > 0) {
        logger.debug({ mint: baseMint }, `Waiting for ${this.config.autoBuyDelay} ms before buy`);
        await sleep(this.config.autoBuyDelay);
      }
    }

    const numberOfActionsBeingProcessed =
      this.config.maxTokensAtTheTime - this.semaphore.getValue() + this.sellExecutionCount;
    if (this.semaphore.isLocked() || numberOfActionsBeingProcessed >= this.config.maxTokensAtTheTime) {
      logger.debug(
        { mint: baseMintStr },
        `Skipping buy because max tokens to process at the same time is ${this.config.maxTokensAtTheTime} and currently ${numberOfActionsBeingProcessed} tokens is being processed`,
      );
      return;
    }

    await this.semaphore.acquire();

    try {
      let mintAta: PublicKey;
      let poolKeys: LiquidityPoolKeysV4 | undefined;

      if (isPumpFun) {
        mintAta = await getAssociatedTokenAddress(baseMint, this.config.wallet.publicKey);
      } else {
        const raydiumState = poolState as LiquidityStateV4;
        const [market, derivedMintAta] = await Promise.all([
          this.marketStorage.get(raydiumState.marketId.toString()),
          getAssociatedTokenAddress(raydiumState.baseMint, this.config.wallet.publicKey),
        ]);
        mintAta = derivedMintAta;
        poolKeys = createPoolKeys(accountId, raydiumState, market);
      }

      if (!isPumpFun && poolKeys) {
        if (!whitelistSnipe && !this.config.useSnipeList) {
          const match = await this.filterMatch(poolKeys);

          if (!match) {
            logger.trace({ mint: poolKeys.baseMint.toString() }, `Skipping buy because pool doesn't match filters`);
            return;
          }
        }

        if (!whitelistSnipe) {
          const buySignal = await this.tradeSignals.waitForBuySignal(poolKeys);

          if (!buySignal) {
            await this.messaging.sendTelegramMessage(
              `😭Skipping buy signal😭\n\nMint <code>${poolKeys.baseMint.toString()}</code>`,
              baseMintStr,
            );

            logger.trace({ mint: poolKeys.baseMint.toString() }, `Skipping buy because buy signal not received`);
            return;
          }
        }
      }

      const startTime = Date.now();
      for (let i = 0; i < this.config.maxBuyRetries; i++) {
        try {
          if (Date.now() - startTime > 10_000) {
            logger.info(`Not buying mint ${baseMintStr}, max buy 10 sec timer exceeded!`);
            return;
          }

          logger.info(
            { mint: baseMintStr, source },
            `Send buy transaction attempt: ${i + 1}/${this.config.maxBuyRetries}`,
          );

          let result: Awaited<ReturnType<TransactionExecutor['executeAndConfirm']>>;

          if (isPumpFun) {
            const amountLamports = BigInt(this.config.quoteAmount.raw.toString());
            const includeComputeBudget = !(this.isWarp || this.isJito);
            const built = await buildPumpFunBuyTransaction({
              connection: this.connection,
              wallet: this.config.wallet,
              pool: poolState as PumpFunBondingCurveState,
              userTokenAccount: mintAta,
              amountLamports,
              slippage: this.config.buySlippage,
              includeComputeBudget,
              computeUnitLimit: this.config.unitLimit,
              computeUnitPrice: this.config.unitPrice,
            });

            result = await this.txExecutor.executeAndConfirm(
              built.transaction,
              this.config.wallet,
              built.latestBlockhash,
            );
          } else {
            const tokenOut = new Token(TOKEN_PROGRAM_ID, poolKeys!.baseMint, poolKeys!.baseDecimals);
            result = await this.swap(
              poolKeys!,
              this.config.quoteAta,
              mintAta,
              this.config.quoteToken,
              tokenOut,
              this.config.quoteAmount,
              this.config.buySlippage,
              this.config.wallet,
              'buy',
            );
          }

          if (result.confirmed) {
            const signatureUrl = `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`;
            const dexUrl = isPumpFun
              ? `https://pump.fun/coin/${baseMintStr}`
              : `https://dexscreener.com/solana/${baseMintStr}?maker=${this.config.wallet.publicKey}`;

            logger.info(
              {
                mint: baseMintStr,
                signature: result.signature,
                url: signatureUrl,
                dex: dexUrl,
                source,
              },
              `Confirmed buy tx`,
            );

            const sourceLabel = isPumpFun ? 'pump.fun' : 'Raydium';
            await this.messaging.sendTelegramMessage(
              `💚Confirmed ${sourceLabel} buy💚\n\nMint <code>${baseMintStr}</code>\nSignature <code>${result.signature}</code>`,
              baseMintStr,
              { source: isPumpFun ? 'pumpfun' : 'raydium' },
            );

            break;
          }

          logger.info(
            {
              mint: baseMintStr,
              signature: result.signature,
              error: result.error,
              source,
            },
            `Error confirming buy tx`,
          );
        } catch (error) {
          logger.debug({ mint: baseMintStr, error, source }, `Error confirming buy transaction`);
        }
      }
    } catch (error) {
      logger.error({ mint: baseMintStr, error, source }, `Failed to buy token`);
    } finally {
      this.semaphore.release();
    }
  }

  public async sell(accountId: PublicKey, rawAccount: RawAccount) {
    this.sellExecutionCount++;

    let source: 'pumpfun' | 'raydium' = 'raydium';

    try {
      const poolData = await this.poolStorage.get(rawAccount.mint.toString());

      if (poolData && poolData.sold) {
        return;
      }

      logger.trace({ mint: rawAccount.mint }, `Processing new token...`);

      if (!poolData) {
        logger.trace({ mint: rawAccount.mint.toString() }, `Token pool data is not found, can't sell`);
        return;
      }

      const isPumpFun = poolData.type === 'pumpfun';
      source = isPumpFun ? 'pumpfun' : 'raydium';
      const pumpFunState = isPumpFun ? (poolData.state as PumpFunBondingCurveState) : undefined;
      const baseMint = isPumpFun ? pumpFunState!.mint : (poolData.state as LiquidityStateV4).baseMint;
      const baseMintStr = baseMint.toString();

      let moonshotConditionAmount = KEEP_5_PERCENT_FOR_MOONSHOTS
        ? (rawAccount.amount * BigInt(95)) / BigInt(100)
        : rawAccount.amount;

      const tokenDecimals = isPumpFun
        ? pumpFunState!.decimals
        : (poolData.state as LiquidityStateV4).baseDecimal.toNumber();
      const tokenIn = new Token(TOKEN_PROGRAM_ID, baseMint, tokenDecimals);
      const tokenAmountIn = new TokenAmount(tokenIn, moonshotConditionAmount, true);

      if (tokenAmountIn.isZero()) {
        logger.info({ mint: baseMintStr, source }, `Empty balance, can't sell`);
        return;
      }

      if (this.config.autoSellDelay > 0) {
        logger.debug({ mint: baseMintStr }, `Waiting for ${this.config.autoSellDelay} ms before sell`);
        await sleep(this.config.autoSellDelay);
      }

      let poolKeys: LiquidityPoolKeysV4 | undefined;

      if (!isPumpFun) {
        const market = await this.marketStorage.get((poolData.state as LiquidityStateV4).marketId.toString());
        poolKeys = createPoolKeys(new PublicKey(poolData.id), poolData.state as LiquidityStateV4, market);
      }

      for (let i = 0; i < this.config.maxSellRetries; i++) {
        try {
          if (!isPumpFun && i < 1 && poolKeys) {
            const shouldSell = await this.tradeSignals.waitForSellSignal(tokenAmountIn, poolKeys);

            if (!shouldSell) {
              return;
            }
          }

          if (KEEP_5_PERCENT_FOR_MOONSHOTS) {
            this.poolStorage.markAsSold(rawAccount.mint.toString());
          }

          logger.info(
            { mint: baseMintStr, source },
            `Send sell transaction attempt: ${i + 1}/${this.config.maxSellRetries}`,
          );

          let result: Awaited<ReturnType<TransactionExecutor['executeAndConfirm']>>;

          if (isPumpFun) {
            const includeComputeBudget = !(this.isWarp || this.isJito);
            const built = await buildPumpFunSellTransaction({
              connection: this.connection,
              wallet: this.config.wallet,
              pool: pumpFunState!,
              userTokenAccount: accountId,
              tokenAmount: moonshotConditionAmount,
              slippage: this.config.sellSlippage,
              includeComputeBudget,
              computeUnitLimit: this.config.unitLimit,
              computeUnitPrice: this.config.unitPrice,
              closeTokenAccount: !KEEP_5_PERCENT_FOR_MOONSHOTS,
            });

            result = await this.txExecutor.executeAndConfirm(
              built.transaction,
              this.config.wallet,
              built.latestBlockhash,
            );
          } else {
            result = await this.swap(
              poolKeys!,
              accountId,
              this.config.quoteAta,
              tokenIn,
              this.config.quoteToken,
              tokenAmountIn,
              this.config.sellSlippage,
              this.config.wallet,
              'sell',
            );
          }

          if (result.confirmed) {
            try {
              this.connection
                .getParsedTransaction(result.signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 })
                .then(async (parsedConfirmedTransaction) => {
                  if (parsedConfirmedTransaction) {
                    let preTokenBalances = parsedConfirmedTransaction.meta.preTokenBalances;
                    let postTokenBalances = parsedConfirmedTransaction.meta.postTokenBalances;

                    let pre = preTokenBalances
                      .filter(
                        (x) =>
                          x.mint === this.config.quoteToken.mint.toString() &&
                          x.owner === this.config.wallet.publicKey.toString(),
                      )
                      .map((x) => x.uiTokenAmount.uiAmount)
                      .reduce((a, b) => a + b, 0);

                    let post = postTokenBalances
                      .filter(
                        (x) =>
                          x.mint === this.config.quoteToken.mint.toString() &&
                          x.owner === this.config.wallet.publicKey.toString(),
                      )
                      .map((x) => x.uiTokenAmount.uiAmount)
                      .reduce((a, b) => a + b, 0);

                    let quoteAmountNumber = parseFloat(this.config.quoteAmount.toFixed());
                    let profitOrLoss = post - pre - quoteAmountNumber;
                    let percentageChange = (profitOrLoss / quoteAmountNumber) * 100;

                    const saleSourceLabel = source === 'pumpfun' ? 'pump.fun' : 'Raydium';
                    await this.messaging.sendTelegramMessage(
                      `⭕Confirmed ${saleSourceLabel} sale at <b>${(post - pre).toFixed(5)}</b>⭕\n\n${
                        profitOrLoss < 0 ? '🔴Loss ' : '🟢Profit '
                      }<code>${profitOrLoss.toFixed(5)} ${this.config.quoteToken.symbol} (${percentageChange.toFixed(
                        2,
                      )}%)</code>\n\nRetries <code>${i + 1}/${this.config.maxSellRetries}</code>`,
                      rawAccount.mint.toString(),
                      { source },
                    );
                  }
                })
                .catch((error) => {
                  console.log('Error fetching transaction details:', error);
                });
            } catch (error) {
              console.log('Error calculating profit', error);
            }

            const signatureUrl = `https://solscan.io/tx/${result.signature}?cluster=${NETWORK}`;
            const dexUrl = isPumpFun
              ? `https://pump.fun/coin/${baseMintStr}`
              : `https://dexscreener.com/solana/${rawAccount.mint.toString()}?maker=${this.config.wallet.publicKey}`;

            logger.info(
              {
                dex: dexUrl,
                mint: rawAccount.mint.toString(),
                signature: result.signature,
                url: signatureUrl,
                source,
              },
              `Confirmed sell tx`,
            );
            break;
          }

          logger.info(
            {
              mint: rawAccount.mint.toString(),
              signature: result.signature,
              error: result.error,
              source,
            },
            `Error confirming sell tx`,
          );
        } catch (error) {
          logger.debug({ mint: rawAccount.mint.toString(), error, source }, `Error confirming sell transaction`);
        }
      }
    } catch (error) {
      logger.error({ mint: rawAccount.mint.toString(), error, source }, `Failed to sell token`);
    } finally {
      this.sellExecutionCount--;
    }
  }

  // noinspection JSUnusedLocalSymbols
  private async swap(
    poolKeys: LiquidityPoolKeysV4,
    ataIn: PublicKey,
    ataOut: PublicKey,
    tokenIn: Token,
    tokenOut: Token,
    amountIn: TokenAmount,
    slippage: number,
    wallet: Keypair,
    direction: 'buy' | 'sell',
  ) {
    const slippagePercent = new Percent(slippage, 100);
    const poolInfo = await Liquidity.fetchInfo({
      connection: this.connection,
      poolKeys,
    });

    const computedAmountOut = Liquidity.computeAmountOut({
      poolKeys,
      poolInfo,
      amountIn,
      currencyOut: tokenOut,
      slippage: slippagePercent,
    });

    const latestBlockhash = await this.connection.getLatestBlockhash();
    const { innerTransaction } = Liquidity.makeSwapFixedInInstruction(
      {
        poolKeys: poolKeys,
        userKeys: {
          tokenAccountIn: ataIn,
          tokenAccountOut: ataOut,
          owner: wallet.publicKey,
        },
        amountIn: amountIn.raw,
        minAmountOut: computedAmountOut.minAmountOut.raw,
      },
      poolKeys.version,
    );

    const messageV0 = new TransactionMessage({
      payerKey: wallet.publicKey,
      recentBlockhash: latestBlockhash.blockhash,
      instructions: [
        ...(this.isWarp || this.isJito
          ? []
          : [
            ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.config.unitPrice }),
            ComputeBudgetProgram.setComputeUnitLimit({ units: this.config.unitLimit }),
          ]),
        ...(direction === 'buy'
          ? [
            createAssociatedTokenAccountIdempotentInstruction(
              wallet.publicKey,
              ataOut,
              wallet.publicKey,
              tokenOut.mint,
            ),
          ]
          : []),
        ...innerTransaction.instructions,
        // Close the account if we are selling and not keeping 5% for moonshots
        ...((direction === 'sell' && !KEEP_5_PERCENT_FOR_MOONSHOTS) ? [createCloseAccountInstruction(ataIn, wallet.publicKey, wallet.publicKey)] : []),
      ],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);
    transaction.sign([wallet, ...innerTransaction.signers]);

    return this.txExecutor.executeAndConfirm(transaction, wallet, latestBlockhash);
  }

  private async filterMatch(poolKeys: LiquidityPoolKeysV4) {
    if (this.config.filterCheckInterval === 0 || this.config.filterCheckDuration === 0) {
      return true;
    }

    const filters = new PoolFilters(this.connection, {
      quoteToken: this.config.quoteToken,
      minPoolSize: this.config.minPoolSize,
      maxPoolSize: this.config.maxPoolSize,
    }, this.blacklistCache);

    const timesToCheck = this.config.filterCheckDuration / this.config.filterCheckInterval;
    let timesChecked = 0;
    let matchCount = 0;

    do {
      try {
        const shouldBuy = await filters.execute(poolKeys);

        if (shouldBuy) {
          matchCount++;

          if (this.config.consecutiveMatchCount <= matchCount) {
            logger.debug(
              { mint: poolKeys.baseMint.toString() },
              `Filter match ${matchCount}/${this.config.consecutiveMatchCount}`,
            );
            return true;
          }
        } else {
          matchCount = 0;
        }

        if (this.config.filterCheckInterval > 1) {
          logger.trace({ mint: poolKeys.baseMint.toString() }, `${timesChecked + 1}/${timesToCheck} Filter didn't match, waiting for ${this.config.filterCheckInterval / 1000} sec.`);
        }
        await sleep(this.config.filterCheckInterval);
      } finally {
        timesChecked++;
      }
    } while (timesChecked < timesToCheck);

    return false;
  }
}