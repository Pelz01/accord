import { test, expect } from '@playwright/test';
test('public landing explains Accord and keeps the workspaces separate', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    'Supplier payments,on your terms.',
  );
  await expect(
    page.getByRole('link', { name: 'Explore the workspace', exact: true }),
  ).toHaveAttribute('href', '/workspace');
  await expect(page.locator('body')).not.toContainText(
    /ILLUSTRATIVE EXAMPLE|aUSD TEST TOKEN|Fixed supplier payout|Delivery-based limits|Built on NEAR|Current release terms/,
  );
  await expect(page.locator('.product-backdrop')).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Demo actor' })).toHaveCount(0);
  await page.screenshot({ path: 'test-results/landing-desktop.png' });
  await page.getByRole('button', { name: 'Preview payment', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Settled', exact: true })).toBeVisible();
  await expect(page.getByText('Every accepted carton is paid.')).toBeVisible();
  await page.getByRole('button', { name: 'Reset example' }).click();
  await page.getByRole('tab', { name: /02.*Confirm what actually arrived/ }).click();
  await expect(page.getByRole('tabpanel')).toContainText('40 cartons, accounted for.');
  await expect(page.getByRole('img', { name: /warehouse receiver/ })).toBeVisible();
  await page
    .locator('.landing-workflow')
    .screenshot({ path: 'test-results/landing-workflow.png', animations: 'disabled' });
  await page.getByRole('button', { name: 'Can the agent change the agreed payout?' }).click();
  await expect(page.getByText(/The supplier accepts a fixed payout account/)).toBeVisible();
  await page.screenshot({ path: 'test-results/landing-full.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: 'test-results/landing-mobile.png' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('navigation', { name: 'Website navigation' })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Website navigation' })
    .getByRole('link', { name: 'How it works', exact: true })
    .click();
  await expect(page.getByRole('navigation', { name: 'Website navigation' })).not.toBeVisible();
  expect(errors).toEqual([]);
});
