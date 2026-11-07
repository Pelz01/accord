import { test, expect } from '@playwright/test';

test('a failed workspace import offers a safe reload and preserves the requested view', async ({
  page,
}) => {
  let attempts = 0;
  await page.route('**/src/testnet/TestnetWorkspace.tsx*', (route) =>
    ++attempts === 1 ? route.abort('failed') : route.continue(),
  );
  await page.goto('/workspace?view=supplier');
  await expect(
    page.getByRole('heading', { name: 'Accord couldn’t finish loading.' }),
  ).toBeVisible();
  await expect(page.locator('.metric')).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: 'test-results/loading-recovery-mobile.png' });
  await page.getByRole('button', { name: 'Reload Accord', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Connect your wallet.' })).toBeVisible();
  expect(new URL(page.url()).searchParams.get('view')).toBe('supplier');
  expect(new URL(page.url()).searchParams.has('_accord_reload')).toBe(false);
  expect(attempts).toBe(2);
});
