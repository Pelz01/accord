import { test, expect } from '@playwright/test';
import type { ChainOrder, ChainState } from '../../shared/chain';

test('disconnected users see the wallet gate without orders or balances', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/workspace');
  await expect(page.getByRole('heading', { name: 'Connect your wallet.' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Connect wallet', exact: true })).toBeVisible();
  await expect(page.locator('.sidebar')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Purchase orders', exact: true })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(
    /Accord workspace|PO-TESTNET|PO-WORKER|Meridian|Unexpected end of JSON/,
  );
  await expect(page.locator('.metric')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/wallet-gate-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Connect wallet', exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/wallet-gate-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);
});

for (const action of ['funding', 'invoice access'] as const) {
  test(`an expired wallet during ${action} returns to the gate and can reconnect`, async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const order: ChainOrder = {
      id: 'PO-RECONNECT-001',
      buyer: 'buyer.testnet',
      token: 'token.testnet',
      terms: {
        supplier: 'supplier.testnet',
        receiver: 'receiver.testnet',
        operator: 'operator.testnet',
        payout: 'supplier.testnet',
        line_id: 'cartons',
        description: 'Packaged coffee',
        unit: 'carton',
        ordered: '10',
        unit_price: '10000000',
        expires_at: '1900000000000000000',
      },
      terms_hash: 'a'.repeat(64),
      accepted_terms: true,
      funded: action === 'funding' ? '0' : '100000000',
      accepted: '0',
      paid: '0',
      pending: '0',
      sequence: '0',
      attempts: 0,
    };
    const state: ChainState = {
      configured: true,
      authRequired: true,
      orders: [order],
      attempts: [],
      operatorReady: true,
      liveAiAvailable: true,
      deployment: {
        network: 'testnet',
        rpcUrl: 'https://test.rpc.fastnear.com',
        vault: 'vault.testnet',
        token: order.token,
        operator: order.terms.operator,
        accounts: {},
        wasmSha256: {},
      },
    };
    // Simulate loss after the initial connection. No real wallet credentials or calls are used.
    await page.route('**/src/testnet/Wallet.ts*', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `const listeners=new Map();const c={on:(k,v)=>listeners.set(k,v),off:(k)=>listeners.delete(k),connect:async()=>listeners.get('wallet:signIn')?.({accounts:[{accountId:'buyer.testnet'}]}),wallet:async()=>({signMessage:async()=>{throw 'Account is disconnected';}})};export const walletConnector=()=>c;export const accountId=async()=> 'buyer.testnet';export const sendCall=async()=>{throw new Error('No accounts found');};`,
      }),
    );
    await page.route('**/api/chain/state*', (route) => route.fulfill({ json: state }));
    await page.route('**/api/chain/jobs', (route) => route.fulfill({ json: { jobs: [] } }));
    await page.route('**/api/chain/session/challenge', (route) =>
      route.fulfill({
        json: {
          id: 'reconnect-challenge',
          nonce: Buffer.alloc(32).toString('base64'),
          message: 'Invoice access',
          recipient: 'Accord',
        },
      }),
    );
    let privateReads = 0;
    await page.route(`**/api/chain/orders/${order.id}/invoices`, (route) => {
      privateReads++;
      return route.fulfill({ json: { invoices: [] } });
    });
    await page.goto('/workspace');
    await page.getByRole('button', { name: order.id, exact: true }).click();
    if (action === 'funding') {
      await page.getByRole('button', { name: 'Prepare & fund', exact: true }).click();
      await page.getByRole('button', { name: 'Register & fund with wallet', exact: true }).click();
    } else {
      await page.getByRole('button', { name: 'Review invoice', exact: true }).click();
      await page.getByRole('button', { name: 'Load saved invoices', exact: true }).click();
    }
    await expect(page.getByRole('heading', { name: 'Connect your wallet.' })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveText(
      'Your wallet connection ended. Connect again to continue.',
    );
    await expect(page.locator('.metric')).toHaveCount(0);
    await expect(page.getByRole('button', { name: order.id, exact: true })).toHaveCount(0);
    expect(privateReads).toBe(0);
    await page.getByRole('button', { name: 'Connect wallet', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Payables', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: order.id, exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Prepare token funding' })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Review supplier invoice' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });
}
