import { BotConfig } from "./bot";

export class TechnicalAnalysis {    
    constructor(public botConfig: BotConfig) { }
        
    public calculateEMAs = (prices: number[]): { emaS: number, emaL: number, prevEmaS: number } => {
        const shortPeriod = 4;
        const longPeriod = 24;

        if (prices.length < longPeriod - 1) {
            return { emaS: null, emaL: null, prevEmaS: null };
        }

        const shortMultiplier = 2 / (shortPeriod + 1);
        const longMultiplier = 2 / (longPeriod + 1);

        let shortEMA = prices.slice(0, shortPeriod).reduce((acc, val) => acc + val, 0) / shortPeriod;
        let longEMA = prices.slice(0, longPeriod).reduce((acc, val) => acc + val, 0) / longPeriod;

        let prevEmaS = shortEMA;

        prices.forEach(price => {
            prevEmaS = shortEMA;
            shortEMA = (price - shortEMA) * shortMultiplier + shortEMA;
            longEMA = (price - longEMA) * longMultiplier + longEMA;
        });

        return {
            emaS: shortEMA,
            emaL: longEMA,
            prevEmaS: prevEmaS
        };
    }

    public calculateMACDv2 = (prices: number[]): { macd: number, signal: number } => {
        const shortPeriod = this.botConfig.MACDShortPeriod;
        const longPeriod = this.botConfig.MACDLongPeriod;
        const signalPeriod = this.botConfig.MACDSignalPeriod;

        if (prices.length < longPeriod + signalPeriod - 1) {
            return { macd: null, signal: null };
        }

        // Calculate short and long EMAs
        const shortMultiplier = 2 / (shortPeriod + 1);
        const longMultiplier = 2 / (longPeriod + 1);

        let shortEMA = prices.slice(0, shortPeriod).reduce((acc, val) => acc + val, 0) / shortPeriod;
        let longEMA = prices.slice(0, longPeriod).reduce((acc, val) => acc + val, 0) / longPeriod;

        const macdLine: number[] = [];
        for (let i = longPeriod; i < prices.length; i++) {
            shortEMA = (prices[i] - shortEMA) * shortMultiplier + shortEMA;
            longEMA = (prices[i] - longEMA) * longMultiplier + longEMA;

            const macdValue = shortEMA - longEMA;
            macdLine.push(macdValue);
        }

        // Initialize signal line with a simple average of the first MACD values
        let sum = 0;
        for (let i = 0; i < signalPeriod; i++) {
            sum += macdLine[i];
        }
        let signalEMA = sum / signalPeriod;
        const signal: number[] = [signalEMA]; // Initialize with the first signal value

        // Calculate signal line (9-period EMA of MACD)
        const signalMultiplier = 2 / (signalPeriod + 1);
        for (let i = signalPeriod; i < macdLine.length; i++) {
            signalEMA = (macdLine[i] - signalEMA) * signalMultiplier + signalEMA;
            signal.push(signalEMA);
        }

        return {
            macd: macdLine[macdLine.length - 1],
            signal: signal[signal.length - 1]
        };
    }


    public calculateRSIv2 = (prices: number[]): number => {
        const period = this.botConfig.RSIPeriod;
        const delta: number[] = [];
        let gainSum = 0;
        let lossSum = 0;

        for (let i = 1; i < prices.length; i++) {
            delta.push(prices[i] - prices[i - 1]);
        }

        for (let i = 0; i < period; i++) {
            if (delta[i] > 0) {
                gainSum += delta[i];
            } else {
                lossSum += Math.abs(delta[i]);
            }
        }

        const initialAvgGain = gainSum / period;
        const initialAvgLoss = lossSum / period;

        let prevAvgGain = initialAvgGain;
        let prevAvgLoss = initialAvgLoss;

        let cRSI = 0;

        for (let i = period; i < prices.length; i++) {
            const gain = delta[i] > 0 ? delta[i] : 0;
            const loss = delta[i] < 0 ? Math.abs(delta[i]) : 0;

            const avgGain = ((prevAvgGain * (period - 1)) + gain) / period;
            const avgLoss = ((prevAvgLoss * (period - 1)) + loss) / period;

            const RS = avgGain / avgLoss;
            cRSI = 100 - (100 / (1 + RS));

            prevAvgGain = avgGain;
            prevAvgLoss = avgLoss;
        }

        return cRSI;
    }


}