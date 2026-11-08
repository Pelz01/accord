import { FinalizedRpcProvider } from '../server/rpc.ts';
import { customerApprovalMethods } from '../shared/customer-approval.ts';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { Account, KeyPair, actions, nearToYocto, type KeyPairString } from 'near-api-js';
import type {
  ChainOrder,
  ChainJob,
  ChainRecovery,
  Deployment,
  ChainPaymentPolicy,
} from '../shared/chain.ts';
import type { InvoicePayload } from '../shared/invoices.ts';

const mode = process.argv[2] ?? 'status';
assert.ok(['upgrade', 'verify', 'status'].includes(mode));
const d = JSON.parse(await readFile('.data/deployment.json', 'utf8')) as Deployment;
assert.equal(d.network, 'testnet');
assert.equal(d.rpcUrl, 'https://test.rpc.fastnear.com');
assert.ok(d.vault.endsWith('.testnet') && d.token.endsWith('.testnet'));
const provider = new FinalizedRpcProvider({ url: d.rpcUrl });
const bytes = await readFile('.data/wasm/vault.wasm');
const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
const expected = sha(bytes);
for (const [name, count] of [
  ['sandbox-evidence', 9],
  ['recovery-sandbox-evidence', 11],
  ['invoice-sandbox-evidence', 9],
  ['automatic-sandbox-evidence', 8],
  ['security-sandbox-evidence', 5],
] as const) {
  const evidence = JSON.parse(await readFile('.data/' + name + '.json', 'utf8'));
  assert.equal(evidence.wasmSha256.vault, expected);
  assert.equal(evidence.checks.length, count);
  assert.ok(evidence.checks.every((check: { status: string }) => check.status === 'PASS'));
}
const keys = JSON.parse(await readFile('.data/testnet-credentials.json', 'utf8')) as {
  root: { accountId: string; secretKey: KeyPairString };
  accounts: Record<string, { accountId: string; secretKey: KeyPairString }>;
};
const account = (key: { accountId: string; secretKey: KeyPairString }) =>
  new Account(key.accountId, provider, key.secretKey);
// Customer and deployment fixture credentials only. No operator wallet signing.
let buyer = account(keys.accounts.buyer);
const supplier = account(keys.accounts.supplier),
  vault = account(keys.accounts.vault);
if (mode === 'verify') {
  let fixtureKey: { accountId: string; secretKey: KeyPairString; publicKey: string };
  try {
    fixtureKey = JSON.parse(await readFile('.data/security-buyer.json', 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const pair = KeyPair.fromRandom('ed25519');
    fixtureKey = {
      accountId: 'accord-review-' + randomBytes(4).toString('hex') + '.testnet',
      secretKey: pair.toString(),
      publicKey: pair.getPublicKey().toString(),
    };
    await writeFile('.data/security-buyer.json', JSON.stringify(fixtureKey, null, 2) + '\n', {
      mode: 0o600,
      flag: 'wx',
    });
  }
  buyer = account(fixtureKey);
  try {
    await buyer.getState();
  } catch (error) {
    if (!/does not exist|doesn't exist|unknown_account|AccountDoesNotExist/i.test(String(error)))
      throw error;
    const response = await fetch('https://helper.testnet.near.org/account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        newAccountId: fixtureKey.accountId,
        newAccountPublicKey: fixtureKey.publicKey,
      }),
      signal: AbortSignal.timeout(45000),
    });
    assert.ok(
      response.ok,
      'Testnet faucet did not create the fixture account; its key was retained.',
    );
    await buyer.getState();
  }
}
assert.equal(vault.accountId, d.vault);
type Proof = {
  network: 'testnet';
  at: string;
  wasmSha256: string;
  vault: string;
  orderId: string;
  buyer: string;
  supplier: string;
  transactions: { label: string; actor: string; hash: string }[];
  checks: string[];
  jobs?: ChainJob[];
  final?: unknown;
  beforeUpgrade?: unknown;
  invoiceReuseGuardChecked?: boolean;
};
let proof: Proof;
try {
  proof = JSON.parse(await readFile('.data/security-release-evidence.json', 'utf8'));
  assert.equal(proof.wasmSha256, expected);
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  proof = {
    network: 'testnet',
    at: new Date().toISOString(),
    wasmSha256: expected,
    vault: d.vault,
    orderId: 'PO-REVIEW-' + randomBytes(4).toString('hex').toUpperCase(),
    buyer: buyer.accountId,
    supplier: supplier.accountId,
    transactions: [],
    checks: [],
  };
}
const persist = () =>
  writeFile('.data/security-release-evidence.json', JSON.stringify(proof, null, 2) + '\n');
const check = (message: string) => {
  if (!proof.checks.includes(message)) proof.checks.push(message);
};
async function view<T>(method: string, args: Record<string, unknown> = {}) {
  return (await provider.callFunction({ contractId: d.vault, method, args })) as T;
}
async function call(
  actor: Account,
  contractId: string,
  methodName: string,
  args: Record<string, unknown>,
  deposit = 0n,
) {
  if (contractId === d.vault && customerApprovalMethods.has(methodName)) {
    const id =
      typeof args.order_id === 'string'
        ? args.order_id
        : (await view<{ order_id: string }>('get_attempt', { request_id: args.request_id }))
            .order_id;
    const policy = await view<ChainPaymentPolicy>('get_payment_policy', { order_id: id });
    deposit = policy.mode === 'automatic' ? 1n : 0n;
  }
  const result = await actor.callFunctionRaw({
    contractId,
    methodName,
    args,
    deposit,
    gas: 150_000_000_000_000n,
    waitUntil: 'FINAL',
  });
  assert.ok(
    typeof result.status === 'object' && 'SuccessValue' in result.status,
    'Inspect transaction before any retry: ' + result.transaction.hash,
  );
  proof.transactions.push({
    label: methodName,
    actor: actor.accountId,
    hash: result.transaction.hash,
  });
  await persist();
}
const order = () => view<ChainOrder | null>('get_order', { order_id: proof.orderId });
async function jobs() {
  const response = await fetch('https://accord-payments.vercel.app/api/chain/jobs');
  assert.equal(response.status, 200);
  const result = (await response.json()) as { jobs: ChainJob[] };
  return result.jobs.filter(
    (job) => job.orderId === proof.orderId && job.vault === d.vault && job.network === d.network,
  );
}
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitPaid(quantity: string) {
  for (let i = 0; i < 50; i++) {
    const current = await order();
    if (current?.paid === quantity && current.pending === '0') return current;
    const tracked = await jobs();
    assert.ok(
      tracked.every((job) => job.status !== 'failed'),
      'Automatic request failed; inspect it rather than repeat the payment.',
    );
    await pause(3000);
  }
  throw new Error('Settlement is still pending; rerun verification to recover the existing job.');
}
async function register(id: string) {
  const balance = await provider.callFunction({
    contractId: d.token,
    method: 'storage_balance_of',
    args: { account_id: id },
  });
  if (!balance) {
    const bounds = await provider.callFunction<{ min: string }>({
      contractId: d.token,
      method: 'storage_balance_bounds',
      args: {},
    });
    assert.ok(bounds);
    await call(
      buyer,
      d.token,
      'storage_deposit',
      { account_id: id, registration_only: true },
      BigInt(bounds.min),
    );
  }
}
async function main() {
  if (mode === 'verify' && proof.buyer !== buyer.accountId) {
    assert.equal(await order(), null, 'An existing fixture must keep its original buyer.');
    proof.buyer = buyer.accountId;
    await persist();
  }
  const code = await provider.viewContractCode({ contractId: d.vault });
  if (mode === 'status') {
    console.log(
      JSON.stringify(
        {
          version: await view('get_version'),
          codeHash: sha(code.code),
          order: await order(),
          jobs: await jobs(),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (sha(code.code) !== expected) {
    assert.equal(mode, 'upgrade', 'Run the verified upgrade first.');
    assert.equal(sha(code.code), d.wasmSha256.vault, 'Unexpected live contract code.');
    const orders: ChainOrder[] = [];
    for (let index = 0; ; index += 50) {
      const page = await view<ChainOrder[]>('list_orders', { from_index: index, limit: 50 });
      orders.push(...page);
      if (page.length < 50) break;
    }
    assert.ok(orders.every((o) => o.pending === '0'));
    const recoveries = await Promise.all(
      orders.map((o) => view<ChainRecovery>('get_recovery', { order_id: o.id })),
    );
    assert.ok(recoveries.every((r) => r.refund_pending === '0'));
    const tokenBalance = await provider.callFunction({
      contractId: d.token,
      method: 'ft_balance_of',
      args: { account_id: d.vault },
    });
    const policies = await Promise.all(
      orders.map((o) => view('get_payment_policy', { order_id: o.id })),
    );
    const confirmations = await Promise.all(
      orders.map((o) => view('list_invoices', { order_id: o.id })),
    );
    const ids = [
      ...new Set([
        ...(d.trackedRequestIds ?? []),
        ...(
          await fetch('https://accord-payments.vercel.app/api/chain/jobs').then((r) => r.json())
        ).jobs.map((j: ChainJob) => j.id),
      ]),
    ];
    const attempts = await Promise.all(
      ids.map((request_id) => view('get_attempt', { request_id })),
    );
    proof.beforeUpgrade = {
      previousHash: sha(code.code),
      orders,
      recoveries,
      policies,
      confirmations,
      attempts,
      tokenBalance,
    };
    await persist();
    await writeFile('.data/wasm/vault-before-security.wasm', code.code);
    const result = await vault.signAndSendTransaction({
      receiverId: d.vault,
      actions: [
        actions.deployContract(bytes),
        actions.functionCall('get_version', {}, 30_000_000_000_000n, 0n),
      ],
      waitUntil: 'FINAL',
    });
    assert.ok(typeof result.status === 'object' && 'SuccessValue' in result.status);
    proof.transactions.push({
      label: 'atomic_security_upgrade',
      actor: vault.accountId,
      hash: result.transaction.hash,
    });
    assert.deepEqual(await view('list_orders', { limit: 50 }), orders.slice(0, 50));
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
      tokenBalance,
    );
    assert.deepEqual(
      await Promise.all(orders.map((o) => view('get_payment_policy', { order_id: o.id }))),
      policies,
    );
    assert.deepEqual(
      await Promise.all(orders.map((o) => view('list_invoices', { order_id: o.id }))),
      confirmations,
    );
    assert.deepEqual(
      await Promise.all(ids.map((request_id) => view('get_attempt', { request_id }))),
      attempts,
    );
    check(
      'Atomic security upgrade preserved every order, payment attempt, recovery state, invoice, automatic capacity and token balance.',
    );
  }
  assert.equal(sha((await provider.viewContractCode({ contractId: d.vault })).code), expected);
  assert.equal(await view('get_version'), '2.3.1-security');
  d.wasmSha256.vault = expected;
  d.features = [
    'recovery-v1',
    'invoice-v1',
    'documents-v1',
    'automatic-v1',
    'customer-approval-v1',
  ];
  await writeFile('.data/deployment.json', JSON.stringify(d, null, 2) + '\n');
  await writeFile('fixtures/testnet-deployment.json', JSON.stringify(d, null, 2) + '\n');
  await persist();
  if (mode === 'upgrade') {
    console.log(
      JSON.stringify({ upgraded: true, version: '2.3.1-security', wasmSha256: expected }),
    );
    return;
  }
  const publicResponse = await fetch(
    'https://accord-payments.vercel.app/api/chain/state?account=' + buyer.accountId,
  );
  assert.equal(publicResponse.status, 200);
  const publicState = (await publicResponse.json()) as { deployment: Deployment };
  assert.ok(publicState.deployment.features?.includes('customer-approval-v1'));
  assert.equal(publicState.deployment.wasmSha256.vault, expected);
  let current = await order();
  if (!current) {
    const balance = await buyer.getBalance();
    if (balance < nearToYocto('1.2'))
      await account(keys.root).transfer({
        receiverId: buyer.accountId,
        amount: nearToYocto('1.25') - balance,
      });
    await call(
      buyer,
      d.vault,
      'create_automatic_order',
      {
        order_id: proof.orderId,
        terms: {
          supplier: supplier.accountId,
          receiver: buyer.accountId,
          operator: d.operator,
          payout: supplier.accountId,
          line_id: 'cartons',
          description: 'Automatic payment coffee cartons',
          unit: 'carton',
          ordered: '10',
          unit_price: '10000000',
          expires_at: (BigInt(Date.now() + 3 * 86400000) * 1_000_000n).toString(),
        },
      },
      nearToYocto('1'),
    );
    current = await order();
  }
  assert.ok(current);
  assert.equal(current.buyer, current.terms.receiver);
  if (!current.accepted_terms)
    await call(supplier, d.vault, 'accept_order', {
      order_id: current.id,
      terms_hash: current.terms_hash,
    });
  if (current.funded === '0') {
    await register(buyer.accountId);
    await register(d.vault);
    await register(supplier.accountId);
    const balance = await provider.callFunction<string>({
      contractId: d.token,
      method: 'ft_balance_of',
      args: { account_id: buyer.accountId },
    });
    assert.notEqual(balance, undefined);
    const missing = 100000000n - BigInt(balance!);
    if (missing > 0n)
      await call(
        account(keys.accounts.buyer),
        d.token,
        'ft_transfer',
        {
          receiver_id: buyer.accountId,
          amount: missing.toString(),
          memo: 'Accord automatic workflow fixture',
        },
        1n,
      );
    await call(
      buyer,
      d.token,
      'ft_transfer_call',
      { receiver_id: d.vault, amount: '100000000', msg: current.id },
      1n,
    );
  }
  current = (await order())!;
  if (BigInt(current.accepted) < 4n)
    await call(buyer, d.vault, 'confirm_delivery', {
      order_id: current.id,
      sequence: (BigInt(current.sequence) + 1n).toString(),
      cumulative_quantity: '4',
      receipt_hash: sha('automatic-delivery-4'),
    });
  async function confirm(quantity: string, reference: string) {
    const invoice: InvoicePayload = {
      order_id: current!.id,
      terms_version: 1,
      terms_hash: current!.terms_hash,
      document_hash: sha(reference),
      reference,
      line_id: 'cartons',
      quantity,
      token: d.token,
      amount: (BigInt(quantity) * 10000000n).toString(),
    };
    const existing = await view<{ invoice: InvoicePayload }[]>('list_invoices', {
      order_id: current!.id,
    });
    if (!existing.some((row) => row.invoice.reference === reference))
      await call(supplier, d.vault, 'confirm_invoice', { order_id: current!.id, invoice });
  }
  if (BigInt(current.paid) < 4n) {
    await confirm('4', 'INV-' + proof.orderId + '-4');
    await waitPaid('4');
  }
  check(
    'Buyer created, funded and confirmed delivery with one SDK fixture account; supplier used its own single account.',
  );
  check(
    'The real hosted worker paid 40 aUSD after supplier confirmation with no operator wallet login or NEP-413 payment authorization.',
  );
  current = (await order())!;
  if (BigInt(current.accepted) < 6n)
    await call(buyer, d.vault, 'confirm_delivery', {
      order_id: current.id,
      sequence: (BigInt(current.sequence) + 1n).toString(),
      cumulative_quantity: '6',
      receipt_hash: sha('automatic-delivery-6'),
    });
  if (!proof.invoiceReuseGuardChecked && BigInt(current.paid) === 4n) {
    await pause(35000);
    current = (await order())!;
    assert.equal(current.paid, '4');
    assert.equal(current.pending, '0');
    assert.equal((await jobs()).length, 1);
    proof.invoiceReuseGuardChecked = true;
    check('A later delivery did not reuse the already-paid four-carton invoice.');
    await persist();
  }
  current = (await order())!;
  if (BigInt(current.paid) < 6n) {
    await confirm('2', 'INV-' + proof.orderId + '-2');
    await waitPaid('6');
  }
  const tracked = await jobs();
  assert.equal(tracked.length, 2);
  assert.ok(
    tracked.every(
      (job) => job.authorization === 'automatic' && job.status === 'settled' && job.transactionHash,
    ),
  );
  assert.deepEqual(tracked.map((job) => job.quantity).sort(), ['2', '4']);
  proof.jobs = tracked;
  check(
    'A second supplier invoice triggered only the remaining 20 aUSD; both deterministic jobs settled once.',
  );
  let recovery = await view<ChainRecovery>('get_recovery', { order_id: proof.orderId });
  if (recovery.phase === 'Open') {
    if (!recovery.proposal) {
      await call(buyer, d.vault, 'propose_close', { order_id: proof.orderId });
      recovery = await view<ChainRecovery>('get_recovery', { order_id: proof.orderId });
    }
    assert.ok(recovery.proposal);
    assert.equal(recovery.proposal.proposed_by, buyer.accountId);
    await call(supplier, d.vault, 'accept_close', {
      order_id: proof.orderId,
      proposal_hash: recovery.proposal.hash,
    });
  }
  recovery = await view<ChainRecovery>('get_recovery', { order_id: proof.orderId });
  assert.equal(recovery.phase, 'Closed');
  assert.equal(recovery.refunded, '40000000');
  assert.equal(recovery.refund_pending, '0');
  proof.final = {
    order: await order(),
    recovery,
    paymentPolicy: await view('get_payment_policy', { order_id: proof.orderId }),
  };
  check(
    'Buyer and supplier mutually closed the order; 40 aUSD unused funding returned with no pending transfer.',
  );
  await persist();
  await writeFile(
    'fixtures/security-release-evidence.json',
    JSON.stringify(
      {
        ...proof,
        coverage:
          'Two SDK customer fixture accounts and the real restricted hosted worker; no browser signing or operator-message signature is claimed.',
        mainnet: false,
      },
      null,
      2,
    ) + '\n',
  );
  console.log(
    JSON.stringify(
      {
        orderId: proof.orderId,
        payments: tracked.map((job) => ({
          id: job.id,
          quantity: job.quantity,
          hash: job.transactionHash,
        })),
        refunded: recovery.refunded,
        phase: recovery.phase,
        operatorWalletSignatureRequired: false,
      },
      null,
      2,
    ),
  );
}
await main();
