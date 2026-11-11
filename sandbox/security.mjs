import { Worker } from 'near-workspaces';
import { Account, KeyPair, KeyPairSigner, actions } from '../node_modules/near-api-js/lib/index.js';
import { runPaymentJob, paymentArguments } from '../server/payment-worker.ts';
import { FinalizedRpcProvider } from '../server/rpc.ts';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { prepareRuntime } from './runtime.mjs';
await prepareRuntime();
const wasm = (name) => fileURLToPath(new URL(`../.data/wasm/${name}.wasm`, import.meta.url));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const worker = await Worker.init();
const provider = new FinalizedRpcProvider({ url: worker.provider.connection.url });
const proof = {
  at: new Date().toISOString(),
  environment: 'local-near-sandbox',
  wasmSha256: {
    vault: sha(await readFile(wasm('vault'))),
    previous: sha(await readFile(wasm('vault-v2-automatic'))),
  },
  checks: [],
};
const pass = (name) => {
  proof.checks.push({ name, status: 'PASS' });
  console.log('PASS ' + name);
};
const options = { attachedDeposit: '1', gas: '150000000000000' };
try {
  const root = worker.rootAccount;
  const buyer = await root.createSubAccount('buyer');
  const supplier = await root.createSubAccount('supplier');
  const operator = await root.createSubAccount('operator');
  const token = await root.devDeploy(wasm('token'));
  const vault = await root.devDeploy(wasm('vault-v2-automatic'));
  const starved = await root.devDeploy(wasm('vault-starved'));
  await token.call(token, 'new', { owner_id: buyer.accountId, total_supply: '10000000000' });
  for (const contract of [vault, starved])
    await contract.call(contract, 'new', { token: token.accountId, network: 'sandbox' });
  for (const account of [vault, starved, supplier])
    await buyer.call(
      token,
      'storage_deposit',
      { account_id: account.accountId, registration_only: true },
      { attachedDeposit: '100000000000000000000000' },
    );
  const terms = {
    supplier: supplier.accountId,
    receiver: buyer.accountId,
    operator: operator.accountId,
    payout: supplier.accountId,
    line_id: 'cartons',
    description: 'Coffee cartons',
    unit: 'carton',
    ordered: '10',
    unit_price: '10000000',
    expires_at: '18446744073709551615',
  };
  async function create(contract, id, guarded) {
    await buyer.call(
      contract,
      'create_automatic_order',
      { order_id: id, terms },
      { attachedDeposit: '1000000000000000000000000' },
    );
    const o = await contract.view('get_order', { order_id: id });
    await supplier.call(
      contract,
      'accept_order',
      { order_id: id, terms_hash: o.terms_hash },
      guarded ? options : {},
    );
    await buyer.call(
      token,
      'ft_transfer_call',
      { receiver_id: contract.accountId, amount: '100000000', msg: id },
      options,
    );
    await buyer.call(
      contract,
      'confirm_delivery',
      { order_id: id, sequence: '1', cumulative_quantity: '4', receipt_hash: 'a'.repeat(64) },
      guarded ? options : {},
    );
    const invoice = {
      order_id: id,
      terms_version: 1,
      terms_hash: o.terms_hash,
      document_hash: 'b'.repeat(64),
      reference: 'INV-' + id,
      line_id: 'cartons',
      quantity: '4',
      token: token.accountId,
      amount: '40000000',
    };
    await supplier.call(
      contract,
      'confirm_invoice',
      { order_id: id, invoice },
      guarded ? options : {},
    );
    return { o, invoice };
  }
  async function payment(contract, id, invoice, request_id) {
    return operator.callRaw(
      contract,
      'request_payment',
      { order_id: id, request_id, quantity: '4', audit_hash: invoice.document_hash, invoice },
      { gas: options.gas },
    );
  }
  const old = await create(vault, 'upgraded', false);
  assert.equal((await payment(vault, old.o.id, old.invoice, 'old-payment')).failed, false);
  const snapshot = async () => ({
    order: await vault.view('get_order', { order_id: old.o.id }),
    attempt: await vault.view('get_attempt', { request_id: 'old-payment' }),
    recovery: await vault.view('get_recovery', { order_id: old.o.id }),
    policy: await vault.view('get_payment_policy', { order_id: old.o.id }),
    invoices: await vault.view('list_invoices', { order_id: old.o.id }),
    balance: await token.view('ft_balance_of', { account_id: vault.accountId }),
  });
  const before = await snapshot();
  await vault.deploy(wasm('vault'));
  assert.equal(await vault.view('get_version', {}), '2.5.0-mainnet');
  assert.deepEqual(await snapshot(), before);
  pass(
    'upgrade preserves automatic order, settled attempt, invoice capacity, recovery and token balance',
  );
  const uncertain = await create(starved, 'uncertain', true);
  await payment(starved, uncertain.o.id, uncertain.invoice, 'uncertain-payment');
  assert.equal(
    (await starved.view('get_attempt', { request_id: 'uncertain-payment' })).status,
    'Reserved',
  );
  const cases = [
    [supplier, vault, 'accept_order', { order_id: old.o.id, terms_hash: old.o.terms_hash }],
    [
      buyer,
      vault,
      'confirm_delivery',
      { order_id: old.o.id, sequence: '2', cumulative_quantity: '6', receipt_hash: 'c'.repeat(64) },
    ],
    [supplier, vault, 'confirm_invoice', { order_id: old.o.id, invoice: old.invoice }],
    ...['propose_close', 'cancel_close', 'accept_close', 'retry_refund', 'acknowledge_refund'].map(
      (method) => [buyer, vault, method, { order_id: old.o.id, proposal_hash: 'x', refund_id: 1 }],
    ),
    [supplier, starved, 'acknowledge_payment', { request_id: 'uncertain-payment' }],
  ];
  for (const [actor, contract, method, args] of cases) {
    const r = await actor.callRaw(contract, method, args);
    assert.equal(r.failed, true, method + ' must require wallet approval');
    assert.match(JSON.stringify(r.result.status), /Attach exactly 1 yoctoNEAR/);
  }
  assert.deepEqual(await snapshot(), before);
  pass(
    'all nine automatic customer approval methods reject zero deposit without mutating balances',
  );
  const pair = KeyPair.fromRandom('ed25519');
  const ephemeralBuyerKey = await buyer.getKey();
  const customer = new Account(buyer.accountId, provider, ephemeralBuyerKey.toString());
  await customer.signAndSendTransaction({
    receiverId: buyer.accountId,
    actions: [
      actions.addFunctionCallAccessKey(
        pair.getPublicKey(),
        vault.accountId,
        ['confirm_delivery'],
        10n ** 24n,
      ),
    ],
    waitUntil: 'FINAL',
  });
  const limited = new Account(buyer.accountId, provider, pair.toString());
  const delivery = {
    order_id: old.o.id,
    sequence: '2',
    cumulative_quantity: '6',
    receipt_hash: 'c'.repeat(64),
  };
  await assert.rejects(
    limited.callFunctionRaw({
      contractId: vault.accountId,
      methodName: 'confirm_delivery',
      args: delivery,
      gas: 30_000_000_000_000n,
      waitUntil: 'FINAL',
    }),
    /Attach exactly 1 yoctoNEAR/,
  );
  await assert.rejects(
    limited.callFunctionRaw({
      contractId: vault.accountId,
      methodName: 'confirm_delivery',
      args: delivery,
      deposit: 1n,
      gas: 30_000_000_000_000n,
      waitUntil: 'FINAL',
    }),
    /deposit|RequiresFullAccess/i,
  );
  const excess = await buyer.callRaw(vault, 'confirm_delivery', delivery, { attachedDeposit: '2' });
  assert.equal(excess.failed, true);
  await buyer.call(vault, 'confirm_delivery', delivery, options);
  assert.equal((await vault.view('get_order', { order_id: old.o.id })).accepted, '6');
  pass(
    'real function-call key cannot approve delivery; full wallet with exactly one yocto succeeds',
  );
  await supplier.call(starved, 'acknowledge_payment', { request_id: 'uncertain-payment' }, options);
  assert.equal((await starved.view('get_order', { order_id: uncertain.o.id })).paid, '4');
  await buyer.call(starved, 'propose_close', { order_id: uncertain.o.id }, options);
  const uncertainProposal = await starved.view('get_recovery', { order_id: uncertain.o.id });
  const uncertainRefund = await supplier.callRaw(
    starved,
    'accept_close',
    {
      order_id: uncertain.o.id,
      proposal_hash: uncertainProposal.proposal.hash,
    },
    options,
  );
  assert.equal(uncertainRefund.failed, true); // Deliberately starved callback, not a failed transfer.
  assert.equal(
    (await starved.view('get_recovery', { order_id: uncertain.o.id })).phase,
    'RefundPending',
  );
  await buyer.call(
    starved,
    'acknowledge_refund',
    { order_id: uncertain.o.id, refund_id: 1 },
    options,
  );
  assert.equal((await starved.view('get_recovery', { order_id: uncertain.o.id })).phase, 'Closed');
  pass(
    'guarded recipient acknowledgments finalize uncertain payment and refund without reusing funds',
  );
  const fresh = await create(vault, 'restart', true);
  const servicePair = KeyPair.fromRandom('ed25519');
  const operatorRootKey = await operator.getKey();
  const admin = new Account(operator.accountId, provider, operatorRootKey.toString());
  await admin.signAndSendTransaction({
    receiverId: operator.accountId,
    actions: [
      actions.addFunctionCallAccessKey(
        servicePair.getPublicKey(),
        vault.accountId,
        ['request_payment'],
        10n ** 24n,
      ),
    ],
    waitUntil: 'FINAL',
  });
  const signer = KeyPairSigner.fromSecretKey(servicePair.toString());
  const service = new Account(operator.accountId, provider, signer);
  const deployment = {
    network: 'testnet',
    vault: vault.accountId,
    operator: operator.accountId,
    wasmSha256: { vault: proof.wasmSha256.vault },
  };
  const job = {
    network: 'testnet',
    vault: vault.accountId,
    id: 'restart-proof',
    orderId: fresh.o.id,
    quantity: '4',
    auditHash: fresh.invoice.document_hash,
    invoice: fresh.invoice,
    status: 'queued',
    transactionHash: null,
    error: null,
    createdAt: new Date().toISOString(),
  };
  const path = new URL('../.data/security-restart-job.json', import.meta.url);
  let stored,
    broadcastError = '',
    signatures = 0,
    broadcasts = 0;
  const io = {
    attempt: () => vault.view('get_attempt', { request_id: job.id }),
    transactionStatus: () =>
      provider.viewTransactionStatus({
        txHash: job.transactionHash,
        accountId: operator.accountId,
        waitUntil: 'FINAL',
      }),
    prepare: async () => {
      signatures++;
      const tx = await service.createTransaction({
        receiverId: vault.accountId,
        publicKey: servicePair.getPublicKey(),
        actions: [
          actions.functionCall('request_payment', paymentArguments(job), 150_000_000_000_000n, 0n),
        ],
      });
      return (await signer.signTransaction(tx)).signedTransaction;
    },
    broadcast: async (tx) => {
      broadcasts++;
      try {
        return await provider.sendTransactionUntil(tx, 'FINAL');
      } catch (error) {
        broadcastError = error.name + ': ' + error.message.slice(0, 200);
        throw error;
      }
    },
    save: (value) => {
      stored = JSON.stringify(value);
    },
  };
  await assert.rejects(
    runPaymentJob(deployment, job, {
      ...io,
      save: (value) => {
        io.save(value);
        throw new Error('Crash before network send');
      },
    }),
    /Crash before/,
  );
  assert.equal(broadcasts, 0);
  // Save/reload the private authorization just as a restarted process does. Never print it.
  await writeFile(path, stored, { mode: 0o600 });
  const recovered = JSON.parse(await readFile(path, 'utf8'));
  await runPaymentJob(deployment, recovered, io);
  assert.equal(signatures, 1);
  assert.equal(broadcasts, 1);
  assert.equal(recovered.status, 'settled', broadcastError);
  await runPaymentJob(deployment, recovered, io);
  assert.equal(broadcasts, 1);
  assert.equal((await vault.view('get_order', { order_id: fresh.o.id })).paid, '4');
  assert.equal(await token.view('ft_balance_of', { account_id: supplier.accountId }), '120000000');
  await buyer.call(vault, 'propose_close', { order_id: fresh.o.id }, options);
  await buyer.call(vault, 'cancel_close', { order_id: fresh.o.id }, options);
  assert.equal((await vault.view('get_recovery', { order_id: fresh.o.id })).proposal, null);
  await buyer.call(vault, 'propose_close', { order_id: fresh.o.id }, options);
  const proposal = await vault.view('get_recovery', { order_id: fresh.o.id });
  await supplier.call(
    vault,
    'accept_close',
    {
      order_id: fresh.o.id,
      proposal_hash: proposal.proposal.hash,
    },
    options,
  );
  assert.equal((await vault.view('get_recovery', { order_id: fresh.o.id })).refunded, '60000000');
  pass('restricted service recovers saved signed bytes after restart and settles exactly once');
} finally {
  await writeFile(
    new URL('../.data/security-sandbox-evidence.json', import.meta.url),
    JSON.stringify(proof, null, 2) + '\n',
  );
  await worker.tearDown();
}
