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

test('learner Check runs scripted tests in a modal, keeps the best score, and resets run states', async (t) => {
  assert.ok(browser, 'A Playwright Chromium build is required for browser tests.');
  assert.ok(existsSync(join(packageRoot, 'index.html')), 'Run npm run build before test:browser.');
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  t.after(() => page.close());
  await page.addInitScript(MOCK_SCORM_INIT, { seedModel: { 'cmi.core.student_id': 'learner-7' } });
  // Runs before the deferred app script, so it captures the shipped markup.
  await page.addInitScript(() => {
    document.addEventListener('DOMContentLoaded', () => {
      window.__checkDisabledAtLoad = document.getElementById('btn-check')?.disabled;
    }, { once: true });
  });
  await page.goto(`${origin}/index.html`, { waitUntil: 'domcontentloaded' });

  assert.equal(await page.evaluate(() => document.getElementById('results-modal').open), false);
  await page.waitForFunction(
    () => document.getElementById('status-bar')?.textContent.includes('Activity ready.'),
    undefined,
    { timeout: 20_000 },
  );
  assert.equal(await page.title(), 'Radio Relay Field Lab');
  assert.equal(await page.textContent('#activity-title'), 'Radio Relay Field Lab');
  assert.match(await page.textContent('#left-panel'), /💡 Hints/);
  assert.match(await page.textContent('#instructions-content'), /Alice/);
  await page.waitForFunction(
    () => [...document.querySelectorAll('#hint-list .hint-card')]
      .some((card) => card.textContent.includes("Alice's serial message confirms that her program started.")),
    undefined,
    { timeout: 10_000 },
  );
  assert.equal(await page.locator('#main-layout #left-panel #instructions-panel').count(), 1, 'instructions live on the left');
  assert.equal(await page.locator('.checklist-panel').count(), 0, 'the old right checklist panel is gone');
  assert.equal(await page.locator('#controls #btn-check').count(), 1, 'Check sits under the simulator');
  assert.equal(await page.locator('#controls #btn-reset-session').count(), 1, 'Reset sits under the simulator');
  assert.equal(await page.locator('#results-modal #check-count').count(), 1, 'the count lives in the modal');
  assert.equal(await page.textContent('#results-modal-title'), 'Test results');
  assert.equal(await page.evaluate(() => window.__checkDisabledAtLoad), true, 'Check ships disabled');
  assert.equal(await page.locator('#btn-check').isEnabled(), true, 'Check is enabled once the runner exists');

  await page.click('#btn-check');
  await page.waitForFunction(() => document.getElementById('check-count')?.textContent.trim() === '3 / 3');
  assert.equal(await page.evaluate(() => document.getElementById('results-modal').open), true);
  let model = await readLmsModel(page);
  assert.equal(model['cmi.core.score.raw'], '100');
  assert.equal(model['cmi.core.score.min'], '0');
  assert.equal(model['cmi.core.score.max'], '100');
  assert.equal(model['cmi.core.lesson_status'], 'completed');
  assert.ok(model.__commits >= 2, 'initialization and Check reached the LMS');

  // Close button dismissal, then focus returns to Check once the run settled.
  await page.click('#btn-close-results-modal');
  assert.equal(await page.evaluate(() => document.getElementById('results-modal').open), false);
  await page.waitForFunction(() => document.activeElement?.id === 'btn-check');

  const simulatorFrame = page.frames().find((frame) => frame.url().includes('/sim/index.html'));
  assert.ok(simulatorFrame, 'learner simulator iframe should be present');
  await simulatorFrame.locator('#stub-mode').uncheck();
  await page.click('#btn-check');
  assert.equal(await page.evaluate(() => document.getElementById('results-modal').open), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.evaluate(() => document.getElementById('results-modal').open), false);
  await page.waitForFunction(
    () => document.activeElement?.id === 'btn-reset-session',
    undefined,
    { timeout: 2000 },
  );
  await page.waitForFunction(() => document.getElementById('check-count')?.textContent.trim() === '2 / 3');
  const secondRun = await page.$$eval('#test-checklist .test-row', (rows) =>
    rows.map((row) => [row.dataset.status, row.querySelector('strong')?.textContent]),
  );
  assert.deepEqual(secondRun, [
    ['failed', 'button-a-serial'],
    ['passed', 'button-a-display'],
    ['passed', 'bob-hears-ping'],
  ]);
  const failedDetail = await page.textContent('#test-checklist .test-row[data-status="failed"] .test-result-detail');
  assert.equal(failedDetail, 'Test timed out.');
  assert.doesNotMatch(failedDetail, /Step|\bms\b/);
  model = await readLmsModel(page);
  assert.equal(model['cmi.core.score.raw'], '100', 'a lower Check cannot downgrade the session best');
  assert.equal(model['cmi.core.lesson_status'], 'completed');
  assert.ok(model.__commits >= 3, 'the second Check reached the LMS');

  // Backdrop dismissal uses click coordinates outside the dialog box.
  await page.click('#btn-check');
  assert.equal(await page.evaluate(() => document.getElementById('results-modal').open), true);
  await page.mouse.click(4, 4);
  assert.equal(await page.evaluate(() => document.getElementById('results-modal').open), false);
  await page.waitForFunction(
    () => document.activeElement?.id === 'btn-reset-session',
    undefined,
    { timeout: 2000 },
  );
  await page.waitForFunction(() => document.getElementById('check-count')?.textContent.trim() === '2 / 3');

  await page.click('#btn-reset-session');
  await page.waitForFunction(() =>
    [...document.querySelectorAll('#test-checklist .test-row')].every((row) => row.dataset.status === 'not run'),
  );
  assert.equal(await page.textContent('#check-count'), '0 / 3');
  assert.equal(await page.evaluate(() => document.getElementById('results-modal').open), false, 'Reset does not reopen the modal');
  assert.equal(await page.evaluate(() => document.getElementById('check-error').hidden), true);

  // Desktop composition: one grid, sidebar before the simulator, system sans.
  const layout = await page.evaluate(() => {
    const left = document.getElementById('left-panel').getBoundingClientRect();
    const simulator = document.getElementById('simulator-frame').getBoundingClientRect();
    const title = getComputedStyle(document.getElementById('activity-title'));
    const instructions = getComputedStyle(document.getElementById('instructions-content'));
    const panel = getComputedStyle(document.getElementById('left-panel'));
    return {
      leftRight: left.right,
      simulatorLeft: simulator.left,
      titleFont: title.fontFamily,
      titleSize: title.fontSize,
      instructionsSize: instructions.fontSize,
      borderWidth: panel.borderRightWidth,
      overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    };
  });
  assert.ok(layout.leftRight <= layout.simulatorLeft + 0.5, 'the sidebar ends before the simulator begins');
  assert.match(layout.titleFont, /system-ui|-apple-system|Segoe UI|Roboto/);
  assert.equal(layout.titleSize, '18px');
  assert.equal(layout.instructionsSize, '15px');
  assert.equal(layout.borderWidth, '1px');
  assert.equal(layout.overflow, false);

  // Narrow composition: stacked, no horizontal overflow, controls reachable.
  await page.setViewportSize({ width: 390, height: 844 });
  const narrow = await page.evaluate(() => {
    const left = document.getElementById('left-panel').getBoundingClientRect();
    const simulator = document.getElementById('simulator-frame').getBoundingClientRect();
    return {
      leftBottom: left.bottom,
      simulatorTop: simulator.top,
      horizontalOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
    };
  });
  assert.ok(narrow.leftBottom <= narrow.simulatorTop + 0.5, 'the sidebar stacks above the simulator');
  assert.equal(narrow.horizontalOverflow, false);
  await page.locator('#btn-check').scrollIntoViewIfNeeded();
  const controls = await page.evaluate(() => {
    const rect = document.getElementById('btn-check').getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom, height: window.innerHeight, width: rect.width };
  });
  assert.ok(controls.top >= 0 && controls.bottom <= controls.height, 'Check is reachable in the viewport');
  assert.ok(controls.width > 0);
  assert.deepEqual(pageErrors, []);
});

test('oversized scene state is bound to its attempt and a new attempt starts from the package', async (t) => {
  assert.ok(browser, 'A Playwright Chromium build is required for browser tests.');
  assert.ok(existsSync(join(packageRoot, 'index.html')), 'Run npm run build before test:browser.');
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  t.after(() => context.close());
  const studentId = 'learner-scene-big';
  await context.addInitScript(MOCK_SCORM_INIT, { seedModel: { 'cmi.core.student_id': studentId } });
  const pageErrors = [];
  const page = await context.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
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

  // The debounced cache save lands as an IndexedDB record, an `I` reference,
  // and the standard bookmark that binds both to this LMS attempt.
  await page.waitForFunction(
    () => {
      const model = JSON.parse(localStorage.getItem('mock-scorm-model') || '{}');
      return /^BS1\|[^|]*\|I\|/.test(model['cmi.suspend_data'] || '');
    },
    undefined,
    { timeout: 10_000 },
  );
  const attemptA = await readLmsModel(page);
  assert.match(attemptA['cmi.core.lesson_location'], /^swarm-scene-v1:[a-f0-9]{32}$/);
  const bookmarkA = attemptA['cmi.core.lesson_location'];

  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForFunction(
    () => document.getElementById('status-bar')?.textContent.includes('Welcome back'),
    undefined,
    { timeout: 20_000 },
  );
  const model = await readLmsModel(page);
  assert.equal(model['cmi.core.lesson_location'], bookmarkA, 'the same attempt keeps its binding');
  assert.match(model['cmi.suspend_data'], /^BS1\|[^|]*\|I\|/, 'the reference survives the reload untouched');
  const simulatorFrame = page.frames().find((frame) => frame.url().includes('/sim/index.html'));
  assert.ok(simulatorFrame, 'learner simulator iframe should be present');
  await simulatorFrame.waitForFunction(
    (expectedStatus) => document.getElementById('simulator-status')?.textContent === expectedStatus,
    `bundle loaded: ${bigBundle.length} chars`,
    { timeout: 10_000 },
  );

  // Close the settled SCO before switching the runtime to a new attempt, so
  // its unload handler cannot write attempt A's scene into attempt B.
  await page.close();
  const setup = await context.newPage();
  await setup.goto(`${origin}/sim/index.html`, { waitUntil: 'domcontentloaded' });
  await setup.evaluate((id) => {
    localStorage.setItem('mock-scorm-model', JSON.stringify({
      'cmi.core.student_id': id,
      'cmi.core.entry': 'ab-initio',
      __initializes: 1,
      __commits: 1,
      __finishes: 1,
    }));
  }, studentId);
  await setup.close();

  const freshPage = await context.newPage();
  freshPage.on('pageerror', (error) => pageErrors.push(error.message));
  await freshPage.goto(`${origin}/index.html`, { waitUntil: 'domcontentloaded' });
  await freshPage.waitForFunction(
    () => document.getElementById('status-bar')?.textContent.includes('Activity ready.'),
    undefined,
    { timeout: 20_000 },
  );
  const freshModel = await readLmsModel(freshPage);
  assert.equal(freshModel['cmi.suspend_data'] || '', '', 'a new attempt attaches no earlier payload');
  assert.equal(freshModel['cmi.core.lesson_location'] || '', '', 'a new attempt attaches no earlier bookmark');
  const freshFrame = freshPage.frames().find((frame) => frame.url().includes('/sim/index.html'));
  assert.ok(freshFrame, 'the fresh attempt still connects the simulator');
  assert.ok(
    freshFrame.url().includes('/sim/index.html?mode=learner&bundle=../config/scene.swarm'),
    'a fresh attempt loads the packaged scene',
  );
  await freshPage.waitForTimeout(500);
  const freshStatus = await freshFrame.evaluate(() => document.getElementById('simulator-status')?.textContent);
  assert.notEqual(
    freshStatus,
    `bundle loaded: ${bigBundle.length} chars`,
    'attempt A\'s browser-only scene never reaches attempt B',
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
