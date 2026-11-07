import { test, expect } from '@playwright/test';
import type { ChainOrder, ChainState } from '../../shared/chain';

test('hosted invoice extraction obtains a wallet session before sending invoice text', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/src/testnet/Wallet.ts*', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `const c={on:()=>{},off:()=>{},wallet:async()=>({signMessage:async()=>({accountId:'operator.testnet',publicKey:'test-key',signature:'test-signature'})})};export const walletConnector=()=>c;export const accountId=async()=>'operator.testnet';export const sendCall=async()=>{throw new Error('No transactions expected')};`,
    }),
  );
  const order: ChainOrder = {
    id: 'PO-AUTH-001',
    buyer: 'buyer.testnet',
    token: 'token.testnet',
    terms: {
      supplier: 'supplier.testnet',
      receiver: 'receiver.testnet',
      operator: 'operator.testnet',
      payout: 'supplier.testnet',
      line_id: 'cartons',
      description: 'Packing cartons',
      unit: 'carton',
      ordered: '100',
      unit_price: '10000000',
      expires_at: '1900000000000000000',
    },
    terms_hash: 'a'.repeat(64),
    accepted_terms: true,
    funded: '1000000000',
    accepted: '40',
    paid: '0',
    pending: '0',
    sequence: '1',
    attempts: 0,
  };
  const state: ChainState = {
    configured: true,
    authRequired: true,
    liveAiAvailable: true,
    operatorReady: true,
    orders: [order],
    attempts: [],
    deployment: {
      network: 'testnet',
      rpcUrl: '',
      vault: 'vault.testnet',
      token: 'token.testnet',
      operator: 'operator.testnet',
      accounts: {},
      wasmSha256: {},
    },
  };
  await page.route('**/api/chain/state*', (route) => route.fulfill({ json: state }));
  await page.route('**/api/chain/jobs', (route) => route.fulfill({ json: { jobs: [] } }));
  const challengeId = 'c8f18473-c52c-4dd9-ae04-b77be5418852';
  let authenticated = false,
    extractions = 0;
  await page.route('**/api/chain/session/challenge', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ accountId: 'operator.testnet' });
    await route.fulfill({
      json: {
        id: challengeId,
        nonce: Buffer.alloc(32, 1).toString('base64'),
        message: 'Authorize invoice processing',
        recipient: 'Accord invoice access',
      },
    });
  });
  await page.route('**/api/chain/session', async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      challengeId,
      accountId: 'operator.testnet',
      publicKey: 'test-key',
      signature: 'test-signature',
    });
    authenticated = true;
    await route.fulfill({
      json: {
        token: 'test-session-token',
        accountId: 'operator.testnet',
        expires: Date.now() + 60000,
      },
    });
  });
  await page.route('**/api/chain/orders/PO-AUTH-001/extract', async (route) => {
    expect(authenticated).toBe(true);
    expect(route.request().headers().authorization).toBe('Bearer test-session-token');
    expect(route.request().postDataJSON()).toEqual({
      text: 'Supplier invoice: 100 cartons at 10 aUSD',
      mode: 'live',
    });
    extractions++;
    await route.fulfill({
      json: {
        id: 'extraction-1',
        mode: 'live',
        orderId: order.id,
        model: 'recorded-test',
        documentHash: 'b'.repeat(64),
        recordedAt: new Date().toISOString(),
        providerRequestId: 'test-request',
        invoice: {
          orderId: order.id,
          lineId: 'cartons',
          reference: 'INV-AUTH-001',
          quantity: 100,
          token: 'aUSD',
          amountBaseUnits: '1000000000',
        },
      },
    });
  });
  await page.goto('/workspace');
  await page.getByRole('button', { name: order.id, exact: true }).click();
  await page.getByRole('button', { name: 'Review invoice', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Invoice source text' })
    .fill('Supplier invoice: 100 cartons at 10 aUSD');
  await page.getByRole('button', { name: 'Extract invoice', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'INV-AUTH-001', exact: true })).toBeVisible();
  expect(extractions).toBe(1);
  expect(errors).toEqual([]);
});
