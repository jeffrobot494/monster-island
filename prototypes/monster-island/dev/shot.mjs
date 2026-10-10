// Headless screenshot + console capture: node dev/shot.mjs <url> <out.png> [waitMs] [js-to-eval-after-wait]
import { chromium } from 'playwright-core';
import { homedir } from 'node:os';
const [url, out, wait = '6000', evalJs] = process.argv.slice(2);
const browser = await chromium.launch({
  executablePath: `${homedir()}/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome`,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => console.log(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`));
await page.goto(url);
await page.waitForTimeout(Number(wait));
if (evalJs) console.log('[eval]', JSON.stringify(await page.evaluate(evalJs)));
await page.screenshot({ path: out });
await browser.close();
