import { test } from 'node:test';
import assert from 'node:assert/strict';
import { baseEncode, type AccessKeyView } from 'near-api-js';
import type { Deployment } from '../shared/chain.ts';
import { assertOperatorPolicy } from '../server/operator-policy.ts';

test('payment service refuses broad keys, unbounded allowances and contract code drift', () => {
  const d: Deployment = {
    network: 'testnet',
    rpcUrl: '',
    token: 'token.testnet',
    operator: 'operator.testnet',
    accounts: {},
    vault: 'vault.testnet',
    wasmSha256: { vault: 'a'.repeat(64) },
  };
  const valid = {
    receiver_id: d.vault,
    method_names: ['request_payment'],
    allowance: '1000000000000000000000000',
  };
  const hash = baseEncode(Buffer.from(d.wasmSha256.vault, 'hex'));
  assert.doesNotThrow(() => assertOperatorPolicy(d, { FunctionCall: valid }, hash));
  const unsafe: AccessKeyView['permission'][] = [
    'FullAccess',
    ...[
      { receiver_id: 'other.testnet' },
      { method_names: [] },
      { method_names: ['request_payment', 'confirm_delivery'] },
      { method_names: ['confirm_delivery'] },
      { allowance: null },
      { allowance: '0' },
      { allowance: '-1' },
    ].map((change) => ({ FunctionCall: { ...valid, ...change } })),
  ];
  for (const permission of unsafe) assert.throws(() => assertOperatorPolicy(d, permission, hash));
  assert.throws(
    () => assertOperatorPolicy(d, { FunctionCall: valid }, 'changed-code'),
    /configured release/,
  );
  assert.throws(
    () => assertOperatorPolicy({ ...d, wasmSha256: {} }, { FunctionCall: valid }, hash),
    /configured release/,
  );
});
