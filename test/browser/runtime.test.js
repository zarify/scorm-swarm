import assert from 'node:assert/strict';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { test, before, after } from 'node:test';
import { chromium } from 'playwright';
import { MOCK_SCORM_INIT, readLmsModel } from './helpers/mock-lms.js';

const projectRoot = resolve(new URL('../..', import.meta.url).pathname);
const packageRoot = join(projectRoot, 'dist/scorm-template');
const stubSimulator = readFileSync(new URL('./fixtures/stub-sim.html', import.meta.url));
const shellRoot = join(homedir(), '.omp/chrome-headless-shell/chrome-headless-shell');
const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.swarm': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.xml': 'application/xml; charset=utf-8',
};

let browser;
let server;
let origin;

before(async () => {
  browser = await launchBrowser();
  server = await startServer();
  origin = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await browser?.close();
  if (server) await new Promise((resolveClose) => server.close(resolveClose));
});

test('learner runtime grades scripted effects, reports SCORM scores, and resets evidence', async (t) => {
  assert.ok(browser, 'A Playwright Chromium build is required for browser tests.');
  assert.ok(existsSync(join(packageRoot, 'index.html')), 'Run npm run build before test:browser.');
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  t.after(() => page.close());
  await page.addInitScript(MOCK_SCORM_INIT, { seedModel: { 'cmi.core.student_id': 'learner-7' } });
  await page.goto(`${origin}/index.html`, { waitUntil: 'domcontentloaded' });

  await page.waitForFunction(
    () => document.getElementById('status-bar')?.textContent.includes('Activity ready.'),
    undefined,
    { timeout: 20_000 },
  );
  assert.equal(await page.textContent('#activity-title'), 'Radio Relay Field Lab');
  assert.match(await page.textContent('#instructions-content'), /Alice/);
  await page.waitForFunction(
    () => [...document.querySelectorAll('#event-log li')].some((line) => line.textContent.includes('hello 42')) &&
      [...document.querySelectorAll('#event-log li')].some((line) => line.textContent.includes('radio RX')),
    undefined,
    { timeout: 10_000 },
  );
  await page.waitForSelector('#hint-list .hint-card', { timeout: 5_000 });

  await page.click('#btn-check');
  await page.waitForFunction(() => document.getElementById('score-display')?.textContent === '75%');
  let model = await readLmsModel(page);
  assert.equal(model['cmi.core.score.raw'], '75');
  assert.equal(model['cmi.core.score.min'], '0');
  assert.equal(model['cmi.core.score.max'], '100');
  assert.equal(model['cmi.core.lesson_status'], 'failed');

  const simulatorFrame = page.frames().find((frame) => frame.url().includes('/sim/index.html'));
  assert.ok(simulatorFrame, 'learner simulator iframe should be present');
  await simulatorFrame.getByRole('button', { name: 'Press Alice A' }).click();
  await page.click('#btn-check');
  await page.waitForFunction(() => document.getElementById('score-display')?.textContent === '100%');
  model = await readLmsModel(page);
  assert.equal(model['cmi.core.score.raw'], '100');
  assert.equal(model['cmi.core.lesson_status'], 'passed');
  assert.ok(model.__commits >= 3, 'initialization and both Check results reached the LMS');

  await page.click('#btn-reset-session');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#test-checklist .test-row')].every((row) => row.dataset.passed === 'false'),
  );
  assert.deepEqual(pageErrors, []);
});

async function launchBrowser() {
  const args = ['--no-sandbox', '--disable-setuid-sandbox'];
  const candidates = [];
  if (process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE && existsSync(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE)) {
    candidates.push({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, args });
  }
  for (const directory of listShellBuilds()) {
    candidates.push({
      executablePath: join(shellRoot, directory, 'chrome-headless-shell-mac-arm64/chrome-headless-shell'),
      args,
    });
  }
  candidates.push({ args });
  for (const options of candidates) {
    try {
      return await chromium.launch({ headless: true, ...options });
    } catch {
      // Try the next managed Chromium build; never launch the user's Chrome.app.
    }
  }
  return null;
}

function listShellBuilds() {
  if (!existsSync(shellRoot)) return [];
  return readdirSync(shellRoot)
    .filter((name) => name.startsWith('mac_arm-'))
    .sort((left, right) => right.localeCompare(left));
}

async function startServer() {
  const serverInstance = createServer((request, response) => {
    const requestUrl = new URL(request.url, 'http://localhost');
    if (requestUrl.pathname === '/sim/index.html') {
      response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(stubSimulator);
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent(requestUrl.pathname);
    } catch {
      response.writeHead(400).end('Bad request');
      return;
    }
    const target = resolve(packageRoot, `.${pathname}`);
    if (target !== packageRoot && !target.startsWith(`${packageRoot}${sep}`)) {
      response.writeHead(403).end('Forbidden');
      return;
    }
    if (!existsSync(target) || !statSync(target).isFile()) {
      response.writeHead(404).end('Not found');
      return;
    }
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Length': statSync(target).size,
      'Content-Type': contentTypes[extname(target).toLowerCase()] ?? 'application/octet-stream',
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(target).pipe(response);
  });
  await new Promise((resolveListen, reject) => {
    serverInstance.once('error', reject);
    serverInstance.listen(0, '127.0.0.1', resolveListen);
  });
  return serverInstance;
}
