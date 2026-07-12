// Optional browser smoke test for TROG.
// Requires: npm install -D playwright && npx playwright install chromium
// Run with a server already listening, e.g. GAME_PORT=8089 python main.py

const BASE = process.env.TROG_BASE || 'http://127.0.0.1:8089';

async function main() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (err) {
    console.log('[SKIP] playwright module not installed');
    return 0;
  }

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
  try {
    await page.goto(BASE, { waitUntil: 'domcontentloaded' });
    await page.click('#entry-help-btn');
    await page.waitForSelector('.help-modal, #help-modal, [role="dialog"]', { timeout: 3000 }).catch(() => {});
    const helpVisible = await page.locator('text=/도움말|명령어|단축키/').first().isVisible().catch(() => false);
    if (!helpVisible) throw new Error('entry help modal did not become visible');
    await page.keyboard.press('Escape').catch(() => {});

    await page.fill('#player-name', 'SmokeA');
    await page.click('#create-room-btn');
    await page.waitForSelector('#waiting-screen.active', { timeout: 5000 });
    const roomCode = (await page.textContent('#display-room-code')).trim();
    if (!/^[A-Z0-9]{6}$/.test(roomCode)) throw new Error(`bad room code: ${roomCode}`);

    const hint = await page.textContent('#ready-hint');
    if (!hint || hint.length < 2) throw new Error('ready hint missing');

    console.log(`[OK] browser smoke passed room=${roomCode}`);
    return 0;
  } finally {
    await browser.close();
  }
}

main().then(code => process.exit(code)).catch(err => {
  console.error('[FAIL]', err && err.stack || err);
  process.exit(1);
});
