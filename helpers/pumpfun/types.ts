import { PublicKey } from '@solana/web3.js';

export interface PumpFunPoolState {
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  baseDecimals: number;
  quoteDecimals: number;
  bondingCurve: PublicKey;
  associatedBondingCurve: PublicKey;
  globalAccount: PublicKey;
  feeAccount: PublicKey;
}
