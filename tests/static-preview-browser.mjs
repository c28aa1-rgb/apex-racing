// With npm run dev running: node tests/static-preview-browser.mjs
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { gameUrl, gameReady } from './browser-page.mjs';
const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  const courses = [], errors = [];
  page.on('request', request => { if (/\/models\/tracks\/.*\.(glb|bin)(\?|$)/.test(request.url())) courses.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(gameUrl('/'));
  await gameReady(page, { track: false });
  await page.getByRole('button', { name: 'Race this track Enter', exact: true }).waitFor();
  await page.getByRole('button', { name: /02 Spa-Francorchamps Expert/ }).click();
  await page.locator('.track-preview[alt="Spa-Francorchamps — Sketchfab preview"]').waitFor();
  // Rapid selection must settle on the latest decoded photograph and details.
  await page.getByRole('button', { name: /03 Hungaroring Technical/ }).click();
  await page.getByRole('button', { name: /01 Bugatti Circuit Intermediate/ }).click();
  await page.getByRole('button', { name: /02 Spa-Francorchamps Expert/ }).click();
  await page.waitForFunction(() => {
    const images = document.querySelectorAll('.track-preview');
    return images.length === 1 && images[0].getAttribute('alt') === 'Spa-Francorchamps — Sketchfab preview'
      && getComputedStyle(images[0]).opacity === '1'
      && document.querySelector('.track-info h1')?.textContent === 'Spa-Francorchamps';
  });
  assert.equal(courses.length, 0, 'Browsing track previews must not download a course.');
  await page.getByRole('button', { name: 'Race this track Enter', exact: true }).click();
  await page.getByRole('button', { name: 'Pause race', exact: true }).waitFor({ timeout: 60000 });
  assert.ok(courses.some(url => url.includes('spa.clean.glb')));
  assert.ok(courses.some(url => url.includes('collision/spa.bin')));
  assert.deepEqual(errors, []);
  console.log('Static preview and deferred race loading passed.');
} finally { await browser.close(); }
