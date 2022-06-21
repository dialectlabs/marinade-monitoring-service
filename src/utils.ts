import { LAMPORTS_PER_SOL } from '@solana/web3.js';
import JSBI from 'jsbi';

export function format5Dec(balance: number, divisor?: number): string {
  return balance === null
    ? '0'
    : (Math.round((balance / (divisor || 1)) * 1e5) / 1e5).toString();
}

export function LamportsToSol(amount: JSBI): number {
  return (
    JSBI.toNumber(
      JSBI.divide(
        amount,
        JSBI.divide(JSBI.BigInt(LAMPORTS_PER_SOL), JSBI.BigInt(10000)),
      ),
    ) / 10000
  );
}
