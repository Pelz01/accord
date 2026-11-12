import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { SignedTransaction, encodeTransaction, baseEncode, KeyPair } from 'near-api-js';
assert.equal(process.env.ACCORD_WORKER_ENABLED, 'false');
const d = JSON.parse(await readFile(process.env.ACCORD_DEPLOYMENT_PATH, 'utf8')),
  p = JSON.parse(await readFile('/backups/worker-gas-recovery-evidence.json', 'utf8')),
  key = JSON.parse(await readFile('/run/secrets/operator-key.json', 'utf8'));
assert.equal(key.publicKey, p.replacementPublicKey);
assert.equal(KeyPair.fromString(key.secretKey).getPublicKey().toString(), p.replacementPublicKey);
assert.equal(key.accountId, d.operator);
async function rpc(method, params) {
  const r = await fetch(d.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'accord-requeue-proof', method, params }),
    signal: AbortSignal.timeout(20000),
  });
  assert(r.ok);
  return r.json();
}
const revoked = await rpc('query', {
  request_type: 'view_access_key',
  account_id: d.operator,
  public_key: p.retiredPublicKey,
  finality: 'final',
});
assert(
  revoked.error?.cause?.name === 'UNKNOWN_ACCESS_KEY' ||
    (Number.isSafeInteger(revoked.result?.block_height) &&
      revoked.result?.error === `access key ${p.retiredPublicKey} does not exist while viewing`),
);
async function view(method, args) {
  const r = await rpc('query', {
    request_type: 'call_function',
    account_id: d.vault,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString('base64'),
    finality: 'final',
  });
  assert(!r.error && !r.result.error);
  return JSON.parse(Buffer.from(r.result.result).toString());
}
assert.equal(await view('get_attempt', { request_id: p.requestId }), null);
const order = await view('get_order', { order_id: p.orderId });
assert.equal(order.paid, '0');
assert.equal(order.pending, '0');
assert.equal(order.funded, '20000');
const db = new DatabaseSync(process.env.ACCORD_DATA_PATH);
const row = db.prepare('SELECT payload FROM chain_jobs WHERE id=?').get(p.requestId);
assert(row);
const job = JSON.parse(row.payload);
assert.equal(job.transactionHash, p.originalHash);
assert.equal(job.status, 'unresolved');
assert.equal(job.orderId, p.orderId);
assert.equal(job.quantity, '1');
const signed = SignedTransaction.decode(Buffer.from(job.preparedTransaction, 'base64'));
assert.equal(signed.transaction.publicKey.toString(), p.retiredPublicKey);
assert.equal(signed.transaction.nonce.toString(), p.originalNonce);
assert.equal(
  baseEncode(createHash('sha256').update(encodeTransaction(signed.transaction)).digest()),
  p.originalHash,
);
await writeFile('/backups/worker-gas-original-authorization.private.json', JSON.stringify(job), {
  mode: 0o600,
  flag: 'wx',
});
job.status = 'queued';
job.transactionHash = null;
job.error = null;
delete job.preparedTransaction;
delete job.preparedCodeHash;
job.recovery = {
  previousHash: p.originalHash,
  revokedKey: p.retiredPublicKey,
  revoked: true,
  at: new Date().toISOString(),
};
db.exec('BEGIN IMMEDIATE');
try {
  assert.equal(
    db
      .prepare('UPDATE chain_jobs SET payload=? WHERE id=? AND payload=?')
      .run(JSON.stringify(job), job.id, row.payload).changes,
    1,
  );
  db.exec('COMMIT');
} catch (e) {
  db.exec('ROLLBACK');
  throw e;
} finally {
  db.close();
}
console.log(
  JSON.stringify({
    orderId: p.orderId,
    requestId: p.requestId,
    previousKeyRevoked: true,
    status: 'queued',
    replacementSignatures: 0,
  }),
);
