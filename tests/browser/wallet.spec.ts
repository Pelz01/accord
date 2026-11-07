import { test, expect } from '@playwright/test';

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
