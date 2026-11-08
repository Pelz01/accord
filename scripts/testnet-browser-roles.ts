import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';
import {
  Account,
  JsonRpcProvider,
  KeyPair,
  baseEncode,
  nearToYocto,
  type KeyPairString,
} from 'near-api-js';
import type { ChainOrder, ChainRecovery, Deployment } from '../shared/chain.ts';
import { accountSchema } from '../shared/schema.ts';

// Fixture preparation only. Supplier/receiver/operator approvals must happen in real wallets.
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { receiver: { type: 'string' } },
});
const mode = positionals[0] ?? 'status';
assert.ok(['prepare', 'fund', 'status', 'close-counterparty'].includes(mode));
const d = JSON.parse(await readFile('.data/deployment.json', 'utf8')) as Deployment;
assert.equal(d.network, 'testnet');
assert.equal(d.rpcUrl, 'https://test.rpc.fastnear.com');
assert.ok(d.vault.endsWith('.testnet') && d.token.endsWith('.testnet'));
const provider = new JsonRpcProvider({ url: d.rpcUrl });
type Credential = { accountId: string; secretKey: KeyPairString };
const credentials = JSON.parse(await readFile('.data/testnet-credentials.json', 'utf8')) as {
  root: Credential;
  accounts: Record<string, Credential>;
};
const account = (key: Credential) => new Account(key.accountId, provider, key.secretKey);
const sourceBuyer = account(credentials.accounts.buyer);
let buyer = sourceBuyer;
const root = account(credentials.root);
const state = await new Account(d.vault, provider).getState();
assert.equal(state.codeHash, baseEncode(Buffer.from(d.wasmSha256.vault, 'hex')));
await mkdir('.data/browser-roles', { recursive: true });
const receiverId = accountSchema.parse(values.receiver ?? credentials.accounts.receiver.accountId);
const customReceiver = receiverId !== credentials.accounts.receiver.accountId;
const path = customReceiver
  ? `.data/browser-roles/journey-${receiverId}.json`
  : '.data/browser-roles/journey.json';
if (customReceiver) {
  const buyerPath = `.data/browser-roles/buyer-${receiverId}.json`;
  let key: Credential & { publicKey: string };
  try {
    key = JSON.parse(await readFile(buyerPath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || mode !== 'prepare') throw error;
    const pair = KeyPair.fromRandom('ed25519');
    key = {
      accountId: `accord-browser-${randomBytes(4).toString('hex')}.testnet`,
      secretKey: pair.toString(),
      publicKey: pair.getPublicKey().toString(),
    };
    await writeFile(buyerPath, JSON.stringify(key, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  }
  buyer = account(key);
  try {
    await buyer.getState();
  } catch (error) {
    if (
      mode !== 'prepare' ||
      !/does not exist|doesn't exist|unknown_account|AccountDoesNotExist/i.test(String(error))
    )
      throw error;
    const response = await fetch('https://helper.testnet.near.org/account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newAccountId: key.accountId, newAccountPublicKey: key.publicKey }),
      signal: AbortSignal.timeout(45000),
    });
    assert.ok(response.ok, 'Testnet faucet failed; the local fixture key was retained.');
    await buyer.getState();
  }
}
type Journey = {
  network: 'testnet';
  vault: string;
  token: string;
  orderId: string;
  buyer: string;
  supplier: string;
  receiver: string;
  operator: string;
  createdAt: string;
  transactions: { label: string; hash: string; source: 'SDK fixture setup'; actor?: string }[];
};
let journey: Journey;
try {
  journey = JSON.parse(await readFile(path, 'utf8'));
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || mode !== 'prepare') throw error;
  journey = {
    network: 'testnet',
    vault: d.vault,
    token: d.token,
    orderId: 'PO-BROWSER-ROLES-' + randomBytes(4).toString('hex').toUpperCase(),
    buyer: buyer.accountId,
    supplier: 'testing33.testnet',
    receiver: receiverId,
    operator: d.operator,
    createdAt: new Date().toISOString(),
    transactions: [],
  };
}
assert.equal(journey.network, d.network);
assert.equal(journey.vault, d.vault);
assert.equal(journey.buyer, buyer.accountId);
assert.equal(journey.operator, d.operator);
assert.equal(journey.receiver, receiverId);
assert.equal(
  new Set([journey.buyer, journey.supplier, journey.receiver, journey.operator]).size,
  4,
);
const persist = () => writeFile(path, JSON.stringify(journey, null, 2) + '\n');
await persist();
async function view<T>(method: string, args: Record<string, unknown>) {
  const result = await provider.callFunction({ contractId: d.vault, method, args });
  assert.notEqual(result, undefined, 'Missing view response: ' + method);
  return result as T;
}
const readOrder = () => view<ChainOrder | null>('get_order', { order_id: journey.orderId });
async function call(
  target: string,
  methodName: string,
  args: Record<string, unknown>,
  deposit = 0n,
  actor = buyer,
) {
  const result = await actor.callFunctionRaw({
    contractId: target,
    methodName,
    args,
    deposit,
    gas: 150_000_000_000_000n,
    waitUntil: 'FINAL',
  });
  assert.ok(
    typeof result.status === 'object' && 'SuccessValue' in result.status,
    'Inspect the transaction before retrying: ' + result.transaction.hash,
  );
  journey.transactions.push({
    label: methodName,
    hash: result.transaction.hash,
    source: 'SDK fixture setup',
    actor: actor.accountId,
  });
  await persist();
}
let order = await readOrder();
if (mode === 'prepare' && !order) {
  const available = await buyer.getBalance();
  if (available < nearToYocto('1.2')) {
    const topup = await root.transfer({
      receiverId: buyer.accountId,
      amount: nearToYocto('1.25') - available,
    });
    assert.ok(typeof topup.status === 'object' && 'SuccessValue' in topup.status);
    journey.transactions.push({
      label: 'testnet gas top-up',
      hash: topup.transaction.hash,
      source: 'SDK fixture setup',
    });
    await persist();
  }
  await call(
    d.vault,
    'create_order',
    {
      order_id: journey.orderId,
      terms: {
        supplier: journey.supplier,
        receiver: journey.receiver,
        operator: journey.operator,
        payout: journey.supplier,
        line_id: 'cartons',
        description: 'Browser verification coffee cartons',
        unit: 'carton',
        ordered: '10',
        unit_price: '10000000',
        expires_at: (BigInt(Date.now() + 3 * 86400000) * 1_000_000n).toString(),
      },
    },
    nearToYocto('1'),
  );
  order = await readOrder();
}
assert.ok(order);
assert.equal(order.buyer, journey.buyer);
assert.equal(order.terms.supplier, journey.supplier);
assert.equal(order.terms.receiver, journey.receiver);
assert.equal(order.terms.operator, journey.operator);
assert.equal(order.terms.payout, journey.supplier);
assert.equal(order.terms.ordered, '10');
assert.equal(order.terms.unit_price, '10000000');
if (mode === 'fund') {
  assert.equal(order.accepted_terms, true, 'Supplier must accept through the browser first.');
  if (order.funded === '0') {
    if (customReceiver) {
      const registration = await provider.callFunction({
        contractId: d.token,
        method: 'storage_balance_of',
        args: { account_id: buyer.accountId },
      });
      if (!registration) {
        const bounds = await provider.callFunction<{ min: string }>({
          contractId: d.token,
          method: 'storage_balance_bounds',
          args: {},
        });
        assert.ok(bounds);
        await call(
          d.token,
          'storage_deposit',
          { account_id: buyer.accountId, registration_only: true },
          BigInt(bounds.min),
        );
      }
      const balance = await provider.callFunction<string>({
        contractId: d.token,
        method: 'ft_balance_of',
        args: { account_id: buyer.accountId },
      });
      assert.notEqual(balance, undefined);
      const missing = 100000000n - BigInt(balance!);
      if (missing > 0n)
        await call(
          d.token,
          'ft_transfer',
          {
            receiver_id: buyer.accountId,
            amount: missing.toString(),
            memo: 'Accord browser role fixture',
          },
          1n,
          sourceBuyer,
        );
    }
    for (const id of [d.vault, order.terms.payout]) {
      const registered = await provider.callFunction({
        contractId: d.token,
        method: 'storage_balance_of',
        args: { account_id: id },
      });
      if (!registered) {
        const bounds = await provider.callFunction<{ min: string }>({
          contractId: d.token,
          method: 'storage_balance_bounds',
          args: {},
        });
        assert.ok(bounds);
        await call(
          d.token,
          'storage_deposit',
          { account_id: id, registration_only: true },
          BigInt(bounds.min),
        );
      }
    }
    await call(
      d.token,
      'ft_transfer_call',
      { receiver_id: d.vault, amount: '100000000', msg: order.id },
      1n,
    );
  }
  order = await readOrder();
  assert.equal(order?.funded, '100000000');
}
if (mode === 'close-counterparty') {
  const recovery = await view<ChainRecovery>('get_recovery', { order_id: order.id });
  assert.equal(order.paid, '4');
  assert.equal(order.accepted, '4');
  assert.equal(order.pending, '0');
  if (recovery.phase !== 'Closed') {
    assert.equal(recovery.phase, 'Open');
    assert.ok(recovery.proposal);
    assert.equal(recovery.proposal.proposed_by, journey.supplier);
    assert.equal(recovery.proposal.refund_amount, '60000000');
    await call(d.vault, 'accept_close', {
      order_id: order.id,
      proposal_hash: recovery.proposal.hash,
    });
  }
}
const recovery = await view<ChainRecovery>('get_recovery', { order_id: journey.orderId });
if (mode === 'close-counterparty') {
  assert.equal(recovery.phase, 'Closed');
  assert.equal(recovery.refunded, '60000000');
  assert.equal(recovery.refund_pending, '0');
}
console.log(JSON.stringify({ ...journey, order: await readOrder(), recovery }, null, 2));
