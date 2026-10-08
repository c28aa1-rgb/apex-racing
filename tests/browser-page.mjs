// Shared setup for the Playwright browser scripts in tests/.
// The home screen no longer loads a circuit until one is chosen, and a loading screen with
// trailer clips covers the page until it is dismissed. These helpers handle both.

/** Base address of the dev server; set GAME_URL (or BASE) to use another port, e.g. the dev-alt preview on 5174. */
export const BASE = process.env.GAME_URL ?? process.env.BASE ?? 'http://127.0.0.1:5173';

/** Full URL for a path on the dev server, e.g. gameUrl('/dev'). */
export const gameUrl = (path = '/') => new URL(path, BASE).href;

/** Presses Space until the boot loading screen has gone (it only accepts input once loading is complete). */
export async function dismissLoading(page, timeout = 60000) {
  const until = Date.now() + timeout;
  while (await page.locator('.loading-screen').count()) {
    if (Date.now() > until) throw new Error('The loading screen did not close.');
    await page.keyboard.press('Space'); await page.waitForTimeout(400);
  }
}

/**
 * Waits for the game to be usable: car loaded, loading screen dismissed and, unless `track: false`,
 * the selected circuit prepared for driving (selecting it when the menu has only shown a preview).
 */
export async function gameReady(page, { track = true, timeout = 180000 } = {}) {
  await page.waitForFunction(() => window.__apex?.state.modelReady, null, { timeout });
  await dismissLoading(page);
  if (!track) return;
  await page.evaluate(() => { const g = window.__apex; if (!g.state.trackReady && !g.state.trackLoading) void g.select(g.state.track, true); });
  await page.waitForFunction(() => window.__apex.state.trackReady, null, { timeout });
}

/** Opens a page of the game and waits until it is ready (see gameReady). */
export async function openGame(page, path = '/', options) {
  await page.goto(gameUrl(path));
  await gameReady(page, options);
}
