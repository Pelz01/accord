import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { FinalizedRpcProvider } from '../server/rpc.ts';
import { accountSchema } from '../shared/schema.ts';
import {
  MAINNET_USDC,
  deploymentBudget,
  nativeAmount,
  nativeDisplay,
  verifySettlementAsset,
} from '../shared/mainnet-readiness.ts';

// Read-only: no signer, account key, quote/deposit creation or transaction submission.
const account = accountSchema.parse(process.argv[2]);
const cap = nativeAmount(process.argv[3] ?? '0');
assert(cap > 0n, 'Supply an explicit positive NEAR budget.');
const provider = new FinalizedRpcProvider({ url: 'https://rpc.fastnear.com' });
const wasm = await readFile('.data/wasm/vault.wasm');
const [metadata, bounds, tokenAccount, accountState, protocol, assetsResponse] = await Promise.all([
  provider.callFunction<{ symbol: string; decimals: number; name: string }>({
    contractId: MAINNET_USDC,
    method: 'ft_metadata',
    args: {},
  }),
  provider.callFunction<{ min: string; max: string }>({
    contractId: MAINNET_USDC,
    method: 'storage_balance_bounds',
    args: {},
  }),
  provider.viewAccount({ accountId: MAINNET_USDC, blockQuery: { finality: 'final' } }),
  provider.viewAccount({ accountId: account, blockQuery: { finality: 'final' } }),
  provider.sendJsonRpc('EXPERIMENTAL_protocol_config', { finality: 'final' }),
  fetch('https://1click.chaindefuser.com/v0/tokens', { signal: AbortSignal.timeout(20000) }),
]);
assert(assetsResponse.ok, 'Intents asset discovery failed.');
assert(metadata, 'Native USDC metadata is unavailable.');
assert(bounds, 'Native USDC storage bounds are unavailable.');
const assetId = verifySettlementAsset(
  metadata,
  tokenAccount.code_hash,
  await assetsResponse.json(),
);
const runtime = protocol as unknown as { runtime_config: { storage_amount_per_byte: string } };
const budget = deploymentBudget(
  wasm.length,
  BigInt(runtime.runtime_config.storage_amount_per_byte),
  cap,
);
const report = {
  checkedAt: new Date().toISOString(),
  network: 'mainnet',
  account,
  authorizedBudgetNear: nativeDisplay(cap),
  nativeBalanceNear: nativeDisplay(accountState.amount),
  token: {
    contract: MAINNET_USDC,
    symbol: metadata.symbol,
    decimals: metadata.decimals,
    codeHash: tokenAccount.code_hash,
    registrationNear: nativeDisplay(BigInt(bounds.min)),
    intentsAssetId: assetId,
    issuerSource: 'https://developers.circle.com/stablecoins/usdc-contract-addresses',
  },
  artifact: { sha256: createHash('sha256').update(wasm).digest('hex'), bytes: wasm.length },
  lowerBound: {
    codeStorageNear: nativeDisplay(budget.codeStorage),
    retainedOrderDepositNear: nativeDisplay(budget.orderDeposit),
    requiredNear: nativeDisplay(budget.minimumRequired),
    exceedsAuthorizedCap: budget.exceedsCap,
    excludes: [
      'account/key state',
      'gas',
      'token registrations',
      'buyer/supplier/operator balances',
      'USDC acquisition and Intents fees',
    ],
  },
  deploymentReady: false,
  transactionsSent: 0,
  unresolved: [
    'Existing release is testnet-only. Mainnet app, worker, wallet, token labels and session/network separation still need implementation.',
    'Controlled accounts, explicit USDC funding amount, deployment-key custody and final artifact review are required.',
    'Unused funding still requires mutual closure; unknown transfers retain reservations.',
  ],
};
await writeFile('.data/mainnet-preflight.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
process.exitCode = budget.exceedsCap ? 2 : 0;
