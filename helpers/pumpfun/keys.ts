import { PublicKey } from '@solana/web3.js';
import { PumpFunPoolSnapshot } from '../../cache/pool.cache';

export interface PumpFunPoolKeys {
  id: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  baseVault: PublicKey;
  quoteVault: PublicKey;
  bondingCurve: PublicKey;
  associatedBondingCurve: PublicKey;
  globalAccount: PublicKey;
  feeAccount: PublicKey;
  baseDecimals: number;
  quoteDecimals: number;
}

export function createPumpFunPoolKeys(snapshot: PumpFunPoolSnapshot): PumpFunPoolKeys {
  const { state } = snapshot;

  return {
    id: new PublicKey(snapshot.id),
    baseMint: snapshot.baseMint,
    quoteMint: snapshot.quoteMint,
    baseVault: state.baseVault,
    quoteVault: state.quoteVault,
    bondingCurve: state.bondingCurve,
    associatedBondingCurve: state.associatedBondingCurve,
    globalAccount: state.globalAccount,
    feeAccount: state.feeAccount,
    baseDecimals: snapshot.baseDecimals,
    quoteDecimals: snapshot.quoteDecimals,
  };
}
