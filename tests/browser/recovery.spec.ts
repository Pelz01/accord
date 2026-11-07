import { expect, test, type Page } from '@playwright/test';
import type { ChainOrder, ChainRecovery, ChainState } from '../../shared/chain';

const order: ChainOrder = {
  id: 'PO-CLOSE-001',
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
  paid: '70',
  pending: '0',
  sequence: '2',
  attempts: 2,
};
const recovery: ChainRecovery = {
  phase: 'Open',
  refunded: '0',
  refund_pending: '0',
  refunds: [],
  proposal: {
    hash: 'c'.repeat(64),
    proposed_by: 'buyer.testnet',
    expires_at: '1900000000000000000',
    refund_amount: '300000000',
  },
};
function stateFor(o: ChainOrder, r: ChainRecovery): ChainState {
  return {
    configured: true,
    deployment: {
      network: 'testnet',
      rpcUrl: '',
      vault: 'vault.testnet',
      token: 'token.testnet',
      operator: 'operator.testnet',
      accounts: {},
      wasmSha256: {},
      features: ['recovery-v1'],
    },
    orders: [o],
    attempts: [],
    recoveries: { [o.id]: r },
    operatorReady: true,
    liveAiAvailable: true,
  };
}
async function installWallet(page: Page, account: string) {
  // Isolated test module replacement; no wallet bypass ships in the product.
  await page.route('**/src/testnet/Wallet.ts*', (route) =>
    route.fulfill({
      contentType: 'application/javascript',
      body: `
    const c={on:()=>{},off:()=>{},disconnect:async()=>{},connect:async()=>{}};
    export const walletConnector=()=>c;
    export const accountId=async()=>${JSON.stringify(account)};
    export const sendCall=async(contract,method,args)=>{
      const response=await fetch('/__test_wallet_call',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contract,method,args})});
      if(!response.ok)throw new Error('Wallet request declined.');
      return 'test-wallet-transaction';
    };
  `,
    }),
  );
}

test('supplier reviews exact buyer refund and signs the snapshot before closure', async ({
  page,
}) => {
  await installWallet(page, 'supplier.testnet');
  const state = stateFor(structuredClone(order), structuredClone(recovery));
  const calls: unknown[] = [];
  await page.route('**/api/chain/state*', (r) => r.fulfill({ json: state }));
  await page.route('**/api/chain/jobs', (r) => r.fulfill({ json: { jobs: [] } }));
  await page.route('**/__test_wallet_call', async (route) => {
    const body = route.request().postDataJSON();
    calls.push(body);
    expect(body).toEqual({
      contract: 'vault.testnet',
      method: 'accept_close',
      args: { order_id: order.id, proposal_hash: recovery.proposal!.hash },
    });
    state.recoveries![order.id] = {
      phase: 'Closed',
      proposal: null,
      refunded: '300000000',
      refund_pending: '0',
      refunds: [{ id: 1, amount: '300000000', recipient: 'buyer.testnet', status: 'Settled' }],
    };
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/workspace');
  await page.getByRole('button', { name: order.id, exact: true }).click();
  const panel = page.getByRole('region', { name: 'Closure and recovery' });
  await expect(panel).toContainText('300');
  await panel.getByRole('button', { name: 'Review closure' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('buyer.testnet');
  await expect(dialog).not.toContainText(/local|simulation/i);
  await expect(dialog.getByRole('button', { name: 'Continue in wallet' })).toBeDisabled();
  expect(calls).toHaveLength(0);
  await dialog.getByRole('checkbox').check();
  await page.screenshot({ path: 'test-results/refund-review-desktop.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Continue in wallet' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel).toContainText('Returned to buyer');
  await expect(panel).toContainText('Closed');
  await expect(page.getByRole('button', { name: 'Confirm delivery', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Review closure' })).toHaveCount(0);
  expect(calls).toHaveLength(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(panel).toBeVisible();
  await page.screenshot({ path: 'test-results/refund-closed-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

test('recipient recovery requires explicit receipt confirmation and preserves a declined review', async ({
  page,
}) => {
  await installWallet(page, 'supplier.testnet');
  const o = { ...structuredClone(order), accepted: '40', paid: '0', pending: '40' };
  const state = stateFor(o, { ...structuredClone(recovery), proposal: null });
  state.attempts = [
    {
      request_id: 'missing-callback',
      order_id: o.id,
      quantity: '40',
      amount: '400000000',
      recipient: 'supplier.testnet',
      audit_hash: 'b'.repeat(64),
      status: 'Reserved',
    },
  ];
  let calls = 0;
  await page.route('**/api/chain/state*', (r) => r.fulfill({ json: state }));
  await page.route('**/api/chain/jobs', (r) => r.fulfill({ json: { jobs: [] } }));
  await page.route('**/__test_wallet_call', async (route) => {
    calls++;
    expect(route.request().postDataJSON()).toEqual({
      contract: 'vault.testnet',
      method: 'acknowledge_payment',
      args: { request_id: 'missing-callback' },
    });
    if (calls === 1) {
      await route.fulfill({ status: 400, json: { error: 'declined' } });
      return;
    }
    o.paid = '40';
    o.pending = '0';
    state.attempts[0].status = 'ReceiptAcknowledged';
    await route.fulfill({ json: { ok: true } });
  });
  await page.goto('/workspace');
  await page.getByRole('button', { name: o.id, exact: true }).click();
  const panel = page.getByRole('region', { name: 'Closure and recovery' });
  await expect(panel.getByRole('button', { name: 'Propose closure' })).toBeDisabled();
  await panel.getByRole('button', { name: 'I received this payment' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('sends no additional tokens');
  await expect(dialog.getByRole('button', { name: 'Confirm receipt' })).toBeDisabled();
  await dialog.getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Confirm receipt' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Wallet request declined.');
  await dialog.getByRole('button', { name: 'Confirm receipt' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'I received this payment' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Propose closure' })).toBeEnabled();
  await expect(page.getByText('Recipient confirmed', { exact: true })).toBeVisible();
  expect(calls).toBe(2);
});
