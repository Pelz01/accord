import { readFile, writeFile } from 'node:fs/promises';
import { Account, JsonRpcProvider, nearToYocto, type KeyPairString } from 'near-api-js';
import { signMessage } from 'near-api-js/nep413';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import type { Deployment, ChainOrder, ChainAttempt } from '../shared/chain.ts';

const d = JSON.parse(await readFile('.data/deployment.json', 'utf8')) as Deployment;
if (d.network !== 'testnet') throw new Error('Testnet only.');
const credentials = JSON.parse(await readFile('.data/testnet-credentials.json', 'utf8')) as {
  accounts: Record<string, { accountId: string; secretKey: KeyPairString }>;
};
const provider = new JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' });
const a = Object.fromEntries(
  Object.entries(credentials.accounts).map(([n, c]) => [
    n,
    new Account(c.accountId, provider, c.secretKey),
  ]),
);
const orderId = 'PO-WORKER-001';
const call = (
  actor: Account,
  target: string,
  methodName: string,
  args: Record<string, unknown>,
  deposit = 0n,
) =>
  actor.callFunctionRaw({
    contractId: target,
    methodName,
    args,
    deposit,
    gas: 150_000_000_000_000n,
    waitUntil: 'FINAL',
  });
async function readOrder() {
  return provider.callFunction<ChainOrder>({
    contractId: d.vault,
    method: 'get_order',
    args: { order_id: orderId },
  });
}
let o = await readOrder();
if (!o) {
  await call(
    a.buyer,
    d.vault,
    'create_order',
    {
      order_id: orderId,
      terms: {
        supplier: a.supplier.accountId,
        receiver: a.receiver.accountId,
        operator: a.operator.accountId,
        payout: a.supplier.accountId,
        line_id: 'cartons',
        description: 'Fictitious worker verification cartons',
        unit: 'carton',
        ordered: '100',
        unit_price: '10000000',
        expires_at: (BigInt(Date.now() + 7 * 86400000) * 1_000_000n).toString(),
      },
    },
    nearToYocto('1'),
  );
  o = await readOrder();
}
if (!o) throw new Error('Order missing after creation.');
if (!o.accepted_terms)
  await call(a.supplier, d.vault, 'accept_order', { order_id: orderId, terms_hash: o.terms_hash });
o = await readOrder();
if (o?.funded === '0')
  await call(
    a.buyer,
    d.token,
    'ft_transfer_call',
    { receiver_id: d.vault, amount: '1000000000', msg: orderId },
    1n,
  );
o = await readOrder();
if (o?.accepted === '0')
  await call(a.receiver, d.vault, 'confirm_delivery', {
    order_id: orderId,
    sequence: '1',
    cumulative_quantity: '40',
    receipt_hash: 'c'.repeat(64),
  });
o = await readOrder();
if (o?.paid === '40') {
  const jobs = (await (await fetch('http://127.0.0.1:3001/api/chain/jobs')).json()).jobs;
  const job = jobs.find(
    (j: { orderId: string; status: string; quantity: string }) =>
      j.orderId === orderId && j.status === 'settled' && j.quantity === '40',
  );
  assert.ok(
    job?.transactionHash,
    'Wait for the worker to store the final receipt before rerunning.',
  );
  const attempt = await provider.callFunction<ChainAttempt>({
    contractId: d.vault,
    method: 'get_attempt',
    args: { request_id: job.id },
  });
  assert.equal(attempt?.status, 'Settled');
  assert.equal(o.pending, '0');
  try {
    await readFile('.data/worker-evidence.json');
  } catch {
    await writeFile(
      '.data/worker-evidence.json',
      JSON.stringify(
        {
          network: 'testnet',
          at: new Date().toISOString(),
          vault: d.vault,
          orderId,
          requestId: job.id,
          transactionHash: job.transactionHash,
          checks: [
            'existing authenticated worker job verified',
            'onchain attempt settled',
            '40 cartons paid and pending zero',
            'final transaction hash recovered from durable job',
          ],
          paid: o.paid,
          pending: o.pending,
        },
        null,
        2,
      ),
    );
  }
  console.log(`PASS existing authenticated worker payment: ${job.transactionHash}`);
  process.exit(0);
}
async function post(path: string, body: unknown) {
  const response = await fetch(`http://127.0.0.1:3001/api/chain${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}
const challenge = await post('/challenge', {
  orderId,
  quantity: '40',
  auditHash: createHash('sha256').update('fictitious worker invoice').digest('hex'),
});
assert.equal(challenge.status, 200);
const payload = {
  message: challenge.body.message,
  recipient: challenge.body.recipient,
  nonce: Buffer.from(challenge.body.nonce, 'base64'),
};
async function signature(actor: Account) {
  const s = await signMessage({ signerAccount: actor, payload });
  return {
    challengeId: challenge.body.id,
    accountId: s.accountId,
    publicKey: s.publicKey.toString(),
    signature: Buffer.from(s.signature).toString('base64'),
  };
}
const unauthorized = await post('/submit', await signature(a.buyer));
assert.equal(unauthorized.status, 403);
console.log('PASS buyer signature cannot authorize an operator job');
const signed = await signature(a.operator);
const tampered = await post('/submit', {
  ...signed,
  signature: Buffer.alloc(64).toString('base64'),
});
assert.equal(tampered.status, 403);
console.log('PASS invalid operator signature rejected');
const authorized = await post('/submit', signed);
assert.equal(authorized.status, 200);
console.log(`Operator job queued: ${authorized.body.id}`);
const replay = await post('/submit', signed);
assert.equal(replay.status, 409);
console.log('PASS one-time signed challenge cannot be replayed');
let attempt: ChainAttempt | undefined;
for (let i = 0; i < 45; i++) {
  attempt = await provider.callFunction<ChainAttempt>({
    contractId: d.vault,
    method: 'get_attempt',
    args: { request_id: authorized.body.id },
  });
  if (attempt?.status === 'Settled') break;
  await new Promise((resolve) => setTimeout(resolve, 2000));
}
assert.equal(attempt?.status, 'Settled');
o = await readOrder();
assert.equal(o?.paid, '40');
assert.equal(o.pending, '0');
let job: { transactionHash: string | null } | undefined;
for (let i = 0; i < 30; i++) {
  const jobs = (await (await fetch('http://127.0.0.1:3001/api/chain/jobs')).json()).jobs;
  job = jobs.find((j: { id: string }) => j.id === authorized.body.id);
  if (job?.transactionHash) break;
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
assert.ok(job);
assert.ok(job.transactionHash);
const proof = {
  network: 'testnet',
  at: new Date().toISOString(),
  vault: d.vault,
  orderId,
  requestId: authorized.body.id,
  transactionHash: job.transactionHash,
  checks: [
    'buyer signature rejected',
    'invalid operator signature rejected',
    'valid NEP-413 signature accepted',
    'challenge replay rejected',
    'durable worker dispatched with restricted key',
    'real token payment settled and pending released',
  ],
  paid: o.paid,
  pending: o.pending,
};
await writeFile('.data/worker-evidence.json', JSON.stringify(proof, null, 2));
console.log(`PASS durable signed operator job settled 400 aUSD: ${job.transactionHash}`);
