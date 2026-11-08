import { baseEncode, type AccessKeyView } from 'near-api-js';
import type { Deployment } from '../shared/chain.ts';

export function assertOperatorPolicy(
  d: Deployment,
  permission: AccessKeyView['permission'],
  codeHash: string,
) {
  if (
    permission === 'FullAccess' ||
    !('FunctionCall' in permission) ||
    permission.FunctionCall.receiver_id !== d.vault ||
    permission.FunctionCall.method_names.length !== 1 ||
    permission.FunctionCall.method_names[0] !== 'request_payment'
  )
    throw new Error('Operator key is not narrowly scoped.');
  const allowance = permission.FunctionCall.allowance;
  if (!allowance || !/^[0-9]+$/.test(allowance) || BigInt(allowance) <= 0n)
    throw new Error('The payment service requires a finite, funded gas allowance.');
  if (
    !/^[a-f0-9]{64}$/.test(d.wasmSha256.vault ?? '') ||
    codeHash !== baseEncode(Buffer.from(d.wasmSha256.vault, 'hex'))
  )
    throw new Error('The payment contract does not match the configured release.');
}
