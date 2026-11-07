import { test, expect } from '@playwright/test';
import type { ChainState, ChainJob, ChainOrder, ChainAttempt } from '../../shared/chain';

// Wallet and RPC doubles exist only inside this browser test. The application
// ships no testing sign-in hook or signing bypass.
test('wallet payment history filters records, links receipts, and opens related orders', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/src/testnet/Wallet.ts*', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `const listeners = new Map(); const c = { on: (k,v) => listeners.set(k,v), off: (k) => listeners.delete(k), disconnect: async () => listeners.get('wallet:signOut')?.(), connect: async () => {} }; export const walletConnector = () => c; export const accountId = async () => 'buyer.testnet'; export const sendCall = async () => { throw new Error('Signing is disabled in this test'); };`,
    }),
  );
  const own: ChainOrder = {
    id: 'PO-TEAM-001',
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
    accepted: '70',
    paid: '40',
    pending: '15',
    sequence: '2',
    attempts: 4,
  };
  const other: ChainOrder = { ...own, id: 'PO-OTHER-999', buyer: 'other.testnet' };
  const statuses = ['settled', 'submitting', 'unresolved', 'queued', 'failed'] as const;
  const jobs: ChainJob[] = statuses.map((status, i) => ({
    id: `request-${i + 1}`,
    orderId: own.id,
    status,
    quantity: i === 0 ? '40' : i === 1 ? '10' : i === 3 ? '8' : '5',
    auditHash: 'a'.repeat(64),
    transactionHash: i < 3 ? `receipt-${i + 1}` : null,
    error: null,
    createdAt: `2026-11-07T10:0${i}:00.000Z`,
  }));
  const attempts: ChainAttempt[] = [
    {
      request_id: jobs[0].id,
      order_id: own.id,
      quantity: '40',
      amount: '400000000',
      recipient: own.terms.payout,
      audit_hash: 'a'.repeat(64),
      status: 'Settled',
    },
    {
      request_id: jobs[1].id,
      order_id: own.id,
      quantity: '10',
      amount: '100000000',
      recipient: own.terms.payout,
      audit_hash: 'a'.repeat(64),
      status: 'Reserved',
    },
    {
      request_id: jobs[2].id,
      order_id: own.id,
      quantity: '5',
      amount: '50000000',
      recipient: own.terms.payout,
      audit_hash: 'a'.repeat(64),
      status: 'Reserved',
    },
  ];
  // This second record deliberately shares no role with the connected wallet.
  other.terms = {
    ...own.terms,
    supplier: 'other-supplier.testnet',
    receiver: 'other-receiver.testnet',
    operator: 'other-operator.testnet',
    payout: 'other-supplier.testnet',
  };
  const state: ChainState = {
    configured: true,
    deployment: {
      network: 'testnet',
      rpcUrl: '',
      vault: 'vault.testnet',
      token: 'token.testnet',
      operator: 'operator.testnet',
      accounts: {},
      wasmSha256: {},
    },
    orders: [own, other],
    attempts: [
      ...attempts,
      { ...attempts[0], request_id: 'unrelated-request', order_id: other.id },
    ],
    operatorReady: false,
    liveAiAvailable: false,
  };
  await page.route('**/api/chain/state*', (route) => route.fulfill({ json: state }));
  await page.route('**/api/chain/jobs', (route) =>
    route.fulfill({
      json: { jobs: [...jobs, { ...jobs[0], id: 'unrelated-job', orderId: other.id }] },
    }),
  );
  await page.goto('/workspace');
  await expect(page.getByRole('heading', { name: 'Payables', exact: true })).toBeVisible();
  await expect(page.getByText(other.id)).toHaveCount(0);
  await page.locator('.sidebar').getByRole('button', { name: 'Payments', exact: true }).click();
  const history = page.getByRole('region', { name: 'Payment history' });
  await expect(page.getByRole('heading', { name: 'Payments', exact: true })).toBeVisible();
  await expect(history.locator('tbody tr')).toHaveCount(5);
  await expect(
    page.locator('.payment-metrics .metric').filter({ hasText: 'In progress' }),
  ).toContainText('230');
  await expect(
    page.locator('.payment-metrics .metric').filter({ hasText: 'Needs review' }),
  ).toContainText('50');
  await expect(history).not.toContainText(/unrelated|PO-OTHER/);
  await expect(history.getByRole('link', { name: 'View receipt for request-1' })).toHaveAttribute(
    'href',
    'https://testnet.nearblocks.io/txns/receipt-1',
  );
  await history.getByRole('button', { name: /^Needs review/ }).click();
  await expect(history.locator('tbody tr')).toHaveCount(1);
  await expect(history.locator('tbody')).toContainText('request-3');
  await history.getByRole('button', { name: /^All payments/ }).click();
  await page.getByRole('textbox', { name: 'Search payments' }).fill('request-1');
  await expect(history.locator('tbody tr')).toHaveCount(1);
  await expect(history.locator('tbody')).toContainText('Paid');
  await page.getByRole('textbox', { name: 'Search payments' }).fill('nothing matches');
  await expect(page.getByRole('heading', { name: 'No matching payments' })).toBeVisible();
  await page.getByRole('button', { name: 'Clear filters' }).click();
  await page.screenshot({ path: 'test-results/payments-desktop.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/payments-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await history.getByRole('button', { name: own.id, exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Delivery cartons', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Disconnect', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connect your wallet.' })).toBeVisible();
  await expect(page.locator('.sidebar')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(own.id);
  expect(errors).toEqual([]);
});
