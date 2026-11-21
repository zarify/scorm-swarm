import { createGrader } from '../../shared/effect-evaluator.js';
import { createTestRunner } from '../../shared/test-runner.js';
import {
  consumeHint,
  createHintEventDebouncer,
  createHintState,
  evaluateHints,
  getManualHintRequestState,
  recordCheckAttempt,
} from '../../shared/hint-evaluator.js';
import { connectSimBridge } from '../../shared/sim-bridge.js';
import { createSceneIsolation } from '../../shared/scene-isolation.js';
import { getConfig, getSceneBundle, onConfigChange, onSceneChange, showToast } from './app.js';

const LEARNER_URL = 'sim/index.html?mode=learner';
const READY_TIMEOUT_MS = 10_000;
const LOAD_TIMEOUT_MS = 10_000;
const CHECK_LABEL = 'Check';
const RUNNING_LABEL = 'Running…';

let bridge;
let bridgeReady = false;
let connecting = false;
/** Incremented on every connect attempt; stale attempts compare against it and bail out. */
let connectToken = 0;
let runner;
let sceneIsolation;
/** Incremented whenever the active runner is replaced or detached; stale runs compare against it. */
let runnerToken = 0;
let checkInProgress = false;
let runProgress = new Map();
const seenSimulatorPayloads = new WeakSet();
let grader = createGrader();
let hintState = createHintState();
let latestHintResult = { visibleHints: [], nextEvaluationDelayMs: null };
let hintTimer;
const hintDebouncer = createHintEventDebouncer(evaluateHintEvent, 250);

export function initPreviewTab() {
  void connectPreview();
  document.getElementById('btn-reset-session').addEventListener('click', () => void resetSession());
  document.getElementById('btn-check-session').addEventListener('click', () => void checkSession());
  onConfigChange((config) => {
    invalidateRun();
    resetPreviewState();
    if (bridgeReady && bridge) {
      const activeBridge = bridge;
      // A scene change can close this bridge in the same turn; a superseded
      // settings send must not surface as an unhandled rejection.
      void applySettings(activeBridge, config).catch(() => {});
      rebuildRunner();
    }
  });
  onSceneChange(() => {
    void connectPreview({ reset: true });
  });
  renderGrades(null);
  renderHints();
}

/**
 * The one connect path: used by initialisation, scene changes and Reset session.
 * A reset always invalidates the old runner/bridge and mounts a brand-new browsing
 * context before the learner simulator is loaded into it.
 */
async function connectPreview({ reset = false } = {}) {
  const generation = ++connectToken;
  connecting = true;
  // Cancel and detach the old run *synchronously*; its completion can no longer touch the UI.
  invalidateRun();
  resetPreviewState();
  const previousBridge = bridge;
  bridge = undefined;
  bridgeReady = false;
  previousBridge?.close();
  updateControls();
  setPreviewStatus('Waiting for learner simulator…');

  const frame = document.getElementById('preview-iframe');
  if (!frame) {
    connecting = false;
    updateControls();
    setPreviewStatus('Learner simulator frame is unavailable.', 'error');
    return;
  }

  // A fresh browsing context: an old frame cannot acknowledge or send evidence into the new run.
  const freshFrame = frame.cloneNode(false);
  freshFrame.id = frame.id;
  freshFrame.src = 'about:blank';
  frame.replaceWith(freshFrame);

  const targetOrigin = new URL(LEARNER_URL, window.location.href).origin;
  const frameWindow = freshFrame.contentWindow;
  if (!frameWindow) {
    connecting = false;
    updateControls();
    setPreviewStatus('Learner simulator frame is unavailable.', 'error');
    return;
  }

  const bundle = getSceneBundle();
  const activeBridge = connectSimBridge(frameWindow, targetOrigin);
  bridge = activeBridge;
  activeBridge.onEvent((payload) => handleSimulatorEvent(payload, activeBridge));
  // Connect the bridge before navigating the new frame to the simulator.
  freshFrame.src = LEARNER_URL;

  const isStale = () => generation !== connectToken || activeBridge !== bridge;

  const ready = await waitForReady(activeBridge, READY_TIMEOUT_MS);
  if (isStale()) return;
  if (!ready) {
    activeBridge.close();
    bridge = undefined;
    bridgeReady = false;
    connecting = false;
    rebuildRunner();
    updateControls();
    setPreviewStatus(
      reset
        ? 'Could not reset preview: learner simulator did not answer within 10 seconds.'
        : 'Learner simulator did not connect within 10 seconds.',
      'error',
    );
    return;
  }

  bridgeReady = true;
  try {
    await applyPreviewSettings(activeBridge);
    if (isStale()) return;
    if (bundle) await activeBridge.loadBundle(bundle, { timeoutMs: LOAD_TIMEOUT_MS });
    if (isStale()) return;
    // Config edits that arrived while connecting: re-read and apply the latest settings.
    await applyPreviewSettings(activeBridge);
    if (isStale()) return;
    connecting = false;
    rebuildRunner();
    updateControls();
    if (reset) {
      setPreviewStatus(
        bundle
          ? 'Preview reset to the starting scene.'
          : 'Preview reset to the built-in demo (no captured scene).',
      );
    } else {
      setPreviewStatus(
        bundle
          ? 'Learner simulator connected.'
          : 'Showing the built-in demo. Capture a scene to preview your activity.',
      );
    }
  } catch (error) {
    if (isStale()) return;
    activeBridge.close();
    bridge = undefined;
    bridgeReady = false;
    connecting = false;
    rebuildRunner();
    updateControls();
    const reason = error instanceof Error ? error.message : String(error);
    setPreviewStatus(
      reset ? `Could not reset preview: ${reason}` : `Could not connect to the learner simulator: ${reason}`,
      'error',
    );
  }
}

function previewUiVisibility(config) {
  // Preview always shows author coordinates; the exported package keeps the authored toggle.
  return { ...config.panel_visibility, node_coordinates: true };
}

async function applyPreviewSettings(bridgeRef) {
  await applySettings(bridgeRef, getConfig());
}

async function applySettings(bridgeRef, config) {
  await bridgeRef.setCapabilities(config.capabilities);
  await bridgeRef.setUiVisibility(previewUiVisibility(config));
}

function waitForReady(bridgeRef, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    bridgeRef.ready.then(
      (value) => {
        clearTimeout(timer);
        resolve(value === true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

function resetPreviewState() {
  grader.reset();
  hintState = createHintState();
  latestHintResult = { visibleHints: [], nextEvaluationDelayMs: null };
  runProgress = new Map();
  hintDebouncer.cancel();
  clearTimeout(hintTimer);
  hintTimer = undefined;
  renderGrades(null);
  evaluateHintEvent({ type: 'timer' });
}

/** Cancel and detach the active run so a superseded run cannot write UI or re-enable controls. */
function invalidateRun() {
  runnerToken += 1;
  const previousRunner = runner;
  runner = undefined;
  sceneIsolation = undefined;
  if (previousRunner) previousRunner.cancel();
  runProgress = new Map();
  checkInProgress = false;
  updateControls();
}

function updateControls() {
  const resetButton = document.getElementById('btn-reset-session');
  if (resetButton) resetButton.disabled = connecting;
  const checkButton = document.getElementById('btn-check-session');
  if (!checkButton) return;
  checkButton.textContent = checkInProgress ? RUNNING_LABEL : CHECK_LABEL;
  checkButton.disabled = checkInProgress || connecting || !bridgeReady || !runner;
}

function rebuildRunner() {
  const previousRunner = runner;
  runnerToken += 1;
  runner = undefined;
  if (previousRunner) previousRunner.cancel();
  if (bridgeReady && bridge) {
    const activeBridge = bridge;
    sceneIsolation = createSceneIsolation({
      bridge: activeBridge,
      authoredBundleBase64: getSceneBundle(),
      onWarning: (message) => showToast(message, 'error'),
    });
    runner = createTestRunner({
      testCases: getConfig().evaluation.test_cases,
      bridge: activeBridge,
      isolate: sceneIsolation.isolate,
      onEvent: (payload) => {
        if (activeBridge !== bridge) return;
        handleSimulatorEvent(payload, activeBridge);
      },
    });
  }
  updateControls();
}

function handleSimulatorEvent(payload, sourceBridge = bridge) {
  if (sourceBridge !== bridge) return;
  if (!payload || typeof payload !== 'object') return;
  if (payload.event && typeof payload.event === 'object') {
    if (seenSimulatorPayloads.has(payload)) return;
    seenSimulatorPayloads.add(payload);
  } else if (typeof payload.kind === 'string') {
    payload = { ts: Date.now(), event: payload };
  } else {
    return;
  }

  const event = payload.event;
  grader.record(payload);
  if (event.kind === 'code-load') {
    hintState = createHintState();
    hintDebouncer.cancel();
  }
  hintDebouncer.push({ type: 'sim_event', payload });
}

async function checkSession() {
  if (!runner || !bridgeReady || connecting || checkInProgress) return;
  const activeRunner = runner;
  const runToken = runnerToken;
  checkInProgress = true;
  runProgress = new Map();
  updateControls();
  recordCheckAttempt(hintState);
  try {
    await sceneIsolation?.prepare();
    if (activeRunner !== runner || runToken !== runnerToken) return;
    const outcome = await activeRunner.runAll({
      onProgress: (progress) => {
        if (activeRunner !== runner || runToken !== runnerToken) return;
        renderRunProgress(progress);
      },
    });
    if (activeRunner !== runner || runToken !== runnerToken) return;
    if (!Object.prototype.hasOwnProperty.call(outcome, 'score')) {
      runProgress.clear();
      renderGrades(null);
      return;
    }
    renderGrades(outcome.results, { showFeedback: true });
    evaluateHintEvent({
      type: 'test_fail',
      failedCheckCount: outcome.results.filter((result) => !result.passed).length,
    });
  } catch (error) {
    if (activeRunner !== runner || runToken !== runnerToken) return;
    showToast(`Test run failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
  } finally {
    if (activeRunner === runner && runToken === runnerToken) {
      checkInProgress = false;
      updateControls();
    }
  }
}

function renderRunProgress(progress) {
  runProgress.set(progress.id, progress.status);
  renderGrades([]);
}

async function resetSession() {
  if (connecting) return;
  await connectPreview({ reset: true });
}

function evaluateHintEvent(event) {
  clearTimeout(hintTimer);
  hintTimer = undefined;
  latestHintResult = evaluateHints(getConfig().hints, hintState, event, grader.evaluate);
  renderHints();
  if (latestHintResult.nextEvaluationDelayMs !== null) {
    hintTimer = setTimeout(
      () => evaluateHintEvent({ type: 'timer' }),
      latestHintResult.nextEvaluationDelayMs,
    );
  }
}

function renderGrades(results, { showFeedback = false } = {}) {
  const list = document.getElementById('preview-grades');
  list.replaceChildren();
  if (!results) {
    const empty = document.createElement('p');
    empty.className = 'empty-note';
    empty.textContent = 'Run the scene, then select Check.';
    list.append(empty);
    document.getElementById('preview-score').textContent = '—';
    return;
  }
  const cases = getConfig().evaluation.test_cases;
  const resultsById = new Map(results.map((result) => [result.id, result]));
  const possible = cases.reduce((sum, testCase) => sum + (testCase.points ?? 1), 0);
  let earned = 0;
  for (const testCase of cases) {
    const result = resultsById.get(testCase.id);
    const state = result
      ? result.passed ? 'passed' : 'failed'
      : runProgress.get(testCase.id) ?? 'not run';
    const points = testCase.points ?? 1;
    if (state === 'passed') earned += points;
    const row = document.createElement('div');
    row.className = 'grade-row';
    row.dataset.passed = String(state === 'passed');
    row.dataset.status = state;
    const title = document.createElement('strong');
    title.textContent = testCase.id;
    const detail = document.createElement('span');
    const label = state === 'passed' ? 'PASS' : state === 'failed' ? 'FAIL' : state === 'running' ? 'RUNNING…' : 'NOT RUN';
    const parts = [`${label} · ${points} pt${points === 1 ? '' : 's'}`];
    if (showFeedback && result) {
      const feedback = result.passed ? testCase.feedback_on_pass : testCase.feedback_on_fail;
      if (feedback) parts.push(feedback);
      if (!result.passed && result.detail) parts.push(result.detail);
    }
    detail.textContent = parts.join(' · ');
    row.append(title, detail);
    list.append(row);
  }
  const score = possible === 0 ? 0 : Math.round((earned / possible) * 100);
  document.getElementById('preview-score').textContent = `${score}%`;
}

function renderHints() {
  const panel = document.getElementById('preview-hints');
  panel.replaceChildren();
  const hints = getConfig().hints;
  const manual = getManualHintRequestState(hints, hintState, grader.evaluate);
  if (manual.hasManualHints) {
    const request = document.createElement('button');
    request.type = 'button';
    request.className = 'btn btn-small btn-secondary';
    request.textContent = 'Request hint';
    request.disabled = !manual.canRequest;
    request.addEventListener('click', () => evaluateHintEvent({ type: 'manual' }));
    panel.append(request);
  }
  for (const hint of latestHintResult.visibleHints) {
    const card = document.createElement('div');
    card.className = 'preview-hint';
    card.dataset.style = hint.style ?? 'info';
    card.dataset.triggered = String(hint.triggered);
    card.textContent = hint.message;
    panel.append(card);
    if (hint.show_once && hint.triggered && hint.display_mode !== 'checklist') {
      consumeHint(hintState, hint.id);
    }
  }
}

function setPreviewStatus(message, status = 'ready') {
  const statusElement = document.getElementById('preview-status');
  if (statusElement) {
    let text = document.getElementById('preview-status-text');
    if (!text) {
      text = document.createElement('span');
      text.id = 'preview-status-text';
      statusElement.append(text);
    }
    text.textContent = message;
  }
  const dot = document.getElementById('preview-status-dot');
  if (dot) {
    dot.classList.toggle('is-ready', status === 'ready');
    dot.classList.toggle('is-error', status === 'error');
  }
}
