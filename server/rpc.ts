import { JsonRpcProvider, baseEncode } from 'near-api-js';
import { randomUUID } from 'node:crypto';

// Financial decisions and ownership checks must not use optimistic chain state.
export class FinalizedRpcProvider extends JsonRpcProvider {
  receiptTimeoutMs = 15000;
  private rateLimited(error: unknown) {
    // Some public RPC rate-limit replies lose their body in the SDK's error parser.
    return /-429\b|rate limits? exceeded|too many requests|^Unknown RPC error$/i.test(
      error instanceof Error ? error.message : String(error),
    );
  }
  private get fallbackUrl() {
    return this.connection.url === 'https://rpc.fastnear.com'
      ? 'https://rpc.mainnet.near.org'
      : null;
  }
  private async readFallback<T>(
    error: unknown,
    read: (provider: JsonRpcProvider) => Promise<T>,
  ): Promise<T> {
    if (!this.fallbackUrl || !this.rateLimited(error)) throw error;
    return read(new JsonRpcProvider({ url: this.fallbackUrl }));
  }

  override async viewTransactionStatus(
    params: Parameters<JsonRpcProvider['viewTransactionStatus']>[0],
  ) {
    try {
      return await this.finalReceipt(this.connection.url, params);
    } catch (error) {
      if (!this.fallbackUrl || !this.rateLimited(error)) throw error;
      return this.finalReceipt(this.fallbackUrl, params);
    }
  }
  private async finalReceipt(
    url: string,
    params: Parameters<JsonRpcProvider['viewTransactionStatus']>[0],
  ) {
    // An unknown hash can wait indefinitely at an RPC. Bound this read; a timeout
    // means unknown, never failed. The worker can only replay its original bytes.
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        ...Object.fromEntries(
          Object.entries(this.connection.headers ?? {}).map(([k, v]) => [k, String(v)]),
        ),
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: randomUUID(),
        method: 'tx',
        params: {
          tx_hash: typeof params.txHash === 'string' ? params.txHash : baseEncode(params.txHash),
          sender_account_id: params.accountId,
          wait_until: 'FINAL',
        },
      }),
      signal: AbortSignal.timeout(this.receiptTimeoutMs),
    });
    if (response.status === 429) throw new Error('RPC rate limits exceeded.');
    if (!response.ok) throw new Error('Receipt reconciliation is unavailable.');
    const rpc = await response.json();
    if (rpc.error?.code === -429 || /rate limits? exceeded/i.test(rpc.error?.message ?? ''))
      throw new Error('RPC rate limits exceeded.');
    if (
      rpc.error ||
      !rpc.result ||
      rpc.result.final_execution_status !== 'FINAL' ||
      !rpc.result.status
    )
      throw new Error('Final receipt is unavailable.');
    return rpc.result as Awaited<ReturnType<JsonRpcProvider['viewTransactionStatus']>>;
  }
  override async callFunctionRaw(params: Parameters<JsonRpcProvider['callFunctionRaw']>[0]) {
    const final = { ...params, blockQuery: { finality: 'final' as const } };
    try {
      return await super.callFunctionRaw(final);
    } catch (error) {
      return this.readFallback(error, (p) => p.callFunctionRaw(final));
    }
  }

  override async viewAccessKey(params: Parameters<JsonRpcProvider['viewAccessKey']>[0]) {
    const final = { ...params, finalityQuery: { finality: 'final' as const } };
    try {
      return await super.viewAccessKey(final);
    } catch (error) {
      return this.readFallback(error, (p) => p.viewAccessKey(final));
    }
  }
  override async viewAccount(params: Parameters<JsonRpcProvider['viewAccount']>[0]) {
    const final = { ...params, blockQuery: { finality: 'final' as const } };
    try {
      return await super.viewAccount(final);
    } catch (error) {
      return this.readFallback(error, (p) => p.viewAccount(final));
    }
  }
}
