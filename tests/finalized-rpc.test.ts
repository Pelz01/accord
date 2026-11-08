import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { FinalizedRpcProvider } from '../server/rpc.ts';

test('contract reads and NEP-413 ownership checks query finalized state even if optimistic is requested', async () => {
  const queries: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    queries.push(rpc.params);
    const result =
      rpc.params.request_type === 'view_access_key'
        ? { nonce: 1, permission: 'FullAccess', block_hash: '1'.repeat(32), block_height: 1 }
        : {
            result: [...Buffer.from('{"paid":"4","pending":"0"}')],
            logs: [],
            block_hash: '1'.repeat(32),
            block_height: 1,
          };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const provider = new FinalizedRpcProvider({ url: `http://127.0.0.1:${address.port}` });
    assert.deepEqual(
      await provider.callFunction({
        contractId: 'vault.testnet',
        method: 'get_order',
        args: { order_id: 'PO-1' },
      }),
      { paid: '4', pending: '0' },
    );
    await provider.callFunctionRaw({
      contractId: 'vault.testnet',
      method: 'get_order',
      args: {},
      blockQuery: { finality: 'optimistic' },
    });
    await provider.viewAccessKey({
      accountId: 'buyer.testnet',
      publicKey: 'ed25519:' + '1'.repeat(32),
      finalityQuery: { finality: 'optimistic' },
    });
    assert.equal(queries.length, 3);
    assert.ok(queries.every((query) => query.finality === 'final' && !('block_id' in query)));
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test('unknown transaction receipt reads time out without fabricating failure or blocking recovery', async () => {
  const requests: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const rpc = JSON.parse(Buffer.concat(chunks).toString());
    requests.push(rpc.params);
    if (rpc.params.tx_hash === 'stalled') return;
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        id: rpc.id,
        result: {
          final_execution_status:
            rpc.params.tx_hash === 'unfinished' ? 'EXECUTED_OPTIMISTIC' : 'FINAL',
          status: { SuccessValue: '' },
        },
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const provider = new FinalizedRpcProvider({ url: `http://127.0.0.1:${address.port}` });
    provider.receiptTimeoutMs = 75;
    await assert.rejects(
      provider.viewTransactionStatus({ txHash: 'stalled', accountId: 'operator.testnet' }),
      /timeout|aborted/i,
    );
    await assert.rejects(
      provider.viewTransactionStatus({ txHash: 'unfinished', accountId: 'operator.testnet' }),
      /Final receipt/,
    );
    const final = await provider.viewTransactionStatus({
      txHash: 'settled',
      accountId: 'operator.testnet',
      waitUntil: 'EXECUTED_OPTIMISTIC',
    });
    assert.deepEqual(final.status, { SuccessValue: '' });
    assert.ok(requests.every((p) => p.wait_until === 'FINAL'));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
