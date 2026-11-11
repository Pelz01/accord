/** Wallet adapters can return RPC outcomes, envelopes, or just a transaction hash. */
export class WalletReceiptUnavailable extends Error {
  constructor() {
    super(
      'Your wallet returned no usable receipt. The transaction may have been submitted. Check the updated records before approving it again.',
    );
    this.name = 'WalletReceiptUnavailable';
  }
}

export function walletResultHash(value: unknown): string {
  let result: unknown = value;
  for (let depth = 0; depth < 5; depth++) {
    if (Array.isArray(result)) {
      if (result.length !== 1) throw new WalletReceiptUnavailable();
      result = result[0];
      continue;
    }
    if (!result || typeof result !== 'object') break;
    const row = result as Record<string, unknown>;
    const status = row.status;
    if (status && typeof status === 'object' && 'Failure' in status)
      throw new Error(
        'The contract rejected this transaction. Inspect the transaction receipt and refresh.',
      );
    const transaction = row.transaction as { hash?: unknown } | undefined;
    const outcome = row.transaction_outcome as { id?: unknown } | undefined;
    const hash =
      transaction?.hash ?? outcome?.id ?? row.transactionHash ?? row.transaction_hash ?? row.hash;
    if (typeof hash === 'string' && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(hash)) return hash;
    const next =
      row.final_execution_outcome ?? row.final_outcome ?? row.outcome ?? row.result ?? row.outcomes;
    if (next === undefined) break;
    result = next;
  }
  if (typeof result === 'string' && /^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(result)) return result;
  throw new WalletReceiptUnavailable();
}
