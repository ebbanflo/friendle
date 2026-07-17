import { test, expect } from '@playwright/test';
import { openPage } from './helpers.js';

test('page boots with no console errors and the menu renders', async ({ context }) => {
  const errors = [];
  context.on('page', (p) => {
    p.on('pageerror', (e) => errors.push(String(e)));
    p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  });
  const page = await openPage(context);
  await expect(page.locator('.big-title .title-tile')).toHaveCount(8);
  await expect(page.locator('#btn-host')).toBeVisible();
  await expect(page.locator('#btn-sound')).toContainText('SOUND'); // menu-only toggle
  // help overlay covers all three modes
  await page.click('#btn-help-menu');
  await expect(page.locator('.help-card')).toContainText('CLASSIC');
  await expect(page.locator('.help-card')).toContainText('ROYALE');
  await expect(page.locator('.help-card')).toContainText('FRIEND');
  await page.click('#btn-help-close');
  expect(errors).toEqual([]);
});
