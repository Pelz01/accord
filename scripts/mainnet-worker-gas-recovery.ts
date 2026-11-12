import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  Account,
  KeyPair,
  KeyPairSigner,
  PublicKey,
  SignedTransaction,
  Transaction,
  actions,
  baseEncode,
  encodeTransaction,
  type KeyPairString,
} from 'near-api-js';
import { FinalizedRpcProvider } from '../server/rpc.ts';
import { nativeAmount } from '../shared/mainnet-readiness.ts';
import { assertOperatorPolicy } from '../server/operator-policy.ts';

// Controlled release operation. Never discard an uncertain authorization until its key is revoked.
const mode = process.argv[2];
assert(
  ['rotate-and-float', 'return-float'].includes(mode ?? ''),
  'Choose an explicit recovery operation.',
);
const dir = '.data/mainnet';
const d = JSON.parse(await readFile(dir + '/deployment.json', 'utf8'));
const plan = JSON.parse(await readFile(dir + '/plan.json', 'utf8'));
assert.equal(d.network, 'mainnet');
assert.equal(plan.totalCapNear, '3');
type Key = { accountId: string; publicKey: string; secretKey: KeyPairString };
const keys: Record<string, Key> = JSON.parse(
  await readFile(dir + '/accounts.private.json', 'utf8'),
);
for (const role of ['supplier', 'operator']) {
  assert.equal(keys[role].accountId, d.accounts[role]);
  assert.equal(
    Buffer.from(KeyPair.fromString(keys[role].secretKey).getPublicKey().data).toString('hex'),
    keys[role].accountId,
  );
}
const rpc = new FinalizedRpcProvider({ url: d.rpcUrl });
const view = async (method: string, args: Record<string, unknown>) =>
  await rpc.callFunction({ contractId: d.vault, method, args });
const orderId = 'PO-7886D7BD',
  requestId = 'auto-72419646788a101291f92c726ee8777e4ff166ca';
const originalHash = 'D5eK8BnFkHYKsPWyqSZZ5UzCQqL72VWYL3XXWVMwUvQm';
const originalNonce = 224033215000001n;
const oldCost = 150922920942884500000000n;
const float = nativeAmount('0.064');
async function native(role: string) {
  return BigInt(
    (await rpc.viewAccount({ accountId: d.accounts[role], blockQuery: { finality: 'final' } }))
      .amount,
  );
}
async function sendOnce(
  name: string,
  role: string,
  receiverId: string,
  ops: Parameters<Account['createTransaction']>[0]['actions'],
) {
  const file = dir + '/' + name + '.signed.private.json';
  let stored: { hash: string; bytes: string };
  try {
    stored = JSON.parse(await readFile(file, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    const signer = KeyPairSigner.fromSecretKey(keys[role].secretKey),
      account = new Account(keys[role].accountId, rpc, signer);
    const tx = await account.createTransaction({
      receiverId,
      publicKey: keys[role].publicKey,
      actions: ops,
    });
    const signed = (await signer.signTransaction(tx)).signedTransaction;
    stored = {
      hash: baseEncode(createHash('sha256').update(encodeTransaction(signed.transaction)).digest()),
      bytes: Buffer.from(signed.encode()).toString('base64'),
    };
    await writeFile(file, JSON.stringify(stored), { flag: 'wx', mode: 0o600 });
  }
  const signed = SignedTransaction.decode(Buffer.from(stored.bytes, 'base64'));
  assert.equal(signed.transaction.signerId, keys[role].accountId);
  assert.equal(signed.transaction.receiverId, receiverId);
  assert.equal(signed.transaction.publicKey.toString(), keys[role].publicKey);
  const expected = new Transaction({
    signerId: keys[role].accountId,
    receiverId,
    publicKey: signed.transaction.publicKey,
    nonce: signed.transaction.nonce,
    blockHash: signed.transaction.blockHash,
    actions: ops,
  });
  assert(
    Buffer.from(encodeTransaction(expected)).equals(
      Buffer.from(encodeTransaction(signed.transaction)),
    ),
    'Stored actions changed.',
  );
  assert.equal(
    baseEncode(createHash('sha256').update(encodeTransaction(signed.transaction)).digest()),
    stored.hash,
  );
  let receipt;
  try {
    receipt = await rpc.viewTransactionStatus({
      txHash: stored.hash,
      accountId: keys[role].accountId,
    });
  } catch {
    receipt = await rpc.sendTransactionUntil(signed, 'FINAL');
  }
  assert(
    receipt.status && typeof receipt.status === 'object' && 'SuccessValue' in receipt.status,
    'Operation did not finalize successfully.',
  );
  await writeFile(
    dir + '/' + name + '.receipt.json',
    JSON.stringify(
      {
        hash: stored.hash,
        signer: keys[role].accountId,
        receiver: receiverId,
        status: receipt.status,
      },
      null,
      2,
    ),
  );
  return stored.hash;
}
async function absent(publicKey: string) {
  const response = await fetch(d.rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'accord-revocation-proof',
      method: 'query',
      params: {
        request_type: 'view_access_key',
        account_id: d.operator,
        public_key: publicKey,
        finality: 'final',
      },
    }),
    signal: AbortSignal.timeout(15000),
  });
  const j = await response.json();
  return (
    response.ok &&
    (j.error?.cause?.name === 'UNKNOWN_ACCESS_KEY' ||
      (Number.isSafeInteger(j.result?.block_height) &&
        j.result?.error === `access key ${publicKey} does not exist while viewing`))
  );
}
if (mode === 'rotate-and-float') {
  const order: any = await view('get_order', { order_id: orderId });
  assert.equal(order.paid, '0');
  assert.equal(order.pending, '0');
  assert.equal(order.funded, '20000');
  assert.equal(order.accepted, '1');
  assert.equal(await view('get_attempt', { request_id: requestId }), null);
  const account = await rpc.viewAccount({ accountId: d.vault, blockQuery: { finality: 'final' } });
  assert.equal(account.code_hash, baseEncode(Buffer.from(d.wasmSha256.vault, 'hex')));
  let retired: Key;
  try {
    retired = JSON.parse(await readFile(dir + '/worker-retired-v1.private.json', 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    retired = keys.worker;
    await writeFile(dir + '/worker-retired-v1.private.json', JSON.stringify(retired), {
      flag: 'wx',
      mode: 0o600,
    });
  }
  let replacement: Key;
  try {
    replacement = JSON.parse(await readFile(dir + '/operator-key-v2.json', 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    const pair = KeyPair.fromRandom('ed25519');
    replacement = {
      accountId: d.operator,
      publicKey: pair.getPublicKey().toString(),
      secretKey: pair.toString(),
    };
    await writeFile(dir + '/operator-key-v2.json', JSON.stringify(replacement), {
      flag: 'wx',
      mode: 0o600,
    });
  }
  assert.notEqual(replacement.publicKey, retired.publicKey);
  let rotationHash = '';
  if (!(await absent(retired.publicKey))) {
    assert(
      (await native('operator')) < oldCost,
      'Do not fund an unrevoked original authorization.',
    );
    const old = await rpc.viewAccessKey({ accountId: d.operator, publicKey: retired.publicKey });
    assert(
      BigInt(old.nonce) < originalNonce,
      'Original request may have been included; reconcile before revocation.',
    );
    rotationHash = await sendOnce('worker-gas-key-rotation', 'operator', d.operator, [
      actions.deleteKey(PublicKey.fromString(retired.publicKey)),
      actions.addFunctionCallAccessKey(
        PublicKey.fromString(replacement.publicKey),
        d.vault,
        ['request_payment'],
        nativeAmount('0.09'),
      ),
    ]);
  } else {
    rotationHash = JSON.parse(
      await readFile(dir + '/worker-gas-key-rotation.receipt.json', 'utf8'),
    ).hash;
  }
  assert(await absent(retired.publicKey), 'Old authorization key is not provably revoked.');
  assert.equal(await view('get_attempt', { request_id: requestId }), null);
  const current = await rpc.viewAccessKey({
    accountId: d.operator,
    publicKey: replacement.publicKey,
  });
  assertOperatorPolicy(d, current.permission, account.code_hash);
  assert(
    current.permission !== 'FullAccess' &&
      'FunctionCall' in current.permission &&
      current.permission.FunctionCall.allowance === nativeAmount('0.09').toString(),
  );
  keys.worker = replacement;
  await writeFile(dir + '/accounts.private.json', JSON.stringify(keys, null, 2), { mode: 0o600 });
  assert(
    (await native('supplier')) >= float + nativeAmount('0.015'),
    'Preserve supplier operating funds.',
  );
  const transferHash = await sendOnce('worker-gas-temporary-float', 'supplier', d.operator, [
    actions.transfer(float),
  ]);
  assert(
    (await native('operator')) >= nativeAmount('0.082'),
    'Worker needs the bounded payment prepayment reserve.',
  );
  const proof = {
    checkedAt: new Date().toISOString(),
    network: 'mainnet',
    orderId,
    requestId,
    originalHash,
    originalNonce: originalNonce.toString(),
    originalKeyRevoked: true,
    retiredPublicKey: retired.publicKey,
    replacementPublicKey: replacement.publicKey,
    rotationHash,
    allowanceYocto: nativeAmount('0.09').toString(),
    floatYocto: float.toString(),
    floatFrom: d.accounts.supplier,
    floatTo: d.operator,
    transferHash,
    additionalExternalFunding: '0',
  };
  await writeFile(dir + '/worker-gas-recovery-evidence.json', JSON.stringify(proof, null, 2));
  console.log(JSON.stringify(proof));
} else {
  const attempt: any = await view('get_attempt', { request_id: requestId });
  assert.equal(attempt.status, 'Settled');
  assert.equal(attempt.amount, '10000');
  assert.equal(attempt.recipient, d.accounts.supplier);
  const prior = JSON.parse(await readFile(dir + '/worker-gas-recovery-evidence.json', 'utf8'));
  assert(prior.originalKeyRevoked);
  assert(await absent(prior.retiredPublicKey));
  assert(
    (await native('operator')) >= float + nativeAmount('0.003'),
    'Do not overspend the remaining worker balance.',
  );
  const hash = await sendOnce('worker-gas-return-float', 'operator', d.accounts.supplier, [
    actions.transfer(float),
  ]);
  prior.returnFloatHash = hash;
  prior.floatReturnedYocto = float.toString();
  prior.completedAt = new Date().toISOString();
  await writeFile(dir + '/worker-gas-recovery-evidence.json', JSON.stringify(prior, null, 2));
  console.log(JSON.stringify({ returnedYocto: float.toString(), hash }));
}
