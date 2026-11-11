// Browser check of the real game UI: starts a local server, plays through the
// screens in headless Chromium (phone + desktop size), saves screenshots and
// fails on any JavaScript error.
//
//   NODE_PATH=<folder with playwright>/node_modules node tools/ui-check.cjs [outDir]
//
// Env: PLAYWRIGHT_BROWSERS_PATH (where Chromium is), UI_QUICK=1 (skip the full
// match, ~20 s instead of ~2-3 min).
const { chromium } = require('playwright');
const { mkdirSync, mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');

const OUT = path.resolve(process.argv[2] || 'ui-shots');
const QUICK = !!process.env.UI_QUICK;
mkdirSync(OUT, { recursive: true });

const problems = [];
const shots = [];
const log = (...a) => console.log('[ui]', ...a);

async function main() {
  const statsDir = mkdtempSync(path.join(tmpdir(), 'cr-ui-'));
  process.env.STATS_FILE = path.join(statsDir, 'stats.json');
  process.env.SIM_ITEMS = process.env.SIM_ITEMS || '40'; // plenty of power-ups to look at
  process.env.SIM_FUEL = process.env.SIM_FUEL || '6';    // start with 2 rockets, to try them
  const { startServer } = await import(path.resolve(__dirname, '../server/index.js'));
  const srv = await startServer({ port: 0, statsFile: process.env.STATS_FILE });
  const url = `http://localhost:${srv.port}/`;
  const browser = await chromium.launch();
  try {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    const desktop = await browser.newContext({ viewport: { width: 1280, height: 800 } });

    const watch = (page, who) => {
      page.on('pageerror', (e) => problems.push(`${who}: page error: ${e.message}`));
      page.on('console', (m) => { if (m.type() === 'error') problems.push(`${who}: console error: ${m.text()}`); });
      page.on('requestfailed', (r) => problems.push(`${who}: request failed: ${r.url()}`));
    };
    const shot = async (page, name) => {
      const file = path.join(OUT, `${name}.png`);
      await page.screenshot({ path: file });
      shots.push(file);
      log('screenshot', name);
    };
    const visible = (page, sel) => page.locator(sel).isVisible();
    const expectVisible = async (page, sel, what) => {
      if (!(await visible(page, sel))) problems.push(`${what}: ${sel} is not visible`);
    };
    // Elements that stick out of the screen are a layout bug on phones.
    const checkOverflow = async (page, name) => {
      const bad = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('.panel:not([hidden]) *')) {
          const r = el.getBoundingClientRect();
          if (r.width && (r.right > innerWidth + 1 || r.left < -1)) out.push(`${el.tagName.toLowerCase()}#${el.id || ''}.${el.className || ''}`);
        }
        return out.slice(0, 5);
      });
      if (bad.length) problems.push(`${name}: sticks out of the screen: ${bad.join(', ')}`);
    };

    // ---- phone: menu, style, leaderboard
    const p = await phone.newPage();
    watch(p, 'phone');
    await p.goto(url);
    await p.waitForSelector('#play:not([disabled])', { timeout: 15000 });
    await p.fill('#name', 'Tester');
    await p.waitForTimeout(300);
    await shot(p, '01-phone-menu');
    await checkOverflow(p, 'menu');

    await p.click('#skin-open');
    await expectVisible(p, '#skin', 'style panel');
    await shot(p, '02-phone-style');
    await checkOverflow(p, 'style panel');
    await p.click('#swatches button[data-c="2"]');
    await p.click('#styles button[data-s="neon"]'); // locked at level 1
    const msg = await p.textContent('#skin-msg');
    if (!/level 3/i.test(msg)) problems.push(`style panel: locked trail gave "${msg}"`);
    await p.click('#skin-close');

    await p.click('#lb-open');
    await p.waitForTimeout(300);
    await shot(p, '03-phone-leaderboard-empty');
    await checkOverflow(p, 'leaderboard');
    await p.click('#lb-close');

    // ---- phone: a match
    await p.click('#play');
    await p.waitForSelector('#lobby:not([hidden])', { timeout: 5000 });
    await shot(p, '04-phone-lobby');
    await p.waitForSelector('#hud:not([hidden])', { timeout: 20000 });
    await p.waitForTimeout(4500); // countdown + a moment of play
    await shot(p, '05-phone-game');
    const hud = await p.textContent('#alive');
    if (!/alive/.test(hud)) problems.push(`game: HUD shows "${hud}"`);
    // rocket: the phone has a fire button; 2 rockets at the start (SIM_FUEL)
    if (!(await visible(p, '#fire'))) problems.push('game: no rocket button on the phone');
    else {
      const before = await p.textContent('#fuel');
      await p.tap('#fire').catch(() => {});
      await p.waitForTimeout(350);
      await shot(p, '05b-phone-rocket');
      await p.waitForTimeout(700);
      const after = await p.textContent('#fuel');
      if (!/2/.test(before) || !/1/.test(after)) problems.push(`rocket: fuel didn't go down ("${before}" -> "${after}")`);
    }

    if (!QUICK) {
      // Hold right so we spiral and crash, then wait for the round to end.
      const box = p.viewportSize();
      await p.touchscreen.tap(box.width * 0.9, box.height * 0.5).catch(() => {});
      await p.waitForSelector('#dead:not([hidden]), #end:not([hidden])', { timeout: 240000 });
      if (await visible(p, '#dead')) await shot(p, '06-phone-dead');
      await p.waitForSelector('#end:not([hidden])', { timeout: 300000 });
      await p.waitForTimeout(700);
      await shot(p, '07-phone-end');
      await checkOverflow(p, 'end screen');
      const res = await p.textContent('#result');
      if (!/XP/.test(res)) problems.push(`end screen: no points/XP shown ("${res}")`);
      await p.evaluate(() => document.getElementById('to-menu').click());
      await p.waitForTimeout(600);
      await shot(p, '08-phone-menu-after');
      const me = await p.textContent('#me');
      if (!/Level/.test(me)) problems.push(`menu after a match: no level shown ("${me}")`);
      await p.click('#lb-open');
      await p.waitForTimeout(400);
      await shot(p, '09-phone-leaderboard');
      const lb = await p.textContent('#lb-list');
      if (!/Tester/.test(lb)) problems.push(`leaderboard: Tester missing ("${lb}")`);
      await p.click('#lb-close');
    } else {
      await p.evaluate(() => { document.getElementById('to-menu').click(); });
    }

    // ---- friends' room: phone opens it, desktop joins through the link
    await p.reload();
    await p.waitForSelector('#play:not([disabled])', { timeout: 15000 });
    await p.click('#friends');
    await p.waitForSelector('#lobby-room:not([hidden])', { timeout: 5000 });
    const roomUrl = p.url();
    if (!/room=/.test(roomUrl)) problems.push(`friends: URL has no room code (${roomUrl})`);
    const d = await desktop.newPage();
    watch(d, 'desktop');
    await d.goto(roomUrl);
    await d.waitForSelector('#play:not([disabled])', { timeout: 15000 });
    await d.fill('#name', 'Friend');
    await shot(d, '10-desktop-menu-room-link');
    await d.click('#play');
    await d.waitForFunction(() => /Friend/.test(document.querySelector('#lobby-sub')?.textContent || ''), null, { timeout: 5000 });
    await p.waitForFunction(() => /Friend/.test(document.querySelector('#lobby-sub')?.textContent || ''), null, { timeout: 5000 });
    await shot(p, '11-phone-friends-lobby');
    await checkOverflow(p, 'friends lobby');
    await d.click('#go');
    await d.waitForSelector('#hud:not([hidden])', { timeout: 10000 });
    await p.waitForSelector('#hud:not([hidden])', { timeout: 10000 });
    await d.waitForTimeout(4500);
    await shot(d, '12-desktop-game');
    await d.keyboard.press('Space');
    await d.waitForTimeout(300);
    await shot(d, '13-desktop-rocket');
  } catch (err) {
    problems.push(`script stopped: ${err.message.split('\n')[0]}`);
  } finally {
    await browser.close();
    await srv.close();
    rmSync(statsDir, { recursive: true, force: true });
  }
}

main().then(() => {
  console.log(JSON.stringify({ ok: problems.length === 0, problems, screenshots: shots }, null, 2));
  process.exit(problems.length ? 1 : 0);
});
