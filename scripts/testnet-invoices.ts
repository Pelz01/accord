import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Account, JsonRpcProvider, actions, type KeyPairString } from 'near-api-js';
import { signMessage } from 'near-api-js/nep413';
import type { ChainOrder, ChainJob, ChainRecovery, Deployment } from '../shared/chain.ts';
import type { InvoicePayload, SavedInvoice, InvoiceConfirmation } from '../shared/invoices.ts';
import { invoiceCommitment } from '../shared/invoices.ts';

const website = 'https://accord-payments.vercel.app';
const d = JSON.parse(await readFile('.data/deployment.json', 'utf8')) as Deployment;
assert.equal(d.network, 'testnet');
assert.equal(d.rpcUrl, 'https://test.rpc.fastnear.com');
const provider = new JsonRpcProvider({ url: d.rpcUrl });
const credentials = JSON.parse(await readFile('.data/testnet-credentials.json', 'utf8')) as {
  accounts: Record<string, { accountId: string; secretKey: KeyPairString }>;
};
const accounts = Object.fromEntries(
  Object.entries(credentials.accounts).map(([role, key]) => [
    role,
    new Account(key.accountId, provider, key.secretKey),
  ]),
);
const { vault, supplier, receiver, operator, token } = accounts;
assert.equal(vault.accountId, d.vault);
assert.equal(operator.accountId, d.operator);
const bytes = await readFile('.data/wasm/vault.wasm');
const sha = (input: Uint8Array | string) => createHash('sha256').update(input).digest('hex');
const expected = sha(bytes);
for (const [name, count] of [
  ['sandbox-evidence', 9],
  ['recovery-sandbox-evidence', 11],
  ['invoice-sandbox-evidence', 9],
] as const) {
  const p = JSON.parse(await readFile('.data/' + name + '.json', 'utf8'));
  assert.equal(p.wasmSha256.vault, expected);
  assert.equal(p.checks.length, count);
  assert.ok(p.checks.every((c: { status: string }) => c.status === 'PASS'));
}
type Proof = {
  network: 'testnet';
  at: string;
  vault: string;
  wasmSha256: string;
  checks: string[];
  transactions: { label: string; hash: string }[];
  documents?: { name: string; sha256: string; source: string; id: string }[];
  commitment?: string;
  requestId?: string;
  paymentTransaction?: string;
  providerRequestIds?: string[];
  finalPaid?: string;
};
let proof: Proof;
try {
  proof = JSON.parse(await readFile('.data/invoice-release-evidence.json', 'utf8'));
  assert.equal(proof.wasmSha256, expected);
} catch {
  proof = {
    network: 'testnet',
    at: new Date().toISOString(),
    vault: d.vault,
    wasmSha256: expected,
    checks: [],
    transactions: [],
  };
}
const persist = () =>
  writeFile('.data/invoice-release-evidence.json', JSON.stringify(proof, null, 2) + '\n');
function check(message: string) {
  if (!proof.checks.includes(message)) proof.checks.push(message);
}
async function view<T>(method: string, args: Record<string, unknown> = {}): Promise<T> {
  const result = await provider.callFunction({ contractId: d.vault, method, args });
  assert.notEqual(result, undefined);
  return result as T;
}
async function call(account: Account, method: string, args: Record<string, unknown>) {
  const result = await account.callFunctionRaw({
    contractId: d.vault,
    methodName: method,
    args,
    gas: 150_000_000_000_000n,
    deposit: 0n,
    waitUntil: 'FINAL',
  });
  assert.ok(
    typeof result.status === 'object' && 'SuccessValue' in result.status,
    method + ' needs receipt review.',
  );
  proof.transactions.push({ label: method, hash: result.transaction.hash });
  await persist();
  return result;
}
async function http(path: string, body?: unknown, authorization?: string) {
  const response = await fetch(website + '/api/chain' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      Origin: website,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(authorization ? { Authorization: 'Bearer ' + authorization } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(55000),
  });
  return { status: response.status, body: await response.json() };
}
async function sign(
  account: Account,
  c: { id: string; message: string; nonce: string; recipient: string },
) {
  const result = await signMessage({
    signerAccount: account,
    payload: { message: c.message, nonce: Buffer.from(c.nonce, 'base64'), recipient: c.recipient },
  });
  return {
    challengeId: c.id,
    accountId: result.accountId,
    publicKey: result.publicKey.toString(),
    signature: Buffer.from(result.signature).toString('base64'),
  };
}
async function session(account: Account) {
  const c = await http('/session/challenge', { accountId: account.accountId });
  assert.equal(c.status, 200);
  const accepted = await http('/session', await sign(account, c.body));
  assert.equal(accepted.status, 200);
  return accepted.body.token as string;
}

async function main() {
  let code = await provider.viewContractCode({ contractId: d.vault });
  if (sha(code.code) !== expected) {
    assert.equal(sha(code.code), d.wasmSha256.vault, 'Unexpected contract code.');
    const orders = await view<ChainOrder[]>('list_orders', { limit: 50 });
    assert.ok(orders.every((o) => o.pending === '0' && o.buyer === d.accounts.buyer));
    const recoveries = await Promise.all(
      orders.map((o) => view<ChainRecovery>('get_recovery', { order_id: o.id })),
    );
    const balance = await provider.callFunction({
      contractId: d.token,
      method: 'ft_balance_of',
      args: { account_id: d.vault },
    });
    await writeFile('.data/wasm/vault-before-invoices.wasm', code.code);
    await writeFile(
      '.data/invoice-upgrade-snapshot.json',
      JSON.stringify({ orders, recoveries, balance, oldHash: sha(code.code) }, null, 2) + '\n',
    );
    const upgrade = await vault.signAndSendTransaction({
      receiverId: d.vault,
      actions: [
        actions.deployContract(bytes),
        actions.functionCall('get_version', {}, 30_000_000_000_000n, 0n),
      ],
      waitUntil: 'FINAL',
    });
    assert.ok(typeof upgrade.status === 'object' && 'SuccessValue' in upgrade.status);
    proof.transactions.push({ label: 'atomic_invoice_upgrade', hash: upgrade.transaction.hash });
    await persist();
    assert.deepEqual(await view('list_orders', { limit: 50 }), orders);
    assert.deepEqual(
      await Promise.all(orders.map((o) => view('get_recovery', { order_id: o.id }))),
      recoveries,
    );
    assert.equal(
      await provider.callFunction({
        contractId: d.token,
        method: 'ft_balance_of',
        args: { account_id: d.vault },
      }),
      balance,
    );
    check('invoice upgrade preserved all existing orders, recovery states and vault token balance');
  }
  code = await provider.viewContractCode({ contractId: d.vault });
  assert.equal(sha(code.code), expected);
  assert.equal(await view('get_version'), '2.2.0-invoices');
  d.wasmSha256.vault = expected;
  d.features = ['recovery-v1', 'invoice-v1', 'documents-v1'];
  await writeFile('.data/deployment.json', JSON.stringify(d, null, 2) + '\n');
  await writeFile('fixtures/testnet-deployment.json', JSON.stringify(d, null, 2) + '\n');
  await persist();
  if (process.argv.includes('--upgrade-only')) {
    console.log(JSON.stringify({ status: 'UPGRADED', vault: d.vault, wasmSha256: expected }));
    return;
  }
  const publicState = await http('/state');
  assert.equal(publicState.status, 200);
  assert.ok(publicState.body.deployment.features.includes('invoice-v1'));
  const orderId = 'PO-WORKER-001',
    base = '/orders/' + orderId;
  assert.equal((await http(base + '/invoices')).status, 401);
  assert.equal((await http(base + '/documents', { name: 'not-processed' })).status, 401);
  check('invoice files and review records require wallet authorization before processing');
  const auth = await session(operator),
    outsider = await session(token);
  let record: SavedInvoice;
  try {
    record = JSON.parse(await readFile('.data/invoice-live-record.json', 'utf8'));
    assert.equal(
      record.payload.terms_hash,
      (await view<ChainOrder>('get_order', { order_id: orderId })).terms_hash,
    );
  } catch {
    proof.documents = [];
    proof.providerRequestIds = [];
    let last: SavedInvoice | undefined;
    for (const [name, source] of [
      ['invoice-text.pdf', 'pdf-text'],
      ['invoice-scanned.pdf', 'ocr'],
    ] as const) {
      const file = await readFile('fixtures/documents/' + name);
      const upload = await http(
        base + '/documents',
        { name, mediaType: 'application/pdf', bytesBase64: file.toString('base64') },
        auth,
      );
      assert.equal(upload.status, 200, upload.body.error);
      assert.equal(upload.body.documentHash, sha(file));
      assert.equal(upload.body.source, source);
      assert.equal(upload.body.pages, 1);
      const extracted = await http(
        base + '/extract',
        { documentId: upload.body.id, mode: 'live' },
        auth,
      );
      assert.equal(extracted.status, 200, extracted.body.error);
      last = extracted.body as SavedInvoice;
      assert.equal(last.payload.document_hash, sha(file));
      assert.equal(last.payload.order_id, orderId);
      assert.equal(last.payload.reference, 'INV-PDF-001');
      assert.equal(last.payload.quantity, '100');
      assert.equal(last.payload.amount, '1000000000');
      proof.documents.push({ name, sha256: sha(file), source, id: upload.body.id });
      if (last.providerRequestId) proof.providerRequestIds.push(last.providerRequestId);
      await persist();
    }
    assert.ok(last);
    record = last;
    await writeFile('.data/invoice-live-record.json', JSON.stringify(record, null, 2) + '\n');
    check('hosted PDF text and scanned-PDF OCR both feed real NEAR AI extraction');
  }
  assert.ok(record.documentId);
  assert.equal(
    (await http(base + '/documents/' + record.documentId, undefined, outsider)).status,
    403,
  );
  const downloaded = await http(
    base + '/documents/' + record.documentId + '?download=1',
    undefined,
    auth,
  );
  assert.equal(downloaded.status, 200);
  assert.equal(sha(Buffer.from(downloaded.body.bytesBase64, 'base64')), record.documentHash);
  const reviews = await http(base + '/invoices', undefined, auth);
  assert.equal(reviews.status, 200);
  assert.ok(reviews.body.invoices.some((r: SavedInvoice) => r.id === record.id));
  check('original file hash survives private download and unrelated wallets cannot read it');
  const invoice = record.payload,
    commitment = await invoiceCommitment(d.network, d.vault, invoice);
  proof.commitment = commitment;
  let confirmation = await view<InvoiceConfirmation | null>('get_invoice', { commitment });
  if (!confirmation) {
    assert.equal(
      (
        await http('/challenge', {
          orderId,
          quantity: '1',
          auditHash: invoice.document_hash,
          invoice,
        })
      ).status,
      409,
    );
    const rejected = await operator.signAndSendTransaction({
      receiverId: d.vault,
      actions: [
        actions.functionCall(
          'confirm_invoice',
          { order_id: orderId, invoice },
          100_000_000_000_000n,
          0n,
        ),
      ],
      waitUntil: 'FINAL',
      throwOnFailure: false,
    });
    assert.ok(
      typeof rejected.status === 'object' &&
        'Failure' in rejected.status &&
        JSON.stringify(rejected.status).includes('Supplier only'),
    );
    proof.transactions.push({
      label: 'rejected_operator_invoice_confirmation',
      hash: rejected.transaction.hash,
    });
    await call(supplier, 'confirm_invoice', { order_id: orderId, invoice });
    check('only the supplier confirmed the exact extracted fields on testnet');
    confirmation = await view('get_invoice', { commitment });
  }
  assert.ok(confirmation);
  assert.equal(confirmation.supplier, supplier.accountId);
  assert.deepEqual(confirmation.invoice, invoice);
  assert.equal(
    (
      await http('/challenge', {
        orderId,
        quantity: '1',
        auditHash: invoice.document_hash,
        invoice: { ...invoice, reference: 'TAMPERED' },
      })
    ).status,
    409,
  );
  assert.equal(
    (await http('/challenge', { orderId, quantity: '1', auditHash: invoice.document_hash })).status,
    409,
  );
  check('missing or tampered supplier confirmations cannot obtain payment authorization');
  let order = await view<ChainOrder>('get_order', { order_id: orderId });
  if (BigInt(order.accepted) < 80n) {
    assert.deepEqual([order.paid, order.pending], ['70', '0']);
    await call(receiver, 'confirm_delivery', {
      order_id: orderId,
      sequence: (BigInt(order.sequence) + 1n).toString(),
      cumulative_quantity: '80',
      receipt_hash: sha('Invoice release verification: 80 cartons accepted'),
    });
  }
  let jobs = (await http('/jobs')).body.jobs as (ChainJob & { invoice?: InvoicePayload })[];
  let job = jobs.find(
    (j) =>
      j.orderId === orderId &&
      j.quantity === '10' &&
      j.invoice?.document_hash === invoice.document_hash,
  );
  if (!job) {
    order = await view('get_order', { order_id: orderId });
    assert.deepEqual([order.paid, order.pending], ['70', '0']);
    const challenge = await http('/challenge', {
      orderId,
      quantity: '10',
      auditHash: invoice.document_hash,
      invoice,
    });
    assert.equal(challenge.status, 200);
    assert.deepEqual(JSON.parse(challenge.body.message).invoice, invoice);
    const submitted = await http('/submit', await sign(operator, challenge.body));
    assert.equal(submitted.status, 200);
    job = submitted.body;
    proof.requestId = job!.id;
    await persist();
  }
  assert.ok(job);
  proof.requestId = job.id;
  for (let attempt = 0; attempt < 45; attempt++) {
    jobs = (await http('/jobs')).body.jobs;
    job = jobs.find((j) => j.id === proof.requestId);
    assert.ok(job);
    if (job.status === 'settled') break;
    if (job.status === 'failed')
      throw Error('Payment failed. Inspect its receipt before authorizing another request.');
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  assert.equal(job.status, 'settled');
  assert.ok(job.transactionHash);
  proof.paymentTransaction = job.transactionHash;
  order = await view('get_order', { order_id: orderId });
  assert.deepEqual([order.paid, order.pending], ['80', '0']);
  proof.finalPaid = order.paid;
  check(
    'restricted worker settled a real 100 aUSD payment bound to the supplier-confirmed scanned invoice',
  );
  assert.equal(
    (await view<ChainRecovery>('get_recovery', { order_id: 'PO-TESTNET-001' })).refunded,
    '300000000',
  );
  check('previous buyer refund remains unchanged');
  await persist();
  console.log(
    JSON.stringify({
      status: 'PASS',
      commitment,
      paymentTransaction: proof.paymentTransaction,
      paid: order.paid,
      checks: proof.checks,
    }),
  );
}
main().catch((error: unknown) => {
  let message = error instanceof Error ? error.message : 'Invoice release verification failed.';
  for (const key of Object.values(credentials.accounts))
    message = message.replaceAll(key.secretKey, '[REDACTED]');
  console.error(message);
  process.exitCode = 1;
});
