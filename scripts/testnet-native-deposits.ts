import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { Account, KeyPair, actions, baseEncode, type KeyPairString } from 'near-api-js';
import { FinalizedRpcProvider } from '../server/rpc.ts';
import type { Deployment, ChainOrder, ChainRecovery, ChainNativeDeposit } from '../shared/chain.ts';

const mode = process.argv[2] ?? 'status';
assert(['status', 'upgrade', 'verify'].includes(mode));
const d = JSON.parse(await readFile('.data/deployment.json', 'utf8')) as Deployment;
assert.equal(d.network, 'testnet');
assert.equal(d.rpcUrl, 'https://test.rpc.fastnear.com');
assert(d.vault.endsWith('.testnet') && d.token.endsWith('.testnet'));
const rpc = new FinalizedRpcProvider({ url: d.rpcUrl });
const view = async <T>(method: string, args: Record<string, unknown> = {}) =>
  (await rpc.callFunction({ contractId: d.vault, method, args })) as T;
if (mode === 'status') {
  console.log(
    JSON.stringify({
      network: d.network,
      vault: d.vault,
      version: await view('get_version'),
      codeHash: (await rpc.viewAccount({ accountId: d.vault, blockQuery: { finality: 'final' } }))
        .code_hash,
    }),
  );
} else {
  const bytes = await readFile('.data/wasm/vault.wasm');
  const expected = createHash('sha256').update(bytes).digest('hex');
  assert.equal(
    expected,
    '4dec1dc5acb8b3c2c75df77de705fb4ff8d6a27146c366b19d04e4b2c03dec94',
    'Only the reviewed normal native-deposit candidate may deploy.',
  );
  for (const [name, count] of [
    ['sandbox-evidence', 9],
    ['recovery-sandbox-evidence', 11],
    ['invoice-sandbox-evidence', 9],
    ['automatic-sandbox-evidence', 8],
    ['security-sandbox-evidence', 5],
  ] as const) {
    const proof = JSON.parse(await readFile(`.data/${name}.json`, 'utf8'));
    assert.equal(proof.wasmSha256.vault, expected, name);
    assert.equal(proof.checks.length, count);
    assert(proof.checks.every((c: { status: string }) => c.status === 'PASS'));
  }
  const native = JSON.parse(await readFile('.data/native-deposit-sandbox-evidence.json', 'utf8'));
  assert.equal(native.wasmSha256.vault, expected);
  assert.equal(native.completed, true);
  assert.equal(native.checks.length, 8);
  assert(native.checks.every((c: { status: string }) => c.status === 'PASS'));
  assert.equal(native.snapshots.maximumCapacity.beforeClaim.invoice_limit, 32);
  assert.equal(native.snapshots.maximumCapacity.beforeClaim.payment_attempt_limit, 64);
  const keys = JSON.parse(await readFile('.data/testnet-credentials.json', 'utf8')) as {
    root: { accountId: string; secretKey: KeyPairString };
    accounts: Record<string, { accountId: string; secretKey: KeyPairString }>;
  };
  const actor = (key: { accountId: string; secretKey: KeyPairString }) => {
    assert(key.accountId.endsWith('.testnet'));
    return new Account(key.accountId, rpc, key.secretKey);
  };
  const vault = actor(keys.accounts.vault),
    originalBuyer = actor(keys.accounts.buyer);
  let buyer = originalBuyer;
  assert.equal(vault.accountId, d.vault);
  async function snapshot() {
    const orders: ChainOrder[] = [];
    for (let start = 0; start < 1000; start += 50) {
      const page = await view<ChainOrder[]>('list_orders', { from_index: start, limit: 50 });
      orders.push(...page);
      if (page.length < 50) break;
      assert(start < 950, 'Order snapshot must not truncate.');
    }
    const records = await Promise.all(
      orders.map(async (o) => {
        const recovery = await view<ChainRecovery>('get_recovery', { order_id: o.id });
        assert.equal(o.pending, '0', 'Wait for pending payments before upgrade');
        assert.equal(recovery.refund_pending, '0', 'Wait for pending refunds before upgrade');
        return {
          order: o,
          recovery,
          invoices: await view('list_invoices', { order_id: o.id }),
          policy: await view('get_payment_policy', { order_id: o.id }),
        };
      }),
    );
    const tokenBalance = await rpc.callFunction({
      contractId: d.token,
      method: 'ft_balance_of',
      args: { account_id: d.vault },
    });
    return { records, tokenBalance };
  }
  const outputPath = '.data/native-deposit-testnet-evidence.json';
  let proof: {
    network: string;
    vault: string;
    wasmSha256: string;
    orderId: string;
    transactions: { method: string; hash: string }[];
    checks: string[];
    before?: unknown;
    final?: unknown;
  };
  try {
    proof = JSON.parse(await readFile(outputPath, 'utf8'));
    assert.equal(proof.wasmSha256, expected);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    proof = {
      network: 'testnet',
      vault: d.vault,
      wasmSha256: expected,
      orderId: 'PO-NATIVE-' + randomBytes(4).toString('hex').toUpperCase(),
      transactions: [],
      checks: [],
    };
  }
  const persist = () => writeFile(outputPath, JSON.stringify(proof, null, 2) + '\n');
  if (mode === 'upgrade') {
    const chain = await rpc.viewAccount({ accountId: d.vault, blockQuery: { finality: 'final' } });
    if (chain.code_hash !== baseEncode(Buffer.from(expected, 'hex'))) {
      assert.equal(
        chain.code_hash,
        baseEncode(
          Buffer.from('2eb011ff5989660c2ce6939ad8bd616e77ca9d7df3fd10d87e0aa9980ac74f04', 'hex'),
        ),
        'Unexpected existing deployment',
      );
      const before = await snapshot();
      proof.before = before;
      await persist();
      const result = await vault.signAndSendTransaction({
        receiverId: d.vault,
        actions: [
          actions.deployContract(bytes),
          actions.functionCall('get_version', {}, 30_000_000_000_000n, 0n),
        ],
        waitUntil: 'FINAL',
      });
      assert(typeof result.status === 'object' && 'SuccessValue' in result.status);
      proof.transactions.push({
        method: 'atomic_native_deposit_upgrade',
        hash: result.transaction.hash,
      });
      assert.deepEqual(await snapshot(), before);
      proof.checks.push(
        'Atomic upgrade preserved every listed order, invoice, policy, recovery and settlement-token balance.',
      );
    }
    assert.equal(await view('get_version'), '2.4.0-native-deposits');
    const next: Deployment = {
      ...d,
      wasmSha256: { ...d.wasmSha256, vault: expected },
      features: [...new Set([...(d.features ?? []), 'native-deposits-v1' as const])],
    };
    await writeFile('.data/deployment.json', JSON.stringify(next, null, 2) + '\n');
    await persist();
    console.log(
      JSON.stringify({
        upgraded: true,
        version: '2.4.0-native-deposits',
        vault: d.vault,
        transactions: proof.transactions,
      }),
    );
  } else {
    assert.equal(
      (await rpc.viewAccount({ accountId: d.vault, blockQuery: { finality: 'final' } })).code_hash,
      baseEncode(Buffer.from(expected, 'hex')),
    );
    assert.equal(await view('get_version'), '2.4.0-native-deposits');
    async function call(method: string, args: Record<string, unknown>, deposit: bigint) {
      const r = await buyer.callFunctionRaw({
        contractId: d.vault,
        methodName: method,
        args,
        deposit,
        gas: 150_000_000_000_000n,
        waitUntil: 'FINAL',
      });
      assert(typeof r.status === 'object' && 'SuccessValue' in r.status);
      proof.transactions.push({ method, hash: r.transaction.hash });
      await persist();
    }
    let order = await view<ChainOrder | null>('get_order', { order_id: proof.orderId });
    let fixture: { accountId: string; secretKey: KeyPairString; publicKey: string } | undefined;
    const fixturePath = '.data/native-deposit-buyer.json';
    try {
      fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!fixture && !order && (await buyer.getBalance()) < 1_300_000_000_000_000_000_000_000n) {
      const pair = KeyPair.fromRandom('ed25519');
      fixture = {
        accountId: 'accord-deposit-' + randomBytes(4).toString('hex') + '.testnet',
        secretKey: pair.toString(),
        publicKey: pair.getPublicKey().toString(),
      };
      await writeFile(fixturePath, JSON.stringify(fixture, null, 2) + '\n', {
        flag: 'wx',
        mode: 0o600,
      });
    }
    if (fixture) {
      buyer = actor(fixture);
      try {
        await buyer.getState();
      } catch (error) {
        if (
          !/does not exist|doesn't exist|unknown_account|AccountDoesNotExist/i.test(String(error))
        )
          throw error;
        const response = await fetch('https://helper.testnet.near.org/account', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            newAccountId: fixture.accountId,
            newAccountPublicKey: fixture.publicKey,
          }),
          signal: AbortSignal.timeout(45000),
        });
        assert(
          response.ok,
          'The free testnet faucet could not provision the test buyer. Its key remains private for a retry.',
        );
        await buyer.getState();
      }
      const keyWaitStarted = Date.now();
      while (true) {
        try {
          const key = await rpc.viewAccessKey({
            accountId: fixture.accountId,
            publicKey: fixture.publicKey,
          });
          assert.equal(key.permission, 'FullAccess');
          break;
        } catch (error) {
          if (
            !/AccessKeyDoesNotExist|AccountDoesNotExist|does not exist|unknown_account/i.test(
              String(error),
            ) ||
            Date.now() - keyWaitStarted > 45000
          )
            throw error;
          // Wait for faucet creation to finalize; never retry a signed transaction here.
          await delay(1000);
        }
      }
    }
    if (!order) {
      const available = await buyer.getBalance();
      assert(
        available >= 1_300_000_000_000_000_000_000_000n,
        'The testnet fixture needs free faucet funds. Mainnet funding is never used.',
      );
      await call(
        'create_automatic_order',
        {
          order_id: proof.orderId,
          terms: {
            supplier: keys.accounts.supplier.accountId,
            receiver: buyer.accountId,
            operator: d.operator,
            payout: keys.accounts.supplier.accountId,
            line_id: 'native-credit',
            description: 'Storage deposit verification',
            unit: 'carton',
            ordered: '10',
            unit_price: '1000000',
            expires_at: (BigInt(Date.now() + 86400000) * 1_000_000n).toString(),
          },
        },
        1_250_000_000_000_000_000_000_000n,
      );
      order = await view<ChainOrder>('get_order', { order_id: proof.orderId });
    }
    let c = await view<ChainNativeDeposit>('get_native_deposit', { order_id: proof.orderId });
    assert(c.tracked && c.deposit?.owner === buyer.accountId);
    assert.equal(c.deposit.pending, '0', 'Unknown native refund must be reconciled, not repeated');
    if ((await view<ChainRecovery>('get_recovery', { order_id: proof.orderId })).phase === 'Open') {
      if (BigInt(c.claimable) > 0n)
        await call('claim_native_excess', { order_id: proof.orderId }, 1n);
      c = await view<ChainNativeDeposit>('get_native_deposit', { order_id: proof.orderId });
      assert.equal(c.deposit?.pending, '0');
      await call('cancel_unfunded_order', { order_id: proof.orderId }, 1n);
    }
    c = await view<ChainNativeDeposit>('get_native_deposit', { order_id: proof.orderId });
    if (BigInt(c.claimable) > 0n)
      await call('claim_native_excess', { order_id: proof.orderId }, 1n);
    c = await view<ChainNativeDeposit>('get_native_deposit', { order_id: proof.orderId });
    assert.equal(c.claimable, '0');
    assert.equal(c.deposit?.pending, '0');
    assert(BigInt(c.deposit!.refunded) > 1_200_000_000_000_000_000_000_000n);
    assert.equal(
      BigInt(c.deposit!.deposited) -
        BigInt(c.deposit!.refunded) -
        BigInt(c.deposit!.call_deposits_spent),
      BigInt(c.retained_required),
    );
    proof.final = {
      order: await view('get_order', { order_id: proof.orderId }),
      credit: c,
      recovery: await view('get_recovery', { order_id: proof.orderId }),
    };
    if (
      !proof.checks.includes(
        'Buyer recovered open-order excess and then remaining eligible allowance after unfunded cancellation; only retained-record backing remains.',
      )
    )
      proof.checks.push(
        'Buyer recovered open-order excess and then remaining eligible allowance after unfunded cancellation; only retained-record backing remains.',
      );
    await persist();
    console.log(
      JSON.stringify({
        verified: true,
        orderId: proof.orderId,
        credit: c,
        transactions: proof.transactions,
      }),
    );
  }
}
