import { test, expect } from '@playwright/test';
test('sample order, invoice, partial payment, reconnect, and responsive workspace', async ({
  page,
}) => {
  await page.goto('/dev/simulator');
  await expect(page.getByRole('heading', { name: 'Purchase orders', exact: true })).toBeVisible();
  if (await page.getByRole('button', { name: 'Explore a sample' }).isVisible())
    await page.getByRole('button', { name: 'Explore a sample' }).click();
  else await page.getByRole('button', { name: /PO-0001/ }).click();
  await expect(page.getByRole('heading', { name: 'Meridian Supply Co.' })).toBeVisible();
  await page.screenshot({ path: 'test-results/order-desktop.png', fullPage: true });
  await page.getByRole('combobox', { name: 'Demo actor' }).selectOption('operator');
  const pay = page.getByRole('button', { name: 'Review invoice', exact: true });
  if (await pay.isEnabled()) {
    await pay.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', { name: 'Extract invoice', exact: true }).click();
    await expect(page.getByText('Order and fixed price match')).toBeVisible();
    await page.screenshot({ path: 'test-results/invoice-desktop.png', fullPage: true });
    await page.getByRole('button', { name: 'Review partial payment' }).click();
    await page.getByRole('button', { name: 'Reserve & simulate payment' }).click();
    await expect(page.getByText('settled', { exact: true }).first()).toBeVisible({
      timeout: 12000,
    });
    await page.reload();
    await page.getByRole('button', { name: /PO-0001/ }).click();
    await expect(page.getByText('settled', { exact: true }).first()).toBeVisible();
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/order-mobile.png', fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await page.getByRole('button', { name: 'All purchase orders' }).click();
  await page.screenshot({ path: 'test-results/orders-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: 'test-results/orders-desktop.png', fullPage: true });
  await page.getByRole('button', { name: 'Evidence & controls', exact: true }).click();
  await page.getByRole('button', { name: 'Redirect payment' }).click();
  await expect(page.getByText('Request blocked', { exact: true })).toBeVisible();
});

test('create, accept, fund, and confirm a custom purchase order with separate roles', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/dev/simulator');
  await page.getByRole('button', { name: 'New purchase order', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Supplier name', { exact: true }).fill('Atlas Packaging');
  await dialog.getByLabel('Item description').fill('Delivery cartons');
  await dialog.getByLabel('Supplier account', { exact: true }).fill('atlas.testnet');
  await dialog.getByLabel('Fixed payout account').fill('atlas.testnet');
  await dialog.getByRole('button', { name: 'Create purchase order', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Atlas Packaging', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Review & accept' })).toBeDisabled();
  await page.getByRole('combobox', { name: 'Demo actor' }).selectOption('supplier');
  await page.getByRole('button', { name: 'Review & accept' }).click();
  await page.getByRole('button', { name: 'Accept exact terms' }).click();
  await page.getByRole('combobox', { name: 'Demo actor' }).selectOption('buyer');
  await page.getByRole('button', { name: 'Fund order', exact: true }).click();
  await page.getByRole('button', { name: 'Simulate funding' }).click();
  await page.getByRole('combobox', { name: 'Demo actor' }).selectOption('receiver');
  await page.getByRole('button', { name: 'Confirm delivery', exact: true }).click();
  await page.getByLabel('New cumulative quantity').fill('40');
  await page.getByRole('button', { name: 'Confirm cumulative receipt' }).click();
  await expect(page.getByText('Ready to pay', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});
