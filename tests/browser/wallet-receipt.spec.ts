import { test, expect } from '@playwright/test';
import type { ChainOrder, ChainState } from '../../shared/chain';

for (const initiallyVisible of [true, false]) {
  test(`an incomplete creation receipt ${initiallyVisible ? 'recovers the finalized order' : 'holds creation across reload'} without a second wallet request`, async ({
    page,
  }) => {
    const state: ChainState = {
      configured: true,
      orders: [],
      attempts: [],
      operatorReady: true,
      liveAiAvailable: false,
      deployment: {
        network: 'testnet',
        rpcUrl: 'https://test.rpc.fastnear.com',
        vault: 'vault.testnet',
        token: 'token.testnet',
        operator: 'operator.testnet',
        accounts: {},
        wasmSha256: {},
        features: ['automatic-v1'],
      },
    };
    let walletCalls = 0;
    let createdId = '';
    await page.exposeFunction(
      'submitOrderWithoutReceipt',
      (args: { order_id: string; terms: ChainOrder['terms'] }) => {
        walletCalls++;
        createdId = args.order_id;
        if (initiallyVisible)
          state.orders.push({
            id: args.order_id,
            buyer: 'buyer.testnet',
            token: 'token.testnet',
            terms: args.terms,
            terms_hash: 'a'.repeat(64),
            accepted_terms: false,
            funded: '0',
            accepted: '0',
            paid: '0',
            pending: '0',
            sequence: '0',
            attempts: 0,
          });
      },
    );
    await page.route('**/src/testnet/Wallet.ts*', (route) =>
      route.fulfill({
        contentType: 'application/javascript',
        body: `import {WalletReceiptUnavailable} from '/shared/wallet-result.ts';export const accountId=async()=> 'buyer.testnet';export const walletConnector=()=>({on:()=>{},off:()=>{}});export const sendCall=async(_contract,_method,args)=>{await window.submitOrderWithoutReceipt(args);throw new WalletReceiptUnavailable();};`,
      }),
    );
    await page.route('**/api/chain/state*', (route) => route.fulfill({ json: state }));
    await page.route('**/api/chain/jobs', (route) => route.fulfill({ json: { jobs: [] } }));
    const create = async () => {
      await page.getByRole('button', { name: 'New purchase order', exact: true }).click();
      await page.getByLabel('Item description').fill('Receipt recovery order');
      await page.getByLabel('Supplier account', { exact: true }).fill('supplier.testnet');
      await page.getByRole('button', { name: 'Create purchase order', exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
    };
    await page.goto('/workspace?view=orders');
    await create();
    expect(walletCalls).toBe(1);
    if (initiallyVisible) {
      await expect(
        page.getByRole('heading', { name: 'Receipt recovery order', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('alert')).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp('order=' + createdId));
    } else {
      await expect(page.getByRole('alert')).toContainText('may have been submitted');
      await page.reload();
      await page.getByRole('button', { name: 'New purchase order', exact: true }).click();
      await page.getByLabel('Item description').fill('Another order');
      await page.getByLabel('Supplier account', { exact: true }).fill('supplier.testnet');
      await page.getByRole('button', { name: 'Create purchase order', exact: true }).click();
      await expect(page.getByRole('dialog').getByRole('alert')).toContainText('still unresolved');
      expect(walletCalls).toBe(1);
    }
  });
}
