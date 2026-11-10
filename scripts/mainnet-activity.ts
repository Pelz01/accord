import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { accountSchema } from '../shared/schema.ts';
import { nativeDisplay } from '../shared/mainnet-readiness.ts';

// Read-only public evidence. No keys, signing, transaction broadcast or swap API.
const account = accountSchema.parse(process.argv[2]);
const endpoints = ['https://rpc.fastnear.com', 'https://rpc.mainnet.near.org'];
async function json(url: string, init?: RequestInit) {
  const response = await fetch(url, { ...init, signal: AbortSignal.timeout(20000) });
  assert(response.ok, `Read failed: ${url} (${response.status})`);
  return response.json();
}
async function rpc(url: string, method: string, params: unknown) {
  const value = await json(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'accord-public-activity', method, params }),
  });
  assert(!value.error && value.result, `RPC read failed: ${method}`);
  return value.result;
}
const snapshots = await Promise.all(
  endpoints.map(async (endpoint) => {
    const [status, state] = await Promise.all([
      rpc(endpoint, 'status', []),
      rpc(endpoint, 'query', {
        request_type: 'view_account',
        account_id: account,
        finality: 'final',
      }),
    ]);
    assert.equal(status.chain_id, 'mainnet');
    return {
      endpoint,
      blockHeight: state.block_height,
      blockHash: state.block_hash,
      amountYocto: state.amount as string,
      amountNear: nativeDisplay(BigInt(state.amount)),
      stakingLockedYocto: state.locked as string,
      storageBytes: state.storage_usage,
      codeHash: state.code_hash as string,
    };
  }),
);
assert.equal(
  snapshots[0].amountYocto,
  snapshots[1].amountYocto,
  'Provider balances differ; review before reporting.',
);
assert.equal(snapshots[0].codeHash, snapshots[1].codeHash, 'Provider code hashes differ.');
const base = `https://api.nearblocks.io/v1/account/${encodeURIComponent(account)}/txns`;
const index = await json(`${base}?per_page=25&order=desc`);
const counted = await json(`${base}/count`);
const count = Number(counted.txns?.[0]?.count);
assert(
  Number.isSafeInteger(count) && count >= 0 && count <= 25,
  'History requires pagination; this report refuses partial coverage.',
);
assert.equal(index.txns.length, count, 'Indexer count/history disagree.');
const receipts = index.txns as {
  transaction_hash: string;
  predecessor_account_id: string;
  receiver_account_id: string;
}[];
const txHashes = [...new Set(receipts.map((row) => row.transaction_hash))];
const transactions = await Promise.all(
  txHashes.map(async (hash) => {
    const indexed = receipts.find((row) => row.transaction_hash === hash)!;
    const tx = await rpc(endpoints[0], 'tx', {
      tx_hash: hash,
      sender_account_id: indexed.predecessor_account_id,
      wait_until: 'FINAL',
    });
    assert.equal(tx.final_execution_status, 'FINAL');
    assert.equal(tx.transaction.hash, hash);
    const fee = [tx.transaction_outcome, ...tx.receipts_outcome].reduce(
      (sum: bigint, row: { outcome: { tokens_burnt: string } }) =>
        sum + BigInt(row.outcome.tokens_burnt),
      0n,
    );
    return {
      hash,
      signer: tx.transaction.signer_id as string,
      receiver: tx.transaction.receiver_id as string,
      actions: tx.transaction.actions,
      status: tx.status,
      relevantReceipts: receipts
        .filter((row) => row.transaction_hash === hash)
        .map((row) => ({
          predecessor: row.predecessor_account_id,
          receiver: row.receiver_account_id,
        })),
      outcomeTokensBurntYocto: fee.toString(),
      explorer: `https://nearblocks.io/txns/${hash}`,
    };
  }),
);
const outgoingSigned = transactions.filter((tx) => tx.signer === account);
const outgoingReceipts = receipts.filter((row) => row.predecessor_account_id === account);
const report = {
  checkedAt: new Date().toISOString(),
  account,
  network: 'mainnet',
  snapshots,
  indexer: {
    historyUrl: `${base}?per_page=25&order=desc`,
    countUrl: `${base}/count`,
    indexedReceiptCount: count,
    allIndexedRowsRead: true,
  },
  transactions,
  outgoingSignedTransactionCount: outgoingSigned.length,
  outgoingActionReceiptCount: outgoingReceipts.length,
  observedNoOutgoingActivity: outgoingSigned.length === 0 && outgoingReceipts.length === 0,
  scope:
    'Public account evidence at these blocks. Indexer completeness is not a cryptographic proof of all historical activity or of which human/agent controlled an account. Fees paid by other senders are separate.',
  transactionsSentByThisScript: 0,
};
await mkdir('.data', { recursive: true });
await writeFile('.data/mainnet-activity-evidence.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
