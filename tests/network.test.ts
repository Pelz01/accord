import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertDeploymentNetwork,
  networkRPC,
  orderAllowance,
  tokenSymbol,
  walletGas,
} from '../shared/network.ts';
import { deploymentBudget, MAINNET_USDC, nativeAmount } from '../shared/mainnet-readiness.ts';
import type { Deployment } from '../shared/chain.ts';
import { WalletSessions } from '../server/sessions.ts';
import { Ledger } from '../server/ledger.ts';

test('mainnet wallet gas fits the controlled balance without dropping below callback minimums', () => {
  assert.equal(walletGas('mainnet', 'create_automatic_order'), '50000000000000');
  assert.equal(walletGas('mainnet', 'ft_transfer_call'), '70000000000000');
  assert(BigInt(walletGas('mainnet', 'accept_close')) >= 80_000_000_000_000n);
  assert(BigInt(walletGas('mainnet', 'claim_native_excess')) >= 40_000_000_000_000n);
  assert.equal(walletGas('testnet', 'create_automatic_order'), '150000000000000');
});

test('mainnet requires the correct RPC, native USDC and mainnet role accounts', () => {
  const d: Deployment = {
    network: 'mainnet',
    rpcUrl: networkRPC('mainnet'),
    token: MAINNET_USDC,
    vault: 'accord.near',
    operator: 'operator.near',
    wasmSha256: {},
    accounts: {},
  };
  assert.doesNotThrow(() => assertDeploymentNetwork(d, 'mainnet'));
  for (const change of [
    { network: 'testnet' },
    { rpcUrl: networkRPC('testnet') },
    { token: 'bridged.near' },
    { vault: 'vault.testnet' },
    { operator: 'operator.testnet' },
  ])
    assert.throws(() => assertDeploymentNetwork({ ...d, ...change } as Deployment, 'mainnet'));
  assert.equal(tokenSymbol(d.token), 'USDC');
  const budget = deploymentBudget(
    256674,
    10n ** 19n,
    nativeAmount('3'),
    BigInt(orderAllowance('mainnet')),
  );
  assert.equal(budget.minimumRequired, nativeAmount('2.66674'));
  assert.equal(budget.exceedsCap, false);
  assert.equal(orderAllowance('testnet'), '1000000000000000000000000');
});

test('wallet challenges name their network and vault and sessions do not cross isolated databases', async () => {
  const t = new Ledger(':memory:'),
    m = new Ledger(':memory:');
  try {
    const verifier = async () => {};
    const ts = new WalletSessions(t.db, 'https://accord.example', verifier, undefined, {
      network: 'testnet',
      vault: 'vault.testnet',
    });
    const ms = new WalletSessions(m.db, 'https://accord.example', verifier, undefined, {
      network: 'mainnet',
      vault: 'vault.near',
    });
    const tc = ts.challenge('buyer.near'),
      mc = ms.challenge('buyer.near');
    assert.equal(JSON.parse(mc.message).network, 'mainnet');
    assert.equal(JSON.parse(mc.message).vault, 'vault.near');
    assert.notEqual(tc.message, mc.message);
    const session = await ts.accept({
      challengeId: tc.id,
      accountId: 'buyer.near',
      publicKey: 'test',
      signature: 'test',
    });
    assert.throws(() => ms.account('Bearer ' + session.token));
    await assert.rejects(
      ms.accept({
        challengeId: tc.id,
        accountId: 'buyer.near',
        publicKey: 'test',
        signature: 'test',
      }),
    );
  } finally {
    t.close();
    m.close();
  }
});
