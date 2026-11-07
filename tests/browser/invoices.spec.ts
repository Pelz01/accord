import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type { ChainOrder, ChainState } from '../../shared/chain';
import { invoiceCommitment, type InvoicePayload, type SavedInvoice } from '../../shared/invoices';

const order: ChainOrder = {
  id: 'PO-WORKER-001',
  buyer: 'buyer.testnet',
  token: 'token.testnet',
  terms: {
    supplier: 'supplier.testnet',
    receiver: 'receiver.testnet',
    operator: 'operator.testnet',
    payout: 'supplier.testnet',
    line_id: 'cartons',
    description: 'Delivery cartons',
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
const bytes = readFileSync('fixtures/documents/invoice-scanned.pdf');
const hash = createHash('sha256').update(bytes).digest('hex');
const payload: InvoicePayload = {
  order_id: order.id,
  terms_version: 1,
  terms_hash: order.terms_hash,
  document_hash: hash,
  reference: 'INV-PDF-001',
  line_id: 'cartons',
  quantity: '100',
  token: order.token,
  amount: '1000000000',
};
function stateFor(): ChainState {
  return {
    configured: true,
    authRequired: true,
    orders: [structuredClone(order)],
    attempts: [],
    confirmations: { [order.id]: [] },
    operatorReady: true,
    liveAiAvailable: true,
    deployment: {
      network: 'testnet',
      rpcUrl: '',
      vault: 'vault.testnet',
      token: order.token,
      operator: order.terms.operator,
      accounts: {},
      wasmSha256: {},
      features: ['invoice-v1', 'documents-v1'],
    },
  };
}
async function wallet(page: Page, account: string) {
  await page.route('**/src/testnet/Wallet.ts*', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `const c={on:()=>{},off:()=>{},wallet:async()=>({signMessage:async()=>({accountId:${JSON.stringify(account)},publicKey:'test-key',signature:'test-proof'})})};export const walletConnector=()=>c;export const accountId=async()=>${JSON.stringify(account)};export const sendCall=async(contract,method,args)=>{await fetch('/__test_wallet_call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contract,method,args})});return 'test-confirmation-receipt';};`,
    }),
  );
}
async function session(page: Page, account: string) {
  await page.route('**/api/chain/session/challenge', (r) =>
    r.fulfill({
      json: {
        id: '11111111-1111-4111-8111-111111111111',
        nonce: Buffer.alloc(32).toString('base64'),
        message: 'Sign in',
        recipient: 'Accord invoice access',
      },
    }),
  );
  await page.route('**/api/chain/session', (r) =>
    r.fulfill({
      json: { token: 'test-invoice-token', accountId: account, expires: Date.now() + 60000 },
    }),
  );
}

test('supplier uploads a scan, reviews its original, and confirms exact extracted fields', async ({
  page,
}) => {
  await wallet(page, 'supplier.testnet');
  await session(page, 'supplier.testnet');
  const state = stateFor();
  await page.route('**/api/chain/state*', (r) => r.fulfill({ json: state }));
  await page.route('**/api/chain/jobs', (r) => r.fulfill({ json: { jobs: [] } }));
  const documentId = '22222222-2222-4222-8222-222222222222';
  let uploaded = false,
    confirmed = false;
  await page.route(`**/api/chain/orders/${order.id}/documents`, async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer test-invoice-token');
    expect(Buffer.from(route.request().postDataJSON().bytesBase64, 'base64')).toEqual(bytes);
    uploaded = true;
    await route.fulfill({
      json: {
        id: documentId,
        name: 'invoice-scanned.pdf',
        documentHash: hash,
        mediaType: 'application/pdf',
        pages: 1,
        source: 'ocr',
        text: 'Synthetic invoice 100 cartons for ' + order.id,
        previewBase64: readFileSync('fixtures/documents/invoice-scan.png').toString('base64'),
        previewType: 'image/png',
        expiresAt: new Date(Date.now() + 7 * 86400000).toISOString(),
      },
    });
  });
  await page.route(`**/api/chain/orders/${order.id}/extract`, async (route) => {
    expect(uploaded).toBe(true);
    expect(route.request().postDataJSON()).toEqual({ documentId, mode: 'live' });
    const record: SavedInvoice = {
      id: 'saved-review',
      orderId: order.id,
      mode: 'live',
      invoice: {
        orderId: order.id,
        reference: payload.reference,
        lineId: 'cartons',
        quantity: 100,
        token: 'aUSD',
        amountBaseUnits: '1000000000',
      },
      documentHash: hash,
      model: 'test-model',
      recordedAt: new Date().toISOString(),
      providerRequestId: 'test-provider',
      payload,
      documentId,
      sourceText: 'Synthetic invoice 100 cartons',
    };
    await route.fulfill({ json: record });
  });
  await page.route('**/__test_wallet_call', async (route) => {
    expect(route.request().postDataJSON()).toEqual({
      contract: 'vault.testnet',
      method: 'confirm_invoice',
      args: { order_id: order.id, invoice: payload },
    });
    confirmed = true;
    state.confirmations![order.id] = [
      {
        commitment: await invoiceCommitment('testnet', 'vault.testnet', payload),
        supplier: 'supplier.testnet',
        invoice: payload,
      },
    ];
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/workspace');
  await page.getByRole('button', { name: order.id, exact: true }).click();
  await page.getByRole('button', { name: 'Review invoice', exact: true }).click();
  await page
    .getByLabel('Upload invoice file', { exact: true })
    .setInputFiles('fixtures/documents/invoice-scanned.pdf');
  await expect(page.getByAltText('First page of invoice-scanned.pdf')).toBeVisible();
  await page.getByRole('button', { name: 'Extract invoice', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: payload.reference })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Confirm invoice', exact: true })).toBeDisabled();
  expect(confirmed).toBe(false);
  await dialog.getByRole('checkbox').check();
  await page.screenshot({ path: 'test-results/supplier-invoice-desktop.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Confirm invoice', exact: true }).click();
  await expect(dialog.getByText('Supplier confirmed', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Authorize payment' })).toHaveCount(0);
  expect(confirmed).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  await dialog.getByText('Supplier confirmed', { exact: true }).scrollIntoViewIfNeeded();
  await expect(dialog.getByText('Supplier confirmed', { exact: true })).toBeVisible();
  await page.screenshot({ path: 'test-results/supplier-invoice-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('operator payment authorization includes the supplier-confirmed invoice fields', async ({
  page,
}) => {
  await wallet(page, 'operator.testnet');
  const state = stateFor();
  state.confirmations![order.id] = [
    {
      commitment: await invoiceCommitment('testnet', 'vault.testnet', payload),
      supplier: 'supplier.testnet',
      invoice: payload,
    },
  ];
  await page.route('**/api/chain/state*', (r) => r.fulfill({ json: state }));
  await page.route('**/api/chain/jobs', (r) => r.fulfill({ json: { jobs: [] } }));
  let challenges = 0,
    submissions = 0;
  await page.route('**/api/chain/challenge', async (route) => {
    challenges++;
    expect(route.request().postDataJSON()).toEqual({
      orderId: order.id,
      quantity: '30',
      auditHash: hash,
      invoice: payload,
    });
    await route.fulfill({
      json: {
        id: '33333333-3333-4333-8333-333333333333',
        nonce: Buffer.alloc(32).toString('base64'),
        message: 'Bound payment',
        recipient: 'Accord testnet operator',
      },
    });
  });
  await page.route('**/api/chain/submit', async (route) => {
    submissions++;
    await route.fulfill({ json: { id: 'queued-request' } });
  });
  await page.goto('/workspace');
  await page.getByRole('button', { name: order.id, exact: true }).click();
  await page.getByRole('button', { name: 'Review invoice', exact: true }).click();
  await page.getByRole('button', { name: new RegExp(payload.reference) }).click();
  await page.getByLabel('Quantity to pay').fill('30');
  await expect(page.getByRole('button', { name: 'Confirm invoice', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Authorize payment' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Payment requested.' })).toBeVisible();
  expect(challenges).toBe(1);
  expect(submissions).toBe(1);
});
