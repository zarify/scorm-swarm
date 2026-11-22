import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { test, before, after } from 'node:test';
import { chromium } from 'playwright';
import { MOCK_SCORM_INIT, readLmsModel } from './helpers/mock-lms.js';
import { decodeSwarmBundle, encodeSwarmBundle } from '../../src/shared/swarm-bundle.js';

const projectRoot = resolve(new URL('../..', import.meta.url).pathname);
const packageRoot = join(projectRoot, 'dist/scorm-template');
const builderRoot = join(projectRoot, 'dist/builder');
const stubSimulator = readFileSync(new URL('./fixtures/stub-sim.html', import.meta.url));
const shellRoot = join(homedir(), '.omp/chrome-headless-shell/chrome-headless-shell');

/**
 * Nested mounts keep the builder and the packaged SCORM package at the depths
 * they really ship at: the builder beside its own simulator, and the package
 * under a Moodle module path. Neither is special-cased anywhere else.
 */
const nestedMounts = [
  ['/nested/swarm/builder/', builderRoot],
  ['/nested/moodle/mod/scorm/radio-relay/', packageRoot],
];
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
 * Both surfaces run the same authored tests, so they differ only in where the
 * canvas iframe, the result rows and the score readout live.
 */
const DEMO_SURFACES = {
  builder: {
    frame: '#preview-iframe',
    check: '#btn-check-session',
    rows: '#preview-grades .grade-row',
    score: '#preview-score',
  },
  package: {
    frame: '#simulator-frame',
    check: '#btn-check',
    rows: '#test-checklist .test-row',
    score: '#check-count',
  },
};

/**
 * The shipped demo, on both real surfaces, with the authored device order as
 * shipped (Bob first) and with Alice first. Selecting a canvas device or
 * hiding diagnostics rows from the views must never change what Check injects,
 * records, or grades: every case has to reach the same three passes.
 */
test('real demo Check is independent of canvas selection', async (t) => {
  assert.ok(browser, 'A Playwright Chromium build is required for browser tests.');
  assert.ok(existsSync(join(builderRoot, 'index.html')), 'Run npm run build before test:browser.');
  assert.ok(existsSync(join(packageRoot, 'index.html')), 'Run npm run build before test:browser.');

  const shippedScene = {
    name: 'two-device-demo.swarm',
    bytes: readFileSync(join(projectRoot, 'examples/two-device-demo.swarm')),
  };
  const aliceFirstScene = { name: 'alice-first-demo.swarm', bytes: reverseDemoDeviceOrder() };

  const scenarios = [
    {
      name: 'builder · shipped order · Alice selected · diagnostics filters off',
      surface: 'builder',
      selected: 'alice',
      filtersOff: true,
      scene: shippedScene,
    },
    {
      name: 'builder · shipped order · Bob selected · default diagnostics',
      surface: 'builder',
      selected: 'bob',
      filtersOff: false,
      scene: shippedScene,
    },
    {
      name: 'builder · Alice-first order · Alice selected',
      surface: 'builder',
      selected: 'alice',
      filtersOff: false,
      scene: aliceFirstScene,
    },
    { name: 'package · shipped order · Alice selected', surface: 'package', selected: 'alice', filtersOff: false, scene: null },
    { name: 'package · shipped order · Bob selected', surface: 'package', selected: 'bob', filtersOff: false, scene: null },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      // A fresh context per case: no scene cache, no IndexedDB, no LMS history.
      const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
      try {
        const failures = [];
        if (scenario.surface === 'package') {
          await context.addInitScript(MOCK_SCORM_INIT, {
            seedModel: { 'cmi.core.student_id': `learner-selection-${scenario.selected}` },
          });
        }
        const page = await context.newPage();
        collectFirstPartyFailures(page, failures);
        const surface = DEMO_SURFACES[scenario.surface];

        if (scenario.surface === 'builder') {
          await openBuilderDemo(page, scenario);
        } else {
          await openPackagedDemo(page);
        }
        await waitForDemoRuntimes(page, surface.frame);
        await selectCanvasDevice(page, surface.frame, scenario.selected);
        const selectedBeforeCheck = await selectedCanvasDevice(page, surface.frame);
        assert.equal(
          selectedBeforeCheck,
          scenario.selected,
          'the requested device is the selected canvas device before Check',
        );
        const filters = scenario.filtersOff
          ? await turnOffDiagnosticsFilters(page, surface.frame)
          : null;

        await installSimulatorMessageTrace(page, surface.frame);
        await page.click(surface.check);
        // A run always ends: every row is decided and Check is usable again,
        // so a failure is reported with its row detail instead of a hang.
        await page.waitForFunction(({ rows, check }) => {
          const nodes = [...document.querySelectorAll(rows)];
          if (nodes.length !== 3) return false;
          if (!nodes.every((node) => node.dataset.status === 'passed' || node.dataset.status === 'failed')) {
            return false;
          }
          return document.querySelector(check)?.disabled === false;
        }, { rows: surface.rows, check: surface.check }, { timeout: 90_000, polling: 100 });

        const trace = await page.evaluate(() => window.__demoBridgeTrace ?? []);
        const rows = await page.$$eval(surface.rows, (nodes) =>
          nodes.map((node) => [node.dataset.status, node.querySelector('strong')?.textContent]));
        const scoreText = await page.textContent(surface.score);
        const rawScore = scenario.surface === 'builder' ? null : (await readLmsModel(page))['cmi.core.score.raw'];

        try {
          assert.deepEqual(
            rows.map(([status, id]) => [id, status]),
            [
              ['button-a-serial', 'passed'],
              ['button-a-display', 'passed'],
              ['bob-hears-ping', 'passed'],
            ],
          );
          if (scenario.surface === 'builder') {
            assert.equal(scoreText, '100%');
          } else {
            assert.equal(scoreText, '3 / 3');
            assert.equal(rawScore, '100');
          }
          if (filters) {
            assert.deepEqual(filters, { serial: false, radio: false });
          }
          assert.ok(
            trace.some((entry) => entry.kind === 'code-restart' && entry.device === scenario.selected),
            `the selected device ${scenario.selected} restarts its program inside the run`,
          );
          assert.deepEqual(failures, []);
        } catch (error) {
          error.message = [
            error.message,
            `surface: ${scenario.surface} · selected before Check: ${selectedBeforeCheck}`,
            `rows: ${JSON.stringify(rows)} · score: ${scoreText} · raw: ${rawScore} · filters: ${JSON.stringify(filters)}`,
            `page failures: ${JSON.stringify(failures)}`,
            'bridge trace:',
            formatBridgeTrace(trace),
          ].join('\n');
          throw error;
        }
      } finally {
        await context.close();
      }
    });
  }
});

/** The shipped demo scene with only its device order reversed: the fallback
 * selection then lands on Alice while every program, ID and radio setting
 * stays exactly as authored. */
function reverseDemoDeviceOrder() {
  const bytes = readFileSync(join(projectRoot, 'examples/two-device-demo.swarm'));
  const project = decodeSwarmBundle(new Uint8Array(bytes));
  assert.equal(project.devices.length, 2, 'the demo scene ships exactly two devices');
  const [first, ...rest] = project.devices;
  const reversed = {
    ...project,
    devices: [...rest, first],
  };
  assert.deepEqual(reversed.devices.map((device) => device.id), ['alice', 'bob']);
  return encodeSwarmBundle(reversed);
}

function collectFirstPartyFailures(page, failures) {
  page.on('pageerror', (error) => failures.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => {
    if (!request.url().startsWith(origin)) return;
    const errorText = request.failure()?.errorText ?? '';
    if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(errorText)) return;
    failures.push(`requestfailed: ${request.url()} ${errorText}`);
  });
  page.on('response', (response) => {
    if (!response.url().startsWith(origin)) return;
    if (/\/favicon\.ico$/.test(new URL(response.url()).pathname)) return;
    if (response.status() >= 400) failures.push(`http ${response.status()}: ${response.url()}`);
  });
}

async function openBuilderDemo(page, scenario) {
  await page.goto(`${origin}/nested/swarm/builder/index.html`, { waitUntil: 'domcontentloaded' });
  await page.setInputFiles('#file-import', {
    name: 'demo-activity.json',
    mimeType: 'application/json',
    buffer: readFileSync(join(projectRoot, 'examples/demo-activity.json')),
  });
  await page.waitForFunction(
    () => document.getElementById('toast')?.textContent === 'Activity JSON imported.',
    undefined,
    { timeout: 20_000 },
  );
  // The panels the learner may open; the runtime log has to exist before its
  // own filters can be tested. Configured on the config tab, which stays mounted.
  if (scenario.filtersOff) {
    // The checkbox sits under its own toggle track: press the row, like a user.
    await page.locator('label', { has: page.locator('#panel-runtime-log') }).click();
    assert.equal(await page.isChecked('#panel-runtime-log'), true);
  }
  await page.click('#tab-button-scenario');
  await page.waitForFunction(
    () => document.getElementById('scenario-status')?.textContent === 'Simulator connected.',
    undefined,
    { timeout: 30_000 },
  );
  if (scenario.scene) {
    await page.setInputFiles('#file-scene', {
      name: scenario.scene.name,
      mimeType: 'application/octet-stream',
      buffer: Buffer.from(scenario.scene.bytes),
    });
    await page.waitForFunction(
      (name) => document.getElementById('scenario-status')?.textContent === `Loaded ${name}.`,
      scenario.scene.name,
      { timeout: 30_000 },
    );
  }
  await page.click('#btn-capture-scene');
  await page.waitForFunction(
    () => document.getElementById('scenario-status')?.textContent === 'Scene captured.',
    undefined,
    { timeout: 30_000 },
  );
  await page.click('#tab-button-preview');
  await page.waitForFunction(
    () => document.getElementById('btn-check-session')?.disabled === false,
    undefined,
    { timeout: 30_000 },
  );
}

async function openPackagedDemo(page) {
  await page.goto(`${origin}/nested/moodle/mod/scorm/radio-relay/index.html`, {
    waitUntil: 'domcontentloaded',
  });
  await page.waitForFunction(
    () => document.getElementById('status-bar')?.textContent.includes('Activity ready.'),
    undefined,
    { timeout: 30_000 },
  );
}

/**
 * Both programmed devices render a node and both run an actual MicroPython
 * runtime. The runtime frames are visually hidden by design, so attachment and
 * the prepared state are the readiness signals, never visibility.
 */
async function waitForDemoRuntimes(page, frameSelector) {
  try {
    await page.waitForFunction((selector) => {
      const document_ = document.querySelector(selector)?.contentDocument;
      if (!document_) return false;
      const nodes = document_.querySelectorAll('[data-canvas-device-id]');
      if (nodes.length !== 2) return false;
      for (const name of ['Alice', 'Bob']) {
        if (!document_.querySelector(`iframe[title="MicroPython simulator for ${name}"]`)) return false;
      }
      const prepared = [...document_.querySelectorAll('.runtime-frame-card__header span')]
        .filter((span) => span.textContent.trim() === 'prepared')
        .length;
      return prepared === 2;
    }, frameSelector, { timeout: 90_000, polling: 100 });
  } catch (error) {
    const state = await page.evaluate((selector) => {
      const frame = document.querySelector(selector);
      const document_ = frame?.contentDocument;
      return {
        frameSrc: frame?.getAttribute('src') ?? null,
        frameUrl: frame?.contentWindow?.location?.href ?? null,
        status: document_?.querySelector('#simulator-status')?.textContent ?? null,
        nodes: [...(document_?.querySelectorAll('[data-canvas-device-id]') ?? [])]
          .map((node) => node.getAttribute('data-canvas-device-id')),
        headers: [...(document_?.querySelectorAll('.runtime-frame-card__header') ?? [])]
          .map((header) => header.textContent.trim()),
        loadResults: document_?.querySelector('.runtime-load-list')?.textContent?.trim() ?? null,
      };
    }, frameSelector);
    error.message = `${error.message}\nruntime state: ${JSON.stringify(state)}`;
    throw error;
  }
}

/** A real pointer press on the device body, away from the A/B/A+B circles. */
async function selectCanvasDevice(page, frameSelector, deviceId) {
  const canvas = page.frameLocator(frameSelector);
  await canvas.locator('[data-canvas-device-id="alice"]').waitFor({ state: 'attached' });
  await canvas.locator('[data-canvas-device-id="bob"]').waitFor({ state: 'attached' });
  await canvas
    .locator(`[data-canvas-device-id="${deviceId}"] rect.microbit-body`)
    .click({ position: { x: 8, y: 50 } });
  await canvas.locator(`.microbit-node--selected[data-canvas-device-id="${deviceId}"]`)
    .waitFor({ state: 'attached' });
  assert.equal(await canvas.locator('.microbit-node--selected').count(), 1);
}

async function selectedCanvasDevice(page, frameSelector) {
  return page.evaluate((selector) => {
    const document_ = document.querySelector(selector)?.contentDocument;
    return document_?.querySelector('.microbit-node--selected')?.getAttribute('data-canvas-device-id') ?? null;
  }, frameSelector);
}

/** View-only log filters: they must change nothing but which rows are listed. */
async function turnOffDiagnosticsFilters(page, frameSelector) {
  const canvas = page.frameLocator(frameSelector);
  await canvas.locator('button.canvas-control--runtime-log').click();
  const filters = canvas.locator(`#runtime-log-panel .device-log__filters button`);
  await filters.first().waitFor({ state: 'visible' });
  for (const label of ['Serial', 'Radio']) {
    const filter = filters.filter({ hasText: label });
    if (await filter.getAttribute('aria-pressed') === 'true') await filter.click();
  }
  const state = {};
  for (const label of ['Serial', 'Radio']) {
    const filter = filters.filter({ hasText: label });
    state[label.toLowerCase()] = await filter.getAttribute('aria-pressed') === 'true';
  }
  await canvas.locator('#runtime-log-panel .canvas-inspector__close').click();
  return state;
}

/**
 * A passive trace of the run feed the host itself receives: which device
 * produced which event, its bridge sequence, and the canvas selection at that
 * moment. It observes; it never sends.
 */
async function installSimulatorMessageTrace(page, frameSelector) {
  await page.evaluate((selector) => {
    const trace = [];
    window.__demoBridgeTrace = trace;
    const selectedNow = () => {
      const document_ = document.querySelector(selector)?.contentDocument;
      return document_?.querySelector('.microbit-node--selected')?.getAttribute('data-canvas-device-id') ?? null;
    };
    window.addEventListener('message', (event) => {
      const frame = document.querySelector(selector);
      if (!frame || event.source !== frame.contentWindow) return;
      const message = event.data;
      if (!message || message.source !== 'swarm-sim-bridge' || message.v !== 1) return;
      if (trace.length >= 500) return;
      const entry = { at: Math.round(performance.now()), type: message.type, selected: selectedNow() };
      if (message.type === 'event') {
        const payload = message.payload ?? {};
        const delivered = payload.event ?? {};
        entry.seq = payload.seq ?? null;
        entry.ts = payload.ts ?? null;
        entry.kind = delivered.kind ?? null;
        entry.device = delivered.device_id ?? null;
        if (typeof delivered.from_device_id === 'string') entry.from = delivered.from_device_id;
        if (typeof delivered.reason === 'string') entry.reason = delivered.reason;
        if (delivered.kind === 'serial') entry.text = String(delivered.text ?? '').slice(0, 40);
        if (delivered.kind === 'button') entry.button = `${delivered.button}:${delivered.pressed}`;
        if (delivered.kind === 'radio-tx' || delivered.kind === 'radio-rx') {
          entry.packet = delivered.packet?.data_b64 ?? null;
        }
      } else {
        entry.id = message.id ?? null;
        if (message.type === 'display') entry.devices = Object.keys(message.payload?.displays ?? {});
      }
      trace.push(entry);
    }, true);
  }, frameSelector);
}

function formatBridgeTrace(trace) {
  if (!Array.isArray(trace) || trace.length === 0) return '  (empty)';
  return trace
    .map((entry) => {
      const parts = [String(entry.at), entry.type];
      if (entry.kind) parts.push(entry.kind);
      if (entry.device) parts.push(`dev=${entry.device}`);
      if (entry.from) parts.push(`from=${entry.from}`);
      if (entry.reason) parts.push(`reason=${entry.reason}`);
      if (entry.button) parts.push(`button=${entry.button}`);
      if (entry.text) parts.push(`text=${JSON.stringify(entry.text)}`);
      if (entry.seq !== undefined && entry.seq !== null) parts.push(`seq=${entry.seq}`);
      if (entry.id) parts.push(`id=${entry.id}`);
      if (entry.devices) parts.push(`devices=${entry.devices.join(',')}`);
      parts.push(`sel=${entry.selected}`);
      return `  ${parts.join(' ')}`;
    })
    .join('\n');
}

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
    const mount = nestedMounts.find(([prefix]) => pathname.startsWith(prefix));
    const root = mount ? mount[1] : packageRoot;
    // Every mount serves the directory tree under its own prefix, index.html
    // included; nothing here knows what a simulator or a package looks like.
    const relative = mount ? `/${pathname.slice(mount[0].length)}` : pathname;
    const target = resolve(root, `.${relative}`);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
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
