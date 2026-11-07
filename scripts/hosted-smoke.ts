import { readFile, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Account, JsonRpcProvider, type KeyPairString } from 'near-api-js';
import { signMessage } from 'near-api-js/nep413';
import type { Deployment, ChainOrder, ChainJob, ChainState } from '../shared/chain.ts';
import { invoiceSchema } from '../shared/schema.ts';
import { invoicePayload } from '../shared/invoices.ts';

const website = new URL(process.argv[2] || 'https://accord-payments.vercel.app').origin;
assert.ok(website.startsWith('https://'));
const d = JSON.parse(await readFile('fixtures/testnet-deployment.json', 'utf8')) as Deployment;
assert.equal(d.network, 'testnet');
const provider = new JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' });
const credentials = JSON.parse(await readFile('.data/testnet-credentials.json', 'utf8')) as {
  accounts: Record<string, { accountId: string; secretKey: KeyPairString }>;
};
const operator = new Account(
  credentials.accounts.operator.accountId,
  provider,
  credentials.accounts.operator.secretKey,
);
const receiver = new Account(
  credentials.accounts.receiver.accountId,
  provider,
  credentials.accounts.receiver.secretKey,
);
const supplier = new Account(
  credentials.accounts.supplier.accountId,
  provider,
  credentials.accounts.supplier.secretKey,
);
assert.equal(operator.accountId, d.operator);
const orderId = 'PO-WORKER-001';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const checks: string[] = [];
async function get(path: string) {
  const response = await fetch(website + path, { signal: AbortSignal.timeout(50000) });
  assert.equal(response.status, 200, `GET ${path} failed.`);
  return response.json();
}
async function post(path: string, body: unknown, token?: string) {
  const response = await fetch(website + '/api/chain' + path, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: website,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(50000),
  });
  return { status: response.status, body: await response.json() };
}
async function signed(challenge: {
  id: string;
  message: string;
  recipient: string;
  nonce: string;
}) {
  const result = await signMessage({
    signerAccount: operator,
    payload: {
      message: challenge.message,
      recipient: challenge.recipient,
      nonce: Buffer.from(challenge.nonce, 'base64'),
    },
  });
  return {
    challengeId: challenge.id,
    accountId: result.accountId,
    publicKey: result.publicKey.toString(),
    signature: Buffer.from(result.signature).toString('base64'),
  };
}
const readOrder = async () => {
  const order = await provider.callFunction<ChainOrder>({
    contractId: d.vault,
    method: 'get_order',
    args: { order_id: orderId },
  });
  assert.ok(order, 'The testnet verification order must exist.');
  return order;
};
async function main() {
  const health = await get('/api/health');
  assert.equal(health.ok, true);
  const state = (await get('/api/chain/state')) as ChainState;
  assert.equal(state.configured, true);
  assert.equal(state.authRequired, true);
  assert.equal(state.operatorReady, true);
  assert.equal(state.liveAiAvailable, true);
  assert.equal(state.deployment?.vault, d.vault);
  assert.equal(state.orders.length, 0);
  checks.push(
    'public HTTPS frontend and proxy reach the isolated API',
    'disconnected API contains no order records',
  );
  const protectedInvoice = await post(`/orders/${orderId}/extract`, {
    text: 'Invoice',
    mode: 'live',
  });
  assert.equal(protectedInvoice.status, 401);
  checks.push('invoice processing requires wallet authorization');
  const challenge = await post('/session/challenge', { accountId: operator.accountId });
  assert.equal(challenge.status, 200);
  assert.equal(JSON.parse(challenge.body.message).website, website);
  assert.equal(challenge.body.recipient, 'Accord invoice access');
  const proof = await signed(challenge.body);
  const invalid = await post('/session', {
    ...proof,
    signature: Buffer.alloc(64).toString('base64'),
  });
  assert.equal(invalid.status, 403);
  const session = await post('/session', proof);
  assert.equal(session.status, 200);
  const replay = await post('/session', proof);
  assert.equal(replay.status, 401);
  checks.push(
    'invalid wallet signature rejected',
    'real NEP-413 wallet ownership verified',
    'wallet sign-in replay rejected',
  );
  let order = await readOrder();
  assert.ok(order);
  if (BigInt(order.accepted) < 70n) {
    assert.equal(order.paid, '40');
    assert.equal(order.pending, '0');
    await receiver.callFunctionRaw({
      contractId: d.vault,
      methodName: 'confirm_delivery',
      args: {
        order_id: orderId,
        sequence: (BigInt(order.sequence) + 1n).toString(),
        cumulative_quantity: '70',
        receipt_hash: hash('Hosted integration verification: cumulative receipt of 70 cartons'),
      },
      gas: 100_000_000_000_000n,
      deposit: 0n,
      waitUntil: 'FINAL',
    });
    order = await readOrder();
  }
  assert.ok(BigInt(order.accepted) >= 70n);
  let jobs = (await get('/api/chain/jobs')).jobs as ChainJob[];
  let job = jobs.find((item) => item.orderId === orderId && item.quantity === '30');
  let providerRequestId: string | null = null;
  if (!job) {
    assert.equal(order.paid, '40');
    assert.equal(order.pending, '0');
    const text = `Synthetic hosted verification invoice.\nPurchase order: ${orderId}\nInvoice reference: INV-HOSTED-001\nLine: ${order.terms.line_id}\nQuantity: 100 cartons\nToken: aUSD\nUnit price: 10 aUSD\nTotal: 1000 aUSD\nAmount in six-decimal base units: 1000000000`;
    const extraction = await post(
      `/orders/${orderId}/extract`,
      { text, mode: 'live' },
      session.body.token,
    );
    assert.equal(extraction.status, 200);
    invoiceSchema.parse(extraction.body.invoice);
    assert.equal(extraction.body.mode, 'live');
    assert.equal(extraction.body.invoice.orderId, orderId);
    assert.equal(extraction.body.invoice.quantity, 100);
    assert.equal(extraction.body.documentHash, hash(text));
    providerRequestId = extraction.body.providerRequestId;
    checks.push('real NEAR AI extraction succeeds through Vercel and the VPS');
    const invoice = invoicePayload(order, extraction.body);
    await supplier.callFunctionRaw({
      contractId: d.vault,
      methodName: 'confirm_invoice',
      args: { order_id: orderId, invoice },
      gas: 100_000_000_000_000n,
      deposit: 0n,
      waitUntil: 'FINAL',
    });
    const payment = await post('/challenge', {
      orderId,
      quantity: '30',
      auditHash: extraction.body.documentHash,
      invoice,
    });
    assert.equal(payment.status, 200);
    assert.equal(JSON.parse(payment.body.message).vault, d.vault);
    const authorization = await signed(payment.body);
    const queued = await post('/submit', authorization);
    assert.equal(queued.status, 200);
    assert.ok(queued.body.id);
    job = queued.body as ChainJob;
    const duplicate = await post('/submit', authorization);
    assert.equal(duplicate.status, 409);
    checks.push('one-time payment authorization accepted and replay rejected');
    await writeFile(
      '.data/hosted-checkpoint.json',
      JSON.stringify({ website, orderId, requestId: job.id, providerRequestId }, null, 2),
    );
  } else checks.push('existing hosted request recovered without another payment authorization');
  for (let i = 0; i < 60; i++) {
    jobs = (await get('/api/chain/jobs')).jobs as ChainJob[];
    job = jobs.find((item) => item.id === job!.id)!;
    if (job.status === 'settled' && job.transactionHash) break;
    if (job.status === 'failed')
      throw new Error(
        'Hosted payment failed; inspect its receipt before authorizing another request.',
      );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  assert.equal(job.status, 'settled');
  assert.ok(job.transactionHash);
  order = await readOrder();
  assert.ok(BigInt(order.paid) >= 70n);
  assert.equal(order.pending, '0');
  checks.push(
    'VPS background worker dispatched with the restricted key',
    'real 300 aUSD partial payment settled',
    'at least 70 cartons paid and pending is zero',
  );
  const proofFile = {
    website,
    network: 'testnet',
    at: new Date().toISOString(),
    vault: d.vault,
    orderId,
    requestId: job.id,
    transactionHash: job.transactionHash,
    providerRequestId,
    amountBaseUnits: '300000000',
    paid: order.paid,
    pending: order.pending,
    checks,
  };
  await writeFile('.data/hosted-evidence.json', JSON.stringify(proofFile, null, 2) + '\n');
  console.log(
    JSON.stringify({
      status: 'PASS',
      website,
      orderId,
      transactionHash: job.transactionHash,
      paid: order.paid,
      pending: order.pending,
      checks,
    }),
  );
}
main().catch((error: unknown) => {
  let message = error instanceof Error ? error.message : 'Hosted verification failed.';
  for (const account of Object.values(credentials.accounts))
    message = message.replaceAll(account.secretKey, '[REDACTED]');
  console.error(message);
  process.exitCode = 1;
});
