import { Liquidity, LiquidityPoolKeysV4, Percent, TOKEN_PROGRAM_ID, Token, TokenAmount } from "@raydium-io/raydium-sdk";
import { logger, sleep } from "./helpers";
import { Connection } from "@solana/web3.js";
import { BotConfig } from "./bot";
import { TechnicalAnalysis } from "./technicalAnalysis";
import BN from "bn.js";
import { Messaging } from "./messaging";

export class TradeSignals {

    private readonly TA: TechnicalAnalysis;
    private readonly stopLoss = new Map<string, TokenAmount>();

    constructor(
        private readonly connection: Connection,
        readonly config: BotConfig,
        private readonly messaging: Messaging
    ) {
        this.TA = new TechnicalAnalysis(config);
    }

    public async waitForBuySignal(poolKeys: LiquidityPoolKeysV4) {

        logger.trace({ mint: poolKeys.baseMint.toString() }, `Waiting for buy signal`);

        let timesToCheck = (10 * 60) / 2; //10min with 2s interval

        let maxSignalWaitTries = 60;
        let timesChecked = 0;

        let prices: number[] = [];

        // let previousRSI = null;
        do {
            try {
                let poolInfo = await Liquidity.fetchInfo({
                    connection: this.connection,
                    poolKeys
                });

                let tokenPriceBN = Liquidity.getRate(poolInfo);

                if (prices.length === 0 || parseFloat(tokenPriceBN.toFixed(16)) !== prices[prices.length - 1]) {
                    prices.push(parseFloat(tokenPriceBN.toFixed(16)));
                }

                let currentRSI = this.TA.calculateRSIv2(prices);
                let macd = this.TA.calculateMACDv2(prices);

                logger.trace({ mint: poolKeys.baseMint.toString() }, `${timesChecked}/${timesToCheck} Waiting for buy signal: Price: ${tokenPriceBN.toFixed(16)}, RSI: ${currentRSI.toFixed(3)}, MACD: ${macd.macd}, Signal: ${macd.signal}`);

                if (timesChecked >= maxSignalWaitTries && currentRSI == 0 && !macd.macd) {
                    logger.trace(`Not enough data for signal after ${maxSignalWaitTries} tries, skipping buy signal`);
                    return false;
                }

                if (currentRSI > 0 && currentRSI < 30 && macd.macd && macd.signal && macd.macd > macd.signal) {
                    logger.trace("RSI is less than 30, macd + signal = long, sending buy signal");
                    return true;
                }

                // if (currentRSI > 0) {
                //   if (previousRSI != null && previousRSI > 0 && previousRSI < 30 && currentRSI >= 30) {
                //     previousRSI = currentRSI;
                //     return true;
                //   }
                //   previousRSI = currentRSI;
                // }

                await sleep(1000);
            } catch (e) {
                logger.trace({ mint: poolKeys.baseMint.toString(), e }, `Failed to check token price`);
            } finally {
                timesChecked++;
            }
        } while (timesChecked < timesToCheck);

        return false;
    }


    public async waitForSellSignal(amountIn: TokenAmount, poolKeys: LiquidityPoolKeysV4) {
        if (this.config.priceCheckDuration === 0 || this.config.priceCheckInterval === 0) {
            return true;
        }

        const timesToCheck = this.config.priceCheckDuration / this.config.priceCheckInterval;
        const profitFraction = this.config.quoteAmount.mul(this.config.takeProfit).numerator.div(new BN(100));
        const profitAmount = new TokenAmount(this.config.quoteToken, profitFraction, true);
        const takeProfit = this.config.quoteAmount.add(profitAmount);
        let stopLoss: TokenAmount;

        if (!this.stopLoss.get(poolKeys.baseMint.toString())) {
            const lossFraction = this.config.quoteAmount.mul(this.config.stopLoss).numerator.div(new BN(100));
            const lossAmount = new TokenAmount(this.config.quoteToken, lossFraction, true);
            stopLoss = this.config.quoteAmount.subtract(lossAmount);

            this.stopLoss.set(poolKeys.baseMint.toString(), stopLoss);
        } else {
            stopLoss = this.stopLoss.get(poolKeys.baseMint.toString())!;
        }

        const slippage = new Percent(this.config.sellSlippage, 100);
        let timesChecked = 0;
        //let telegram_status_message_id: number | undefined = undefined;

        do {
            try {
                const poolInfo = await Liquidity.fetchInfo({
                    connection: this.connection,
                    poolKeys,
                });

                const amountOut = Liquidity.computeAmountOut({
                    poolKeys,
                    poolInfo,
                    amountIn: amountIn,
                    currencyOut: this.config.quoteToken,
                    slippage,
                }).amountOut as TokenAmount;

                if (this.config.trailingStopLoss) {
                    const trailingLossFraction = amountOut.mul(this.config.stopLoss).numerator.div(new BN(100));
                    const trailingLossAmount = new TokenAmount(this.config.quoteToken, trailingLossFraction, true);
                    const trailingStopLoss = amountOut.subtract(trailingLossAmount);

                    if (trailingStopLoss.gt(stopLoss)) {
                        logger.trace(
                            { mint: poolKeys.baseMint.toString() },
                            `Updating trailing stop loss from ${stopLoss.toFixed()} to ${trailingStopLoss.toFixed()}`,
                        );
                        this.stopLoss.set(poolKeys.baseMint.toString(), trailingStopLoss);
                        stopLoss = trailingStopLoss;
                    }
                }

                if (this.config.skipSellingIfLostMoreThan > 0) {
                    const stopSellingFraction = this.config.quoteAmount
                        .mul(100 - this.config.skipSellingIfLostMoreThan)
                        .numerator.div(new BN(100));

                    const stopSellingAmount = new TokenAmount(this.config.quoteToken, stopSellingFraction, true);

                    if (amountOut.lt(stopSellingAmount)) {
                        logger.info(
                            { mint: poolKeys.baseMint.toString() },
                            `Token dropped more than ${this.config.skipSellingIfLostMoreThan}%, sell stopped. Initial: ${this.config.quoteAmount.toFixed()} | Current: ${amountOut.toFixed()}`,
                        );

                        await this.messaging.sendTelegramMessage(`🚨RUG RUG RUG🚨\n\nMint <code>${poolKeys.baseMint.toString()}</code>\nToken dropped more than ${this.config.skipSellingIfLostMoreThan}%, sell stopped\nInitial: <code>${this.config.quoteAmount.toFixed()}</code>\nCurrent: <code>${amountOut.toFixed()}</code>`, poolKeys.baseMint.toString())

                        this.stopLoss.delete(poolKeys.baseMint.toString());
                        return false;
                    }
                }

                logger.debug(
                    { mint: poolKeys.baseMint.toString() },
                    `${timesChecked}/${timesToCheck} Take profit: ${takeProfit.toFixed()} | Stop loss: ${stopLoss.toFixed()} | Current: ${amountOut.toFixed()}`,
                );

                if (amountOut.lt(stopLoss)) {
                    this.stopLoss.delete(poolKeys.baseMint.toString());
                    break;
                }

                if (amountOut.gt(takeProfit)) {
                    this.stopLoss.delete(poolKeys.baseMint.toString());
                    break;
                }

                await sleep(this.config.priceCheckInterval);
            } catch (e) {
                logger.trace({ mint: poolKeys.baseMint.toString(), e }, `Failed to check token price`);
            } finally {
                timesChecked++;
            }
        } while (timesChecked < timesToCheck);

        return true;
    }
}