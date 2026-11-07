import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import type { ChainOrder, ChainState, ChainJob, ChainAttempt } from '../../shared/chain';
import type { InvoicePayload } from '../../shared/invoices';

const buyer = 'buyer.testnet';
const base: ChainOrder = {
  id: 'PO-COFFEE',
  buyer,
  token: 'token.testnet',
  terms: {
    supplier: 'supplier.testnet',
    receiver: 'receiver.testnet',
    operator: 'operator.testnet',
    payout: 'payout.testnet',
    line_id: 'cartons',
    description: 'Coffee cartons',
    unit: 'carton',
    ordered: '100',
    unit_price: '10000000',
    expires_at: '1900000000000000000',
  },
  terms_hash: 'a'.repeat(64),
  accepted_terms: true,
  funded: '1000000000',
  accepted: '60',
  paid: '20',
  pending: '10',
  sequence: '1',
  attempts: 2,
};
const invoice: InvoicePayload = {
  order_id: base.id,
  terms_version: 1,
  terms_hash: base.terms_hash,
  document_hash: 'b'.repeat(64),
  reference: 'INV-COFFEE-001',
  line_id: 'cartons',
  quantity: '100',
  token: base.token,
  amount: '1000000000',
};
function fixtures() {
  const needing = {
    ...structuredClone(base),
    id: 'PO-INVOICE',
    accepted: '10',
    paid: '0',
    pending: '0',
    attempts: 0,
  };
  const closed = {
    ...structuredClone(base),
    id: 'PO-CLOSED',
    terms: { ...base.terms, ordered: '10' },
    funded: '100000000',
    accepted: '4',
    paid: '4',
    pending: '0',
    attempts: 1,
  };
  const selling = {
    ...structuredClone(base),
    id: 'PO-SELL',
    buyer: 'another-buyer.testnet',
    terms: { ...base.terms, supplier: buyer, payout: buyer },
    accepted: '0',
    paid: '0',
    pending: '0',
    attempts: 0,
  };
  const outsider = {
    ...structuredClone(base),
    id: 'PO-PRIVATE-OTHER',
    buyer: 'outsider.testnet',
    terms: {
      ...base.terms,
      supplier: 'outside-supplier.testnet',
      receiver: 'outside-receiver.testnet',
      operator: 'outside-operator.testnet',
      payout: 'outside-payout.testnet',
    },
  };
  const attempts: ChainAttempt[] = [
    ['paid-1', '20', 'Settled'],
    ['pending-1', '10', 'Reserved'],
  ].map(([id, quantity, status]) => ({
    request_id: id,
    order_id: base.id,
    quantity,
    amount: (BigInt(quantity) * 10000000n).toString(),
    recipient: base.terms.payout,
    audit_hash: invoice.document_hash,
    status: status as ChainAttempt['status'],
  }));
  attempts.push({
    request_id: 'closed-paid',
    order_id: closed.id,
    quantity: '4',
    amount: '40000000',
    recipient: closed.terms.payout,
    audit_hash: 'd'.repeat(64),
    status: 'Settled',
  });
  const jobs: ChainJob[] = [
    ['paid-1', '20', 'settled'],
    ['pending-1', '10', 'submitting'],
    ['queued-1', '5', 'queued'],
  ].map(([id, quantity, status]) => ({
    id,
    orderId: base.id,
    quantity,
    auditHash: invoice.document_hash,
    status: status as ChainJob['status'],
    transactionHash: status === 'queued' ? null : 'receipt-' + id,
    error: null,
    createdAt: '2026-11-07T10:00:00.000Z',
    vault: 'vault.testnet',
    network: 'testnet',
    invoice,
  }));
  const state: ChainState = {
    configured: true,
    orders: [structuredClone(base), needing, closed, selling, outsider],
    attempts,
    deployment: {
      network: 'testnet',
      rpcUrl: '',
      vault: 'vault.testnet',
      token: base.token,
      operator: base.terms.operator,
      accounts: {},
      wasmSha256: {},
      features: ['invoice-v1', 'recovery-v1', 'documents-v1'],
    },
    confirmations: {
      [base.id]: [{ supplier: base.terms.supplier, commitment: 'c'.repeat(64), invoice }],
    },
    recoveries: {
      [closed.id]: {
        phase: 'Closed',
        proposal: null,
        refund_pending: '0',
        refunded: '60000000',
        refunds: [{ id: 1, amount: '60000000', recipient: buyer, status: 'Settled' }],
      },
    },
    coverage: { ordersComplete: true, attemptsComplete: true, orderLimit: 50 },
    operatorReady: true,
    liveAiAvailable: true,
  };
  return { state, jobs };
}
async function setup(page: Page, fixture = fixtures(), account = buyer) {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  // An isolated browser fixture supplies wallet identity; it cannot sign or write to a chain.
  await page.route('**/src/testnet/Wallet.ts*', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `const listeners=new Map();const c={on:(k,v)=>listeners.set(k,v),off:k=>listeners.delete(k),disconnect:async()=>listeners.get('wallet:signOut')?.()};export const walletConnector=()=>c;export const accountId=async()=>${JSON.stringify(account)};export const sendCall=async()=>{throw new Error('No signing in reporting tests');};`,
    }),
  );
  await page.route('**/api/chain/state*', (route) => route.fulfill({ json: fixture.state }));
  await page.route('**/api/chain/jobs', (route) => route.fulfill({ json: { jobs: fixture.jobs } }));
  return errors;
}
async function exported(page: Page, label: string) {
  await page.getByText('Export CSV', { exact: true }).click();
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: label, exact: true }).click();
  const file = await download;
  return readFile((await file.path())!, 'utf8');
}

test('buyer overview separates reservations, invoice review and refunds; filtered exports match the view', async ({
  page,
}) => {
  const errors = await setup(page);
  await page.goto('/workspace');
  await expect(page.getByRole('heading', { name: 'Payables', exact: true })).toBeVisible();
  const metrics = page.locator('.report-metrics');
  await expect(
    metrics.locator('.metric').filter({ hasText: 'Ready to review' }).locator('.metric-value'),
  ).toContainText('250');
  await expect(
    metrics.locator('.metric').filter({ hasText: 'Invoice review' }).locator('.metric-value'),
  ).toContainText('100');
  await expect(
    metrics.locator('.metric').filter({ hasText: 'In progress' }).locator('.metric-value'),
  ).toContainText('150');
  await expect(
    metrics.locator('.metric').filter({ hasText: 'Still committed' }).locator('.metric-value'),
  ).toContainText('1,800');
  await expect(page.getByRole('region', { name: 'Order balance breakdown' })).toContainText(
    '1,300',
  );
  await expect(page.locator('.report-balance')).toContainText('60');
  await expect(page.getByRole('button', { name: 'PO-SELL', exact: true })).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('PO-PRIVATE-OTHER');
  await page.screenshot({ path: 'test-results/payables-desktop.png' });
  const all = await exported(page, 'Orders CSV');
  expect(all).toContain('PO-CLOSED');
  expect(all).toContain('"60"');
  expect(all).not.toContain('PO-SELL');
  expect(all).not.toContain('PO-PRIVATE-OTHER');
  const refunds = await exported(page, 'Refunds CSV');
  expect(refunds).toContain('"60000000"');
  expect(refunds).toContain('"Settled"');
  await page.getByRole('button', { name: 'Invoice review', exact: true }).click();
  await expect(page.locator('.report-table tbody tr')).toHaveCount(1);
  const filtered = await exported(page, 'Orders CSV');
  expect(filtered).toContain('PO-INVOICE');
  expect(filtered).not.toContain('PO-COFFEE');
  await page.getByRole('button', { name: 'All orders', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/payables-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);
});

test('supplier view scopes orders to the supplier or payout account and exports those records only', async ({
  page,
}) => {
  const errors = await setup(page);
  await page.goto('/workspace?view=supplier');
  await expect(page.getByRole('heading', { name: 'Supplier view', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'PO-SELL', exact: true })).toBeVisible();
  await expect(page.locator('.report-orders')).toContainText('another-buyer.testnet');
  await expect(page.locator('.report-orders')).not.toContainText('PO-COFFEE');
  const data = await exported(page, 'Orders CSV');
  expect(data).toContain('PO-SELL');
  expect(data).not.toContain('PO-COFFEE');
  await page.screenshot({ path: 'test-results/supplier-desktop.png' });
  await page.getByRole('button', { name: 'PO-SELL', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Supplier', exact: true })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'Supplier view', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/supplier-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  expect(errors).toEqual([]);
});

test('confirmed remittance binds invoice, amount and receipt; print and CSV retain the same facts', async ({
  page,
}) => {
  const errors = await setup(page);
  await page.goto('/workspace?view=payments');
  await expect(page.getByRole('link', { name: 'View remittance for paid-1' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'View remittance for pending-1' })).toHaveCount(0);
  const records = await exported(page, 'Payments CSV');
  expect(records).toContain('INV-COFFEE-001');
  expect(records).toContain('"Pending"');
  await page.getByRole('link', { name: 'View remittance for paid-1' }).click();
  await expect(page).toHaveURL(/view=payments&payment=paid-1/);
  const advice = page.getByRole('article', { name: 'Remittance advice' });
  await expect(advice).toContainText('200 aUSD');
  await expect(advice).toContainText('INV-COFFEE-001');
  await expect(advice).toContainText('20 cartons');
  await expect(advice).toContainText('Settlement confirmed by contract');
  await expect(advice.getByRole('link')).toHaveAttribute(
    'href',
    'https://testnet.nearblocks.io/txns/receipt-paid-1',
  );
  await page.screenshot({ path: 'test-results/remittance-desktop.png', fullPage: true });
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download CSV', exact: true }).click();
  const file = await download;
  const content = await readFile((await file.path())!, 'utf8');
  expect(content).toContain('"200000000"');
  expect(content).toContain('"Contract settlement"');
  expect(content).not.toContain('pending-1');
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.sidebar')).not.toBeVisible();
  await expect(page.locator('.advice-actions')).not.toBeVisible();
  await page.pdf({
    path: 'test-results/remittance.pdf',
    format: 'A4',
    printBackground: true,
    preferCSSPageSize: true,
  });
  await page.emulateMedia({ media: 'screen' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/remittance-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Remittance advice', exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('pending, missing and unrelated payments cannot produce final remittance; recipient acknowledgment stays distinct', async ({
  page,
}) => {
  const fixture = fixtures();
  const errors = await setup(page, fixture);
  await page.goto('/workspace?view=payments&payment=pending-1');
  await expect(page.getByRole('heading', { name: 'Payment awaiting confirmation' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Print / Save PDF' })).toHaveCount(0);
  await page.goto('/workspace?view=payments&payment=other-request');
  await expect(page.getByRole('heading', { name: 'Payment not available' })).toBeVisible();
  fixture.state.attempts[0].status = 'ReceiptAcknowledged';
  fixture.jobs = [];
  await page.goto('/workspace?view=payments&payment=paid-1');
  await expect(page.getByRole('article', { name: 'Remittance advice' })).toContainText(
    'Receipt acknowledged by recipient',
  );
  await expect(page.locator('body')).not.toContainText('Settlement confirmed by contract');
  await expect(page.getByRole('article', { name: 'Remittance advice' })).toContainText(
    'Not recorded',
  );
  expect(errors).toEqual([]);
});

test('partial source coverage is disclosed and wallet disconnection removes reports and advice', async ({
  page,
}) => {
  const fixture = fixtures();
  fixture.state.coverage = { ordersComplete: false, attemptsComplete: false, orderLimit: 50 };
  const errors = await setup(page, fixture);
  await page.goto('/workspace');
  await expect(page.getByRole('status')).toContainText('More orders may exist');
  const data = await exported(page, 'Orders CSV');
  expect(data).toContain('"partial"');
  await page
    .getByRole('navigation', { name: 'Workspace navigation' })
    .getByRole('button', { name: 'Payments', exact: true })
    .click();
  await expect(page.getByRole('status')).toContainText('Some payment attempts');
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connect your wallet.' })).toBeVisible();
  await expect(page.locator('body')).not.toContainText('PO-COFFEE');
  await expect(page.locator('.metric')).toHaveCount(0);
  expect(errors).toEqual([]);
});
