import { Liquidity, LiquidityPoolKeysV4, Percent, TokenAmount } from "@raydium-io/raydium-sdk";
import { logger, sleep } from "./helpers";
import { Connection } from "@solana/web3.js";
import { BotConfig } from "./bot";
import { TechnicalAnalysis } from "./technicalAnalysis";
import BN from "bn.js";
import { Messaging } from "./messaging";
import { TechnicalAnalysisCache } from "./cache/technical-analysis.cache";

const EXCLUDED_MONITOR_MINTS = new Set([
    "So11111111111111111111111111111111111111112",
    "11111111111111111111111111111111",
]);

export type SellSignalDecision =
    | { shouldSell: true }
    | { shouldSell: false; reason: "timeout" | "largeLoss" };

export class TradeSignals {

    private readonly TA: TechnicalAnalysis;
    private readonly stopLoss = new Map<string, TokenAmount>();
    private readonly activeSellMonitors = new Map<string, number>();
    private readonly tokensToIncinerate = new Set<string>();

    constructor(
        private readonly connection: Connection,
        readonly config: BotConfig,
        private readonly messaging: Messaging,
        private readonly technicalAnalysisCache: TechnicalAnalysisCache
    ) {
        this.TA = new TechnicalAnalysis(config);
    }

    public getActiveMonitorCount(): number {
        let count = 0;

        for (const mint of this.activeSellMonitors.keys()) {
            if (this.tokensToIncinerate.has(mint)) {
                continue;
            }

            if (EXCLUDED_MONITOR_MINTS.has(mint)) {
                continue;
            }

            if (mint === this.config.quoteToken.mint.toString()) {
                continue;
            }

            count++;
        }

        return count;
    }

    private formatDuration(durationMs: number): string {
        if (durationMs <= 0) {
            return "0s";
        }

        const totalSeconds = Math.floor(durationMs / 1000);
        const hours = Math.floor(totalSeconds / 3600);
        const minutes = Math.floor((totalSeconds % 3600) / 60);
        const seconds = totalSeconds % 60;

        const segments: string[] = [];

        if (hours > 0) {
            segments.push(`${hours}h`);
        }

        if (minutes > 0 || hours > 0) {
            segments.push(`${minutes}m`);
        }

        segments.push(`${seconds}s`);

        return segments.join(" ");
    }

    public async waitForBuySignal(poolKeys: LiquidityPoolKeysV4) {
        
        if(!this.config.useTechnicalAnalysis){
            return true;
        }

        this.technicalAnalysisCache.addNew(poolKeys.baseMint.toString(), poolKeys);

        logger.trace({ mint: poolKeys.baseMint.toString() }, `Waiting for buy signal`);

        const totalTimeToCheck = this.config.buySignalTimeToWait;
        const interval = this.config.buySignalPriceInterval;
        const maxSignalWaitTime = totalTimeToCheck * (this.config.buySignalFractionPercentageTimeToWait / 100)

        //used strategy
        let strategy = 1;

        let startTime = Date.now();
        let timesChecked = 0;

        let previousRSI = null;

        do {
            try {

                let prices = this.technicalAnalysisCache.getPrices(poolKeys.baseMint.toString());

                if(prices == null){
                    continue;
                }

                if (strategy == 1) {
                    let currentRSI = this.TA.calculateRSIv2(prices);
                    let macd = this.TA.calculateMACDv2(prices);

                    if (previousRSI !== currentRSI) {
                        logger.trace({ 
                            mint: poolKeys.baseMint.toString()
                        }, `(${timesChecked}) Waiting for buy signal: RSI: ${currentRSI.toFixed(3)}, MACD: ${macd.macd}, Signal: ${macd.signal}`);
                        previousRSI = currentRSI;
                    }

                    if (((Date.now() - startTime) > maxSignalWaitTime) && prices.length < this.config.buySignalLowVolumeThreshold) {
                        logger.trace(`Not enough volume for signal after ${maxSignalWaitTime / 1000} seconds, skipping buy signal`);
                        return false;
                    }

                    if (((Date.now() - startTime) > maxSignalWaitTime) && currentRSI == 0 && !macd.macd) {
                        logger.trace(`Not enough data for signal after ${maxSignalWaitTime / 1000} seconds, skipping buy signal`);
                        return false;
                    }

                    if (currentRSI > 0 && currentRSI < 30 && macd.macd && macd.signal && macd.macd > macd.signal) {
                        logger.trace("RSI is less than 30, macd + signal = long, sending buy signal");
                        return true;
                    }
                }

                if (strategy == 2) {
                    let { RSI, RSI_EMA_11, RSI_prevEMA_11 } = this.TA.calculateRSIv3(prices, 14);
                    let macd = this.TA.calculateMACDv2(prices, 8, 15, 6);
                    let { EMA_3, EMA_18, prevEMA_3 } = this.TA.calculateEMAs(prices);

                    let isMacdAboveSignal = macd.macd > macd.signal;
                    let isEmaLAboveTokenPrice = EMA_18 > prices[prices.length - 1];
                    let isEmaSAbovePrevEmaS = EMA_3 > prevEMA_3;

                    if (previousRSI !== RSI) {
                        logger.trace({
                            mint: poolKeys.baseMint.toString()
                        }, `(${timesChecked}) Waiting for buy signal: RSI: ${RSI.toFixed(3)}, RSI_EMA_11: ${RSI_EMA_11.toFixed(3)}, RSI_EMA_11 > RSI_EMA_11[-1]: ${RSI_prevEMA_11 < RSI_EMA_11}, macd>signal: ${isMacdAboveSignal}, price<ema_18: ${isEmaLAboveTokenPrice}, ema_3>ema_3[-1]: ${isEmaSAbovePrevEmaS}`);
                        previousRSI = RSI;
                    }

                    if (((Date.now() - startTime) > maxSignalWaitTime) && prices.length < this.config.buySignalLowVolumeThreshold) {
                        logger.trace(`Not enough volume for signal after ${maxSignalWaitTime / 1000} seconds, skipping buy signal`);
                        return false;
                    }

                    if (((Date.now() - startTime) > maxSignalWaitTime) && RSI == 0 && !macd.macd) {
                        logger.trace(`Not enough data for signal after ${maxSignalWaitTime / 1000} seconds, skipping buy signal`);
                        return false;
                    }

                    if (RSI > 0 && RSI < 50 && RSI_EMA_11 < 30 && RSI_prevEMA_11 < RSI_EMA_11 && macd.macd && macd.signal && macd.macd > macd.signal && EMA_18 > prices[prices.length - 1] && EMA_3 > prevEMA_3) {
                        logger.trace("RSI is less than 30, macd + signal = long, and EMAs going mad, sending buy signal");
                        return true;
                    }
                }

            } catch (e) {
                logger.trace({ mint: poolKeys.baseMint.toString(), e }, `Failed to check token price`);
                continue;
            } finally {
                timesChecked++;
                await sleep(interval);
            }
        } while ((Date.now() - startTime) < totalTimeToCheck);

        return false;
    }


    public async waitForSellSignal(amountIn: TokenAmount, poolKeys: LiquidityPoolKeysV4): Promise<SellSignalDecision> {
        this.technicalAnalysisCache.markAsDone(poolKeys.baseMint.toString());

        const infiniteCheck = this.config.priceCheckDuration === 0;
        if (this.config.priceCheckInterval === 0) {
            return { shouldSell: true };
        }

        const timesToCheck = infiniteCheck ? Number.POSITIVE_INFINITY : this.config.priceCheckDuration / this.config.priceCheckInterval;
        const profitFraction = this.config.quoteAmount.mul(this.config.takeProfit).numerator.div(new BN(100));
        const profitAmount = new TokenAmount(this.config.quoteToken, profitFraction, true);
        const takeProfit = this.config.quoteAmount.add(profitAmount);
        let stopLoss: TokenAmount | null = null;

        if (this.config.stopLoss > 0) {
            if (!this.stopLoss.get(poolKeys.baseMint.toString())) {
                const lossFraction = this.config.quoteAmount.mul(this.config.stopLoss).numerator.div(new BN(100));
                const lossAmount = new TokenAmount(this.config.quoteToken, lossFraction, true);
                stopLoss = this.config.quoteAmount.subtract(lossAmount);

                this.stopLoss.set(poolKeys.baseMint.toString(), stopLoss);
            } else {
                stopLoss = this.stopLoss.get(poolKeys.baseMint.toString())!;
            }
        }

        const slippage = new Percent(this.config.sellSlippage, 100);
        let timesChecked = 0;
        const mint = poolKeys.baseMint.toString();

        if (this.tokensToIncinerate.has(mint)) {
            logger.debug(
                { mint },
                `Skipping price monitoring because token is scheduled for incineration`,
            );
            this.stopLoss.delete(mint);
            return { shouldSell: false, reason: "largeLoss" };
        }

        const monitorStartTime = this.activeSellMonitors.get(mint) ?? Date.now();
        this.activeSellMonitors.set(mint, monitorStartTime);
        const initialQuoteAmount = parseFloat(this.config.quoteAmount.toFixed());
        //let telegram_status_message_id: number | undefined = undefined;

        try {
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

                    if (this.config.trailingStopLoss && stopLoss) {
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

                    const currentAmountNumber = parseFloat(amountOut.toFixed());
                    const profitOrLossValue = currentAmountNumber - initialQuoteAmount;
                    const percentageChange = initialQuoteAmount === 0
                        ? 0
                        : (profitOrLossValue / initialQuoteAmount) * 100;

                    if (percentageChange <= -90) {
                        this.tokensToIncinerate.add(mint);
                        this.stopLoss.delete(mint);

                        logger.info(
                            {
                                mint,
                                tokensToIncinerate: Array.from(this.tokensToIncinerate.values()),
                            },
                            `Token dropped by ${percentageChange.toFixed(2)}%, excluded from price monitoring. Tokens to incinerate logged separately`,
                        );

                        return { shouldSell: false, reason: "largeLoss" };
                    }

                    if (this.config.skipSellingIfLostMoreThan > 0) {
                        const stopSellingFraction = this.config.quoteAmount
                            .mul(100 - this.config.skipSellingIfLostMoreThan)
                            .numerator.div(new BN(100));

                        const stopSellingAmount = new TokenAmount(this.config.quoteToken, stopSellingFraction, true);
                        const exceededConfiguredLoss = amountOut.lt(stopSellingAmount)
                            || percentageChange <= -this.config.skipSellingIfLostMoreThan;

                        if (exceededConfiguredLoss) {
                            logger.info(
                                { mint: poolKeys.baseMint.toString() },
                                `Token dropped more than ${this.config.skipSellingIfLostMoreThan}%, sell stopped. Initial: ${this.config.quoteAmount.toFixed()} | Current: ${amountOut.toFixed()}`,
                            );

                            await this.messaging.sendTelegramMessage(`🚨RUG RUG RUG🚨\n\nMint <code>${poolKeys.baseMint.toString()}</code>\nToken dropped more than ${this.config.skipSellingIfLostMoreThan}%, sell stopped\nInitial: <code>${this.config.quoteAmount.toFixed()}</code>\nCurrent: <code>${amountOut.toFixed()}</code>`, poolKeys.baseMint.toString())

                            this.stopLoss.delete(poolKeys.baseMint.toString());
                            return { shouldSell: false, reason: "largeLoss" };
                        }
                    }
                    const statusLabel = profitOrLossValue >= 0 ? "🟢Profit" : "🔴Loss";
                    const signedAmount = `${profitOrLossValue >= 0 ? "+" : "-"}${Math.abs(profitOrLossValue).toFixed(5)} ${this.config.quoteToken.symbol}`;
                    const elapsed = this.formatDuration(Date.now() - monitorStartTime);
                    const monitoringCount = this.getActiveMonitorCount();
                    const progress = infiniteCheck ? `${timesChecked + 1}/∞` : `${timesChecked + 1}/${timesToCheck}`;
                    const stopLossSection = stopLoss ? `Stop loss: ${stopLoss.toFixed()}` : undefined;

                    const messageParts = [
                        `${progress} Take profit: ${takeProfit.toFixed()}`,
                        `Current: ${amountOut.toFixed()}`,
                        `${statusLabel} ${signedAmount} (${percentageChange.toFixed(2)}%)`,
                        `Active: ${elapsed}`,
                        `Tokens monitored (ex. SOL/WSOL): ${monitoringCount}`,
                    ];

                    if (stopLossSection) {
                        messageParts.splice(1, 0, stopLossSection);
                    }

                    logger.debug(
                        { mint: poolKeys.baseMint.toString() },
                        messageParts.join(" | "),
                    );

                    if (stopLoss && amountOut.lt(stopLoss)) {
                        this.stopLoss.delete(poolKeys.baseMint.toString());
                        return { shouldSell: true };
                    }

                    if (amountOut.gt(takeProfit)) {
                        this.stopLoss.delete(poolKeys.baseMint.toString());
                        return { shouldSell: true };
                    }

                    await sleep(this.config.priceCheckInterval);
                } catch (e) {
                    logger.trace({ mint: poolKeys.baseMint.toString(), e }, `Failed to check token price`);
                } finally {
                    timesChecked++;
                }
            } while (timesChecked < timesToCheck);


            if (this.config.autoSellWithoutSellSignal) {
                return { shouldSell: true };
            } else {
                await this.messaging.sendTelegramMessage(`🚫NO SELL🚫\n\nMint <code>${poolKeys.baseMint.toString()}</code>\nTime ran out, sell stopped, you're a bagholder now`, poolKeys.baseMint.toString())
                return { shouldSell: false, reason: "timeout" };
            }
        } finally {
            this.activeSellMonitors.delete(mint);
        }
    }
}