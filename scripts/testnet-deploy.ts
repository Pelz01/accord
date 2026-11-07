import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { Account, JsonRpcProvider, KeyPair, nearToYocto, type KeyPairString } from 'near-api-js';

const provider = new JsonRpcProvider({ url: 'https://test.rpc.fastnear.com' });
const credentials = JSON.parse(await readFile('.data/testnet-credentials.json', 'utf8')) as {
  accounts: Record<string, { accountId: string; secretKey: KeyPairString }>;
};
const accounts = Object.fromEntries(
  Object.entries(credentials.accounts).map(([name, c]) => [
    name,
    new Account(c.accountId, provider, c.secretKey),
  ]),
);
const { vault, token, buyer, supplier, receiver, operator } = accounts;
const reference = JSON.parse(await readFile('fixtures/sandbox-evidence.json', 'utf8'));
const hashes: Record<string, string> = {};
const bytecode: Record<string, Uint8Array> = {};
for (const name of ['vault', 'token']) {
  const bytes = await readFile(`.data/wasm/${name}.wasm`);
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== reference.wasmSha256[name])
    throw new Error(
      `The ${name} WASM differs from the tested sandbox artifact. Rerun sandbox verification before deployment.`,
    );
  hashes[name] = hash;
  bytecode[name] = bytes;
}
type Proof = {
  network: 'testnet';
  at: string;
  vault: string;
  token: string;
  accounts: Record<string, string>;
  wasmSha256: Record<string, string>;
  transactions: { label: string; hash: string; status: unknown }[];
  checks: string[];
};
let proof: Proof;
try {
  proof = JSON.parse(await readFile('.data/testnet-evidence.json', 'utf8'));
} catch {
  proof = {
    network: 'testnet',
    at: new Date().toISOString(),
    vault: vault.accountId,
    token: token.accountId,
    accounts: Object.fromEntries(Object.entries(accounts).map(([k, v]) => [k, v.accountId])),
    wasmSha256: hashes,
    transactions: [],
    checks: [],
  };
}
const persist = () => writeFile('.data/testnet-evidence.json', JSON.stringify(proof, null, 2));
async function record(
  label: string,
  fn: () => Promise<{ transaction: { hash: string }; status: unknown }>,
) {
  const result = await fn();
  proof.transactions.push({ label, hash: result.transaction.hash, status: result.status });
  await persist();
  console.log(`${label}: ${result.transaction.hash}`);
  return result;
}
async function call(
  account: Account,
  target: Account,
  method: string,
  args: Record<string, unknown>,
  deposit = 0n,
) {
  return record(method, () =>
    account.callFunctionRaw({
      contractId: target.accountId,
      methodName: method,
      args,
      deposit,
      gas: 150_000_000_000_000n,
      waitUntil: 'FINAL',
    }),
  );
}
for (const [name, account] of [
  ['vault', vault],
  ['token', token],
] as const)
  await record(`deploy_${name}`, () => account.deployContract(bytecode[name]));
let tokenReady = false,
  vaultReady = false;
try {
  const metadata = await provider.callFunction<{ symbol: string; decimals: number }>({
    contractId: token.accountId,
    method: 'ft_metadata',
    args: {},
  });
  tokenReady = metadata?.symbol === 'aUSD' && metadata.decimals === 6;
} catch {
  /* new deployment has no state yet */
}
if (!tokenReady)
  await call(token, token, 'new', { owner_id: buyer.accountId, total_supply: '100000000000' });
try {
  await provider.callFunction({
    contractId: vault.accountId,
    method: 'list_orders',
    args: { limit: 1 },
  });
  vaultReady = true;
} catch {
  /* new deployment has no state yet */
}
if (!vaultReady) await call(vault, vault, 'new', { token: token.accountId, network: 'testnet' });
for (const account of [vault, supplier]) {
  const registration = await provider.callFunction({
    contractId: token.accountId,
    method: 'storage_balance_of',
    args: { account_id: account.accountId },
  });
  if (!registration)
    await call(
      buyer,
      token,
      'storage_deposit',
      { account_id: account.accountId, registration_only: true },
      nearToYocto('0.1'),
    );
}
let limited: { accountId: string; secretKey: KeyPairString; publicKey: string };
try {
  limited = JSON.parse(await readFile('.data/operator-key.json', 'utf8'));
} catch {
  const key = KeyPair.fromRandom('ed25519');
  limited = {
    accountId: operator.accountId,
    secretKey: key.toString(),
    publicKey: key.getPublicKey().toString(),
  };
  await writeFile('.data/operator-key.json', JSON.stringify(limited, null, 2), {
    mode: 0o600,
    flag: 'wx',
  });
}
let keyReady = false;
try {
  const existing = await provider.viewAccessKey({
    accountId: operator.accountId,
    publicKey: limited.publicKey,
  });
  keyReady = true;
  if (
    existing.permission !== 'FullAccess' &&
    'FunctionCall' in existing.permission &&
    BigInt(existing.permission.FunctionCall.allowance ?? '0') < nearToYocto('0.2')
  ) {
    await record('renew_operator_allowance', () => operator.deleteKey(limited.publicKey));
    keyReady = false;
  }
} catch {
  /* new limited key */
}
if (!keyReady)
  await record('add_restricted_operator_key', () =>
    operator.addFunctionCallAccessKey({
      publicKey: limited.publicKey,
      contractId: vault.accountId,
      methodNames: ['request_payment'],
      allowance: nearToYocto('0.3'),
    }),
  );
const key = await provider.viewAccessKey({
  accountId: operator.accountId,
  publicKey: limited.publicKey,
});
if (
  key.permission === 'FullAccess' ||
  !('FunctionCall' in key.permission) ||
  key.permission.FunctionCall.receiver_id !== vault.accountId ||
  key.permission.FunctionCall.method_names.join(',') !== 'request_payment'
)
  throw new Error('Operator key is not narrowly scoped.');
proof.checks.push('Restricted operator key is scoped to request_payment on the tested vault.');
const config = {
  network: 'testnet',
  rpcUrl: 'https://test.rpc.fastnear.com',
  vault: vault.accountId,
  token: token.accountId,
  operator: operator.accountId,
  wasmSha256: hashes,
  accounts: proof.accounts,
  trackedRequestIds: ['testnet-partial-1', 'testnet-partial-2'],
  features: ['recovery-v1', 'invoice-v1', 'documents-v1'],
};
await writeFile('.data/deployment.json', JSON.stringify(config, null, 2));
console.log('Deployment configuration saved. Running real testnet partial-settlement smoke.');
const orderId = 'PO-TESTNET-001';
type ChainOrder = {
  terms_hash: string;
  accepted_terms: boolean;
  funded: string;
  accepted: string;
  paid: string;
  pending: string;
  sequence: string;
};
async function readOrder() {
  return provider.callFunction<ChainOrder>({
    contractId: vault.accountId,
    method: 'get_order',
    args: { order_id: orderId },
  });
}
let order = await readOrder();
if (!order) {
  await call(
    buyer,
    vault,
    'create_order',
    {
      order_id: orderId,
      terms: {
        supplier: supplier.accountId,
        receiver: receiver.accountId,
        operator: operator.accountId,
        payout: supplier.accountId,
        line_id: 'cartons',
        description: 'Fictitious packing cartons',
        unit: 'carton',
        ordered: '100',
        unit_price: '10000000',
        expires_at: (
          BigInt(Date.now()) * 1_000_000n +
          7n * 24n * 60n * 60n * 1_000_000_000n
        ).toString(),
      },
    },
    nearToYocto('1'),
  );
  order = await readOrder();
}
if (!order) throw new Error('Created order is not visible. Inspect receipts before retrying.');
if (!order.accepted_terms)
  await call(supplier, vault, 'accept_order', { order_id: orderId, terms_hash: order.terms_hash });
order = await readOrder();
if (order?.funded === '0')
  await call(
    buyer,
    token,
    'ft_transfer_call',
    { receiver_id: vault.accountId, amount: '1000000000', msg: orderId },
    1n,
  );
const restricted = new Account(operator.accountId, provider, limited.secretKey);
for (const [total, requestId, quantity] of [
  ['40', 'testnet-partial-1', '40'],
  ['70', 'testnet-partial-2', '30'],
]) {
  order = await readOrder();
  if (!order) throw new Error('Order missing.');
  if (BigInt(order.accepted) < BigInt(total))
    await call(receiver, vault, 'confirm_delivery', {
      order_id: orderId,
      sequence: (BigInt(order.sequence) + 1n).toString(),
      cumulative_quantity: total,
      receipt_hash: createHash('sha256').update(`fictitious-receipt-${total}`).digest('hex'),
    });
  const attempt = await provider.callFunction<{ status: string }>({
    contractId: vault.accountId,
    method: 'get_attempt',
    args: { request_id: requestId },
  });
  if (attempt && attempt.status !== 'Settled')
    throw new Error(`Existing ${requestId} is ${attempt.status}; do not blindly retry.`);
  if (!attempt) {
    const invoice = {
      order_id: orderId,
      terms_version: 1,
      terms_hash: order.terms_hash,
      document_hash: createHash('sha256').update('fictitious invoice').digest('hex'),
      reference: 'INV-TESTNET-001',
      line_id: 'cartons',
      quantity: '100',
      token: token.accountId,
      amount: '1000000000',
    };
    await call(supplier, vault, 'confirm_invoice', { order_id: orderId, invoice });
    await call(restricted, vault, 'request_payment', {
      order_id: orderId,
      request_id: requestId,
      quantity,
      audit_hash: createHash('sha256').update('fictitious invoice').digest('hex'),
      invoice,
    });
  }
}
order = await readOrder();
const supplierBalance = await provider.callFunction<string>({
  contractId: token.accountId,
  method: 'ft_balance_of',
  args: { account_id: supplier.accountId },
});
if (order?.paid !== '70' || order.pending !== '0' || BigInt(supplierBalance ?? '0') < 700_000_000n)
  throw new Error('Final testnet balances do not match the expected 700-token partial settlement.');
proof.checks.push(
  'Real testnet order funded for 100 cartons, accepted at 40 then 70, paid 400 then 300 aUSD, pending zero.',
);
let rejected = false;
try {
  await restricted.callFunction({
    contractId: vault.accountId,
    methodName: 'confirm_delivery',
    args: {
      order_id: orderId,
      sequence: '3',
      cumulative_quantity: '80',
      receipt_hash: 'a'.repeat(64),
    },
    gas: 30_000_000_000_000n,
  });
} catch {
  rejected = true;
}
if (!rejected) throw new Error('Restricted key unexpectedly called a receiver method.');
proof.checks.push('Restricted key cannot call confirm_delivery.');
await persist();
console.log(`PASS: 700 aUSD settled on testnet. Contract ${vault.accountId}`);
