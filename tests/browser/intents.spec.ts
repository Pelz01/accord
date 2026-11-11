import { test, expect, type Page } from '@playwright/test';
import { fundingRequest } from '../../shared/intents';
import { MAINNET_USDC } from '../../shared/mainnet-readiness';
import type { FundingRecord } from '../../server/intents';

async function setup(page: Page) {
  const account = 'buyer.near',
    calls: unknown[] = [];
  await page.exposeFunction('fundingWalletCall', (value: unknown) => calls.push(value));
  await page.route('**/src/testnet/Wallet.ts*', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `export const accountId=async()=>"buyer.near";export const sendCall=async()=>{throw Error('Unused');};export const walletConnector=()=>({on:()=>{},off:()=>{},wallet:async()=>({getAccounts:async()=>[{accountId:'buyer.near'}],signAndSendTransaction:async p=>{await window.fundingWalletCall(p);return {status:{SuccessValue:''},transaction:{hash:'${'A'.repeat(43)}'}};}})});`,
    }),
  );
  await page.route('**/api/chain/state*', (route) =>
    route.fulfill({
      json: {
        configured: true,
        deployment: {
          network: 'mainnet',
          rpcUrl: 'https://rpc.fastnear.com',
          vault: 'vault.near',
          token: MAINNET_USDC,
          operator: 'operator.near',
          accounts: { buyer: account },
          wasmSha256: {},
          features: ['intents-funding-v1'],
        },
        orders: [],
        attempts: [],
        operatorReady: true,
        liveAiAvailable: false,
      },
    }),
  );
  await page.route('**/api/chain/jobs', (route) => route.fulfill({ json: { jobs: [] } }));
  const request = fundingRequest(account, '0.01', new Date(Date.now() + 300000).toISOString());
  const record: FundingRecord = {
    id: '11111111-1111-4111-8111-111111111111',
    account,
    network: 'mainnet',
    vault: 'vault.near',
    createdAt: Date.now(),
    stage: 'quoted',
    request,
    quote: {
      account,
      amountIn: request.amount,
      amountOut: '30000',
      minAmountOut: '29700',
      depositAddress: 'deposit.near',
      deadline: request.deadline,
      slippageBps: 100,
    },
    registrations: [{ account: 'deposit.near', deposit: '1250000000000000000000' }],
    sourceHash: null,
    sourceVerified: false,
    destinationHash: null,
    providerStatus: 'PENDING_DEPOSIT',
    error: null,
  };
  let current: FundingRecord | null = null,
    receiptAvailable = false;
  await page.route('**/api/chain/intents/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/current')) return route.fulfill({ json: current });
    if (path.endsWith('/quote')) {
      current = structuredClone(record);
      return route.fulfill({ json: current });
    }
    if (path.endsWith('/begin')) {
      current!.stage = 'awaiting-wallet';
      return route.fulfill({ json: current });
    }
    if (path.endsWith('/receipt')) {
      expect(route.request().postDataJSON().hash).toBe('A'.repeat(43));
      if (!receiptAvailable)
        return route.fulfill({ status: 503, json: { error: 'Receipt temporarily unavailable.' } });
      current!.sourceHash = 'A'.repeat(43);
      current!.sourceVerified = true;
      current!.stage = 'submitted';
      return route.fulfill({ json: current });
    }
    if (path.endsWith('/cancel')) {
      current!.stage = 'cancelled';
      return route.fulfill({ json: current });
    }
    if (receiptAvailable) {
      current!.stage = 'settled';
      current!.destinationHash = 'B'.repeat(43);
    }
    return route.fulfill({ json: current });
  });
  await page.goto('/workspace?network=mainnet');
  await page.getByRole('button', { name: 'Wallet: buyer.near', exact: true }).click();
  await page.getByRole('button', { name: 'Add USDC', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Get quote', exact: true })).toBeEnabled();
  return {
    calls,
    record,
    makeReceiptAvailable: () => {
      receiptAvailable = true;
    },
  };
}
test('Intents funding reviews exact amounts, issues one atomic wallet request and reconciles a read outage without another deposit', async ({
  page,
}) => {
  const h = await setup(page);
  await page.getByRole('button', { name: 'Get quote', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('0.0297 USDC');
  await expect(dialog).toContainText('0.00125 NEAR');
  const approve = dialog.getByRole('button', { name: 'Continue in wallet', exact: true });
  await expect(approve).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await approve.click();
  await expect(dialog.getByRole('button', { name: 'Continue in wallet', exact: true })).toHaveCount(
    0,
  );
  await expect(dialog).toContainText('second deposit will not be requested');
  expect(h.calls).toHaveLength(1);
  expect(h.calls[0]).toMatchObject({
    network: 'mainnet',
    signerId: 'buyer.near',
    receiverId: 'wrap.near',
    actions: [
      {
        type: 'FunctionCall',
        params: { methodName: 'storage_deposit', deposit: '1250000000000000000000' },
      },
      {
        type: 'FunctionCall',
        params: { methodName: 'near_deposit', deposit: '10000000000000000000000' },
      },
      {
        type: 'FunctionCall',
        params: {
          methodName: 'ft_transfer',
          deposit: '1',
          args: { receiver_id: 'deposit.near', amount: '10000000000000000000000' },
        },
      },
    ],
  });
  h.makeReceiptAvailable();
  await dialog.getByRole('button', { name: 'Check status', exact: true }).click();
  await expect(dialog).toContainText('USDC received');
  expect(h.calls).toHaveLength(1);
  await expect(dialog.getByRole('link', { name: 'USDC receipt', exact: true })).toHaveAttribute(
    'href',
    'https://nearblocks.io/txns/' + 'B'.repeat(43),
  );
  await page.setViewportSize({ width: 320, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: 'test-results/intents-funding-mobile.png' });
});
test('a quote that expires before approval cannot request a funding transaction', async ({
  page,
}) => {
  const h = await setup(page);
  h.record.quote.deadline = new Date(Date.now() - 1000).toISOString();
  await page.getByRole('button', { name: 'Get quote', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Quote expired', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'Discard quote', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Get quote', exact: true })).toBeVisible();
  expect(h.calls).toHaveLength(0);
});
