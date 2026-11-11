import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import {
  Account,
  KeyPair,
  KeyPairSigner,
  PublicKey,
  SignedTransaction,
  actions,
  baseEncode,
  encodeTransaction,
  type KeyPairString,
} from 'near-api-js';
import { FinalizedRpcProvider } from '../server/rpc.ts';
import {
  MAINNET_USDC,
  VERIFIED_USDC_CODE_HASH,
  nativeAmount,
} from '../shared/mainnet-readiness.ts';
import { assertOperatorPolicy } from '../server/operator-policy.ts';
import type { Deployment } from '../shared/chain.ts';

const mode = process.argv[2] ?? 'status';
assert(['status', 'deploy-reviewed'].includes(mode));
const dir = '.data/mainnet';
const d = JSON.parse(await readFile(dir + '/deployment.json', 'utf8')) as Deployment;
const plan = JSON.parse(await readFile(dir + '/plan.json', 'utf8'));
assert.equal(d.network, 'mainnet');
assert.equal(d.rpcUrl, 'https://rpc.fastnear.com');
assert.equal(d.token, MAINNET_USDC);
assert.equal(plan.totalCapNear, '3');
assert.equal(plan.fundingAccount, 'mainnett12.near');
const rpc = new FinalizedRpcProvider({ url: d.rpcUrl });
const view = async <T>(method: string, args: Record<string, unknown> = {}) =>
  (await rpc.callFunction({ contractId: d.vault, method, args })) as T;
const balance = () =>
  rpc.viewAccount({ accountId: plan.fundingAccount, blockQuery: { finality: 'final' } });
if (mode === 'status') {
  console.log(
    JSON.stringify({
      network: d.network,
      funder: plan.fundingAccount,
      balance: (await balance()).amount.toString(),
      vault: d.vault,
      transactionsSent: 0,
    }),
  );
} else {
  const bytes = await readFile(dir + '/vault.wasm');
  const expected = 'beb76c43bd50db4cc763b2595835da7611124fbb60c70c6d0330185eeaa43d83';
  assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
  assert.equal(d.wasmSha256.vault, expected);
  for (const [name, count] of [
    ['sandbox-evidence', 9],
    ['recovery-sandbox-evidence', 11],
    ['invoice-sandbox-evidence', 9],
    ['automatic-sandbox-evidence', 8],
    ['security-sandbox-evidence', 5],
  ] as const) {
    const proof = JSON.parse(await readFile('.data/' + name + '.json', 'utf8'));
    assert.equal(proof.wasmSha256.vault, expected, name);
    assert.equal(proof.checks.length, count, name);
    assert(
      proof.checks.every((c: { status: string }) => c.status === 'PASS'),
      name,
    );
  }
  for (const [name, count] of [
    ['mainnet-sandbox-evidence', 4],
    ['native-deposit-sandbox-evidence', 8],
  ] as const) {
    const proof = JSON.parse(await readFile('.data/' + name + '.json', 'utf8'));
    assert.equal(
      name === 'mainnet-sandbox-evidence' ? proof.wasmSha256 : proof.wasmSha256.vault,
      expected,
      name,
    );
    assert.equal(proof.completed, true, name);
    assert.equal(proof.checks.length, count, name);
    assert(
      proof.checks.every((c: { status: string }) => c.status === 'PASS'),
      name,
    );
  }
  const usdc = await rpc.viewAccount({ accountId: d.token, blockQuery: { finality: 'final' } });
  assert.equal(usdc.code_hash, VERIFIED_USDC_CODE_HASH);
  const meta = await rpc.callFunction<{ decimals: number; symbol: string }>({
    contractId: d.token,
    method: 'ft_metadata',
    args: {},
  });
  assert(meta);
  assert.equal(meta.decimals, 6);
  assert.equal(meta.symbol, 'USDC');
  assert(
    BigInt((await balance()).amount) >= nativeAmount('0.12'),
    'Preserve the order allowance and buyer gas reserve.',
  );
  const keys = JSON.parse(await readFile(dir + '/accounts.private.json', 'utf8')) as Record<
    string,
    { accountId: string; publicKey: string; secretKey: KeyPairString }
  >;
  for (const name of ['vault', 'supplier', 'operator']) {
    const key = KeyPair.fromString(keys[name].secretKey);
    assert.equal(Buffer.from(key.getPublicKey().data).toString('hex'), keys[name].accountId);
    assert.equal(keys[name].accountId, d.accounts[name]);
  }
  async function sendOnce(
    name: string,
    role: string,
    receiverId: string,
    ops: Parameters<Account['createTransaction']>[0]['actions'],
  ) {
    const path = dir + '/' + name + '.signed.private.json';
    let stored: { hash: string; bytes: string };
    try {
      stored = JSON.parse(await readFile(path, 'utf8'));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      const signer = KeyPairSigner.fromSecretKey(keys[role].secretKey),
        actor = new Account(keys[role].accountId, rpc, signer);
      const tx = await actor.createTransaction({
        receiverId,
        publicKey: keys[role].publicKey,
        actions: ops,
      });
      const signed = (await signer.signTransaction(tx)).signedTransaction;
      stored = {
        hash: baseEncode(
          createHash('sha256').update(encodeTransaction(signed.transaction)).digest(),
        ),
        bytes: Buffer.from(signed.encode()).toString('base64'),
      };
      await writeFile(path, JSON.stringify(stored) + '\n', { flag: 'wx', mode: 0o600 });
    }
    const signed = SignedTransaction.decode(Buffer.from(stored.bytes, 'base64'));
    assert.equal(baseEncode(createHash('sha256').update(encodeTransaction(signed.transaction)).digest()),stored.hash,'Stored authorization hash changed.');
    assert.equal(signed.transaction.signerId, keys[role].accountId);
    assert.equal(signed.transaction.receiverId, receiverId);
    // Every restart uses the same saved authorization. No uncertain operation gets a new nonce.
    let result;
    try {
      result = await rpc.viewTransactionStatus({
        txHash: stored.hash,
        accountId: keys[role].accountId,
      });
    } catch {
      result = await rpc.sendTransactionUntil(signed, 'FINAL');
    }
    assert(
      typeof result.status === 'object' && !('Failure' in result.status),
      name + ' failed or remains uncertain; stop for review.',
    );
    const record = {
      name,
      hash: stored.hash,
      signer: keys[role].accountId,
      receiver: receiverId,
      status: result.status,
    };
    await writeFile(dir + '/' + name + '.receipt.json', JSON.stringify(record, null, 2) + '\n');
    console.log(JSON.stringify(record));
  }
  const target = await rpc.viewAccount({ accountId: d.vault, blockQuery: { finality: 'final' } });
  assert(
    BigInt(target.amount) >= nativeAmount('2.60'),
    'Contract setup needs its approved funding first.',
  );
  if (target.code_hash === '11111111111111111111111111111111') {
    await sendOnce('deploy', 'vault', d.vault, [
      actions.deployContract(bytes),
      actions.functionCall('new', { token: d.token, network: d.network }, 50_000_000_000_000n, 0n),
    ]);
  } else
    assert.equal(
      target.code_hash,
      baseEncode(Buffer.from(expected, 'hex')),
      'Unexpected existing contract; never overwrite it.',
    );
  const config = await view<{
    network: string;
    token: string;
    initial_storage_allowance: string;
    incremental_storage: boolean;
  }>('get_config');
  assert.equal(config.network, 'mainnet');
  assert.equal(config.token, d.token);
  assert.equal(config.initial_storage_allowance, '100000000000000000000000');
  assert.equal(config.incremental_storage, true);
  const workerPublic = keys.worker.publicKey;
  const access = await rpc.viewAccessKeyList({
    accountId: d.operator,
    finalityQuery: { finality: 'final' },
  });
  if (!access.keys.some((k) => k.public_key === workerPublic))
    await sendOnce('restrict-worker', 'operator', d.operator, [
      actions.addFunctionCallAccessKey(
        PublicKey.fromString(workerPublic),
        d.vault,
        ['request_payment'],
        nativeAmount('0.015'),
      ),
    ]);
  const workerKey = await rpc.viewAccessKey({ accountId: d.operator, publicKey: workerPublic });
  const deployed = await rpc.viewAccount({ accountId: d.vault, blockQuery: { finality: 'final' } });
  assertOperatorPolicy(d, workerKey.permission, deployed.code_hash);
  const proof = {
    checkedAt: new Date().toISOString(),
    network: 'mainnet',
    vault: d.vault,
    token: d.token,
    operator: d.operator,
    wasmSha256: expected,
    config,
    codeHash: deployed.code_hash,
    storageUsage: deployed.storage_usage,
    operatorPermission: workerKey.permission,
    version: await view('get_version'),
    fundingAccount: plan.fundingAccount,
    buyerBalanceYocto: (await balance()).amount.toString(),
    status: 'Contract deployed; restricted worker configured; order funding remains separate.',
  };
  await writeFile(dir + '/deployment-evidence.json', JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof, null, 2));
}
