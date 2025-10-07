# Compute Cost Example

This document explains how to convert the configured compute budget parameters into an approximate SOL cost for a single transaction when using the default executor.

## Given parameters
- `COMPUTE_UNIT_LIMIT = 101337`
- `COMPUTE_UNIT_PRICE = 421197` micro-lamports per compute unit

## Conversion steps
1. Convert the price from micro-lamports to lamports:
   
   ```
   421197 micro-lamports = 421197 / 1_000_000 ≈ 0.421197 lamports per compute unit
   ```
2. Multiply by the compute unit limit to get the maximum lamports charged for compute budget priority fees:
   
   ```
   0.421197 lamports * 101337 units ≈ 42,682.840389 lamports
   ```
3. Convert lamports to SOL (1 SOL = 1_000_000_000 lamports):
   
   ```
   42,682.840389 lamports ≈ 0.000042682840389 SOL
   ```

Therefore, if a transaction consumes the full configured compute limit, the priority fee component would cost roughly **0.00004268 SOL** in addition to the baseline network fee. Actual spend can be lower if fewer compute units are used.
