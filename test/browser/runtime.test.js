import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
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

test('learner Check runs scripted tests, keeps the best score, and resets run states', async (t) => {
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
  await page.waitForFunction(() => document.getElementById('score-display')?.textContent === '100%');
  let model = await readLmsModel(page);
  assert.equal(model['cmi.core.score.raw'], '100');
  assert.equal(model['cmi.core.score.min'], '0');
  assert.equal(model['cmi.core.score.max'], '100');
  assert.equal(model['cmi.core.lesson_status'], 'completed');
  assert.ok(model.__commits >= 2, 'initialization and Check reached the LMS');

  const simulatorFrame = page.frames().find((frame) => frame.url().includes('/sim/index.html'));
  assert.ok(simulatorFrame, 'learner simulator iframe should be present');
  await simulatorFrame.locator('#stub-mode').uncheck();
  await page.click('#btn-check');
  await page.waitForFunction(() => document.getElementById('score-display')?.textContent === '75%');
  model = await readLmsModel(page);
  assert.equal(model['cmi.core.score.raw'], '100', 'a lower Check cannot downgrade the session best');
  assert.equal(model['cmi.core.lesson_status'], 'completed');
  assert.ok(model.__commits >= 3, 'the second Check reached the LMS');

  await page.click('#btn-reset-session');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#test-checklist .test-row')].every((row) => row.dataset.status === 'not run'),
  );
  assert.equal(await page.textContent('#check-count'), '0 / 3');
  assert.deepEqual(pageErrors, []);
});

test('oversized scene state is saved as an IndexedDB reference and restored after reload', async (t) => {
  assert.ok(browser, 'A Playwright Chromium build is required for browser tests.');
  assert.ok(existsSync(join(packageRoot, 'index.html')), 'Run npm run build before test:browser.');
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  t.after(() => page.close());
  await page.addInitScript(MOCK_SCORM_INIT, { seedModel: { 'cmi.core.student_id': 'learner-scene-big' } });
  await page.goto(`${origin}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('status-bar')?.textContent.includes('Activity ready.'),
    undefined,
    { timeout: 20_000 },
  );

  // Dense base64 that no codec can shrink under the 4096-character cap.
  const bigBundle = randomBytes(3200).toString('base64');
  assert.ok(bigBundle.length > 4096, 'fixture bundle must exceed the suspend_data cap');
  await injectSceneBundle(page, bigBundle);

  // The debounced cache save lands as an IndexedDB record plus an `I` reference.
  await page.waitForFunction(
    () => {
      const model = JSON.parse(localStorage.getItem('mock-scorm-model') || '{}');
      return /^BS1\|[^|]*\|I\|/.test(model['cmi.suspend_data'] || '');
    },
    undefined,
    { timeout: 10_000 },
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('status-bar')?.textContent.includes('Welcome back'),
    undefined,
    { timeout: 20_000 },
  );
  const model = await readLmsModel(page);
  assert.match(model['cmi.suspend_data'], /^BS1\|[^|]*\|I\|/, 'the reference survives the reload untouched');
  const simulatorFrame = page.frames().find((frame) => frame.url().includes('/sim/index.html'));
  assert.ok(simulatorFrame, 'learner simulator iframe should be present');
  await simulatorFrame.waitForFunction(
    (expectedStatus) => document.getElementById('simulator-status')?.textContent === expectedStatus,
    `bundle loaded: ${bigBundle.length} chars`,
    { timeout: 10_000 },
  );
  assert.deepEqual(pageErrors, []);
});

test('small scene state is saved in full and restores from suspend_data when IndexedDB is cleared', async (t) => {
  assert.ok(browser, 'A Playwright Chromium build is required for browser tests.');
  assert.ok(existsSync(join(packageRoot, 'index.html')), 'Run npm run build before test:browser.');
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  t.after(() => context.close());
  await context.addInitScript(MOCK_SCORM_INIT, { seedModel: { 'cmi.core.student_id': 'learner-scene-small' } });
  const pageErrors = [];
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(`${origin}/index.html`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('status-bar')?.textContent.includes('Activity ready.'),
    undefined,
    { timeout: 20_000 },
  );

  // A compact base64 bundle with repeated data so the full session payload uses LZW.
  const smallBundle = 'QUJD'.repeat(200);
  await injectSceneBundle(page, smallBundle);
  await page.waitForFunction(
    () => {
      const model = JSON.parse(localStorage.getItem('mock-scorm-model') || '{}');
      return /^BS1\|[^|]*\|[BL]\|/.test(model['cmi.suspend_data'] || '');
    },
    undefined,
    { timeout: 10_000 },
  );
  let model = await readLmsModel(page);
  assert.match(
    model['cmi.suspend_data'],
    /^BS1\|[^|]*\|[BL]\|/,
    'a small state is stored as a full payload, not a reference',
  );

  // Close the app page so its IndexedDB handle dies, then drop the database
  // from a second same-origin page before the app can restore from it.
  await page.close();
  const cleanupPage = await context.newPage();
  cleanupPage.on('pageerror', (error) => pageErrors.push(error.message));
  await cleanupPage.goto(`${origin}/sim/index.html`, { waitUntil: 'domcontentloaded' });
  await cleanupPage.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase('swarm-scorm');
    // A blocked delete still completes via onsuccess once the closed page's
    // connection is released, so wait it out rather than fail the race.
    request.onsuccess = () => resolve('deleted');
    request.onerror = () => reject(request.error ?? new Error('IndexedDB delete failed'));
  }));
  await cleanupPage.close();

  const restoredPage = await context.newPage();
  restoredPage.on('pageerror', (error) => pageErrors.push(error.message));
  await restoredPage.goto(`${origin}/index.html`, { waitUntil: 'domcontentloaded' });
  await restoredPage.waitForFunction(
    () => document.getElementById('status-bar')?.textContent.includes('Welcome back'),
    undefined,
    { timeout: 20_000 },
  );
  model = await readLmsModel(restoredPage);
  assert.match(
    model['cmi.suspend_data'],
    /^BS1\|[^|]*\|[JBL]\|/,
    'the full payload is what restores the scene without IndexedDB',
  );
  const simulatorFrame = restoredPage.frames().find((frame) => frame.url().includes('/sim/index.html'));
  assert.ok(simulatorFrame, 'learner simulator iframe should be present');
  await simulatorFrame.waitForFunction(
    (expectedStatus) => document.getElementById('simulator-status')?.textContent === expectedStatus,
    `bundle loaded: ${smallBundle.length} chars`,
    { timeout: 10_000 },
  );
  assert.deepEqual(pageErrors, []);
});

/**
 * Inject a scene bundle exactly the way the app bridge would: a load-bundle
 * command posted into the simulator frame. The stub echoes it, emits code-load,
 * and the app's debounced save runs against the injected content.
 */
async function injectSceneBundle(page, bundle) {
  await page.evaluate((value) => {
    const frame = document.getElementById('simulator-frame');
    if (!frame || !frame.contentWindow) throw new Error('simulator frame is unavailable');
    frame.contentWindow.postMessage(
      { source: 'swarm-scorm', v: 1, type: 'load-bundle', payload: value },
      window.location.origin,
    );
  }, bundle);
}

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
