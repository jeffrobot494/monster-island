import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
const testUrl = 'http://127.0.0.1:5204/';
const server = spawn(process.execPath, ['scripts/serve-voice-test.mjs'], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, VOICE_PORT: '5204' } });
let browser;
try {
  await new Promise((resolve, reject) => { server.stdout.once('data', resolve); server.once('error', reject); server.once('exit', code => reject(new Error(`Server exited ${code}`))); });
  browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe',
    headless: true,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'],
  });
  const page = await browser.newPage();
  const external = [], errors = [];
  page.on('console', message => { if (message.type() === 'error') console.log('Browser:', message.text()); });
  page.on('request', request => { if (!request.url().startsWith(testUrl) && !request.url().startsWith('blob:')) external.push(request.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const NativeBlob = window.Blob;
    window.Blob = class extends NativeBlob {
      constructor(parts, options) {
        // Prefix the actual worker source without changing CSP permissions.
        const deny = `Object.defineProperty(self,'indexedDB',{get(){throw new Error('IndexedDB denied by test')}}); Object.defineProperty(self,'caches',{get(){throw new Error('Cache API denied by test')}});`;
        super(['application/javascript', 'text/javascript'].includes(options?.type) ? [deny, ...parts] : parts, options);
      }
    };
  });
  await page.goto(testUrl);
  for (let run = 0; run < 2; run++) {
    await page.getByRole('button', { name: 'Start microphone' }).click();
    await page.waitForFunction(() => document.getElementById('status').textContent.startsWith('Listening') || document.getElementById('status').textContent.startsWith('Failed'), null, { timeout: 150000 });
    assert.match(await page.locator('#status').innerText(), /^Listening/, await page.locator('#log').innerText());
    await page.waitForFunction(() => document.getElementById('meter').textContent.includes('audio buffers sent'));
    await page.getByRole('button', { name: 'Stop', exact: true }).click();
    assert.match(await page.locator('#status').innerText(), /^Stopped/);
  }
  assert.deepEqual(external, [], 'Runtime made external requests');
  assert.deepEqual(errors, [], 'Uncaught page errors');
  console.log('PASS: worker WASM, memory-only model with storage denied, synthetic microphone audio, stop/restart, same-origin requests');
} finally { await browser?.close(); server.kill(); }
