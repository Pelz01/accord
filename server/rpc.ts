import { JsonRpcProvider, baseEncode } from 'near-api-js';
import { randomUUID } from 'node:crypto';

// Financial decisions and ownership checks must not use optimistic chain state.
export class FinalizedRpcProvider extends JsonRpcProvider {
  receiptTimeoutMs = 15000;

  override async viewTransactionStatus(
    params: Parameters<JsonRpcProvider['viewTransactionStatus']>[0],
  ) {
    // An unknown hash can wait indefinitely at an RPC. Bound this read; a timeout
    // means unknown, never failed. The worker can only replay its original bytes.
    const response = await fetch(this.connection.url, {
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
    if (!response.ok) throw new Error('Receipt reconciliation is unavailable.');
    const rpc = await response.json();
    if (
      rpc.error ||
      !rpc.result ||
      rpc.result.final_execution_status !== 'FINAL' ||
      !rpc.result.status
    )
      throw new Error('Final receipt is unavailable.');
    return rpc.result as Awaited<ReturnType<JsonRpcProvider['viewTransactionStatus']>>;
  }
  override callFunctionRaw(params: Parameters<JsonRpcProvider['callFunctionRaw']>[0]) {
    return super.callFunctionRaw({ ...params, blockQuery: { finality: 'final' } });
  }

  override viewAccessKey(params: Parameters<JsonRpcProvider['viewAccessKey']>[0]) {
    return super.viewAccessKey({ ...params, finalityQuery: { finality: 'final' } });
  }
}
