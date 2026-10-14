import * as scorm from './scorm-wrapper.js';
import { createSessionPersistence } from './session-persistence.js';
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
import { normalizeConfig } from '../../shared/config-normalizer.js';
import { validateConfig } from '../../shared/config-validator.js';
import { renderInlineMarkdown } from '../../shared/inline-markdown.js';

let config;
let grader;
let runner;
let hintState;
let bridge;
let bridgeReady = false;
let eventLog = [];
let hintTimer;
let terminated = false;
let runActive = false;
let runProgress = new Map();
let persistence = null;
let sceneCache = null;
let sceneSaveTimer = null;
const SCENE_CACHE_DEBOUNCE_MS = 500;
const seenSimulatorPayloads = new WeakSet();

const hintDebouncer = createHintEventDebouncer((event) => evaluateHintEvent(event), 250);

async function startActivity() {
  try {
    const response = await fetch('config/activity_config.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`Unable to load activity config: HTTP ${response.status}`);
    const rawConfig = await response.json();
    config = normalizeConfig(rawConfig);
    const validation = validateConfig(config);
    if (!validation.valid) {
      throw new Error(validation.errors.map((error) => `${error.path || 'config'}: ${error.message}`).join('; '));
    }

    scorm.init();
    grader = createGrader();
    hintState = createHintState();
    persistence = createSessionPersistence({
      activityId: config.metadata.activity_id || '',
      studentId: scorm.getStudentId(),
      onWarning: (message) => setStatus(message, 'warning'),
    });
    const restored = await persistence.restore();
    const restoredSceneBase64 = restored.state?.scene_bundle_base64 || null;
    renderActivityHeader();
    renderChecklist();
    renderHints();
    document.getElementById('btn-check').addEventListener('click', () => void runChecks());
    document.getElementById('btn-reset-session').addEventListener('click', () => void resetSession());
    document.getElementById('btn-request-hint').addEventListener('click', () => evaluateHintEvent({ type: 'manual' }));
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') return;
      flushSceneSaveNow();
    });
    window.addEventListener('pagehide', finishSession);
    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) return;
      terminated = false;
      scorm.resume();
    });
    await connectSimulator(restoredSceneBase64);
    runner = createTestRunner({ testCases: config.evaluation.test_cases, bridge, onEvent: handleSimulatorEvent });
    // Cache the freshly connected scene without saving it: the packaged scene
    // is not student progress, and a save here would shadow a later oversized
    // state with a small snapshot that fits suspend_data.
    await refreshSceneCache();
    if (restoredSceneBase64) {
      setStatus('Welcome back — your saved scene has been restored.', 'info');
    } else if (restored.notice) {
      setStatus(restored.notice, 'warning');
    } else {
      setStatus('Activity ready. Explore the swarm, then check your evidence.', 'info');
    }
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), 'error');
  }
}

function renderActivityHeader() {
  document.title = config.metadata.title || 'Swarm activity';
  document.getElementById('activity-title').textContent = config.metadata.title || 'Swarm activity';
  document.getElementById('instructions-content').innerHTML = renderInlineMarkdown(
    config.metadata.instructions_markdown || 'Explore the scene and look for evidence of the system at work.',
  );
}

async function connectSimulator(restoredSceneBase64 = null) {
  const frame = document.getElementById('simulator-frame');
  // A restored scene replaces the packaged one, so the frame must not load
  // the packaged bundle first and then get overwritten.
  const simulatorUrl = restoredSceneBase64
    ? 'sim/index.html?mode=learner'
    : 'sim/index.html?mode=learner&bundle=../config/scene.swarm';
  const frameWindow = frame.contentWindow;
  if (!frameWindow) throw new Error('Simulator frame is unavailable.');
  const targetOrigin = new URL(simulatorUrl, window.location.href).origin;
  bridge = connectSimBridge(frameWindow, targetOrigin);
  const connectingBridge = bridge;
  connectingBridge.onEvent(handleSimulatorEvent);
  frame.src = simulatorUrl;
  const connected = await connectingBridge.ready;
  if (!connected || connectingBridge !== bridge) {
    throw new Error('Simulator bridge closed before it became ready.');
  }
  bridgeReady = true;
  await connectingBridge.setCapabilities(config.capabilities);
  await connectingBridge.setUiVisibility(config.panel_visibility);
  if (restoredSceneBase64) {
    await connectingBridge.loadBundle(restoredSceneBase64);
  }
  document.getElementById('simulator-status').textContent = 'Connected';
}

/** Cache the simulator's current scene bundle. Deliberately saves nothing. */
async function refreshSceneCache() {
  if (!bridgeReady || !bridge) return;
  try {
    sceneCache = await bridge.getBundle();
  } catch {
    // A get-bundle failure only means the cache stays at its last value.
  }
}

/** Debounced save after a code-load event; the load-bundle is the save point. */
function scheduleSceneCacheSave() {
  clearTimeout(sceneSaveTimer);
  sceneSaveTimer = setTimeout(() => {
    sceneSaveTimer = null;
    void saveSceneCacheNow();
  }, SCENE_CACHE_DEBOUNCE_MS);
}

async function saveSceneCacheNow() {
  await refreshSceneCache();
  if (typeof sceneCache !== 'string' || sceneCache.length === 0) return;
  if (!persistence) return;
  try {
    await persistence.persist({ scene_bundle_base64: sceneCache });
  } catch (error) {
    console.warn('[App] Could not persist scene state:', error instanceof Error ? error.message : String(error));
  }
}

/** Synchronous last-word save for unload paths where async writes may not land. */
function flushSceneSaveNow() {
  clearTimeout(sceneSaveTimer);
  sceneSaveTimer = null;
  if (!persistence || typeof sceneCache !== 'string' || sceneCache.length === 0) return;
  try {
    persistence.persistNow({ scene_bundle_base64: sceneCache });
    scorm.flushPendingWrites();
  } catch (error) {
    console.warn('[App] Could not flush scene state:', error instanceof Error ? error.message : String(error));
  }
}

function handleSimulatorEvent(payload) {
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
    renderHints();
    scheduleSceneCacheSave();
  }
  eventLog.push(payload);
  if (eventLog.length > 200) eventLog.shift();
  renderEventLog();
  hintDebouncer.push({ type: 'sim_event', payload });
}

function renderRunProgress(progress) {
  runProgress.set(progress.id, progress.status);
  renderChecklist([], { progress: runProgress });
}

async function runChecks() {
  if (!runner || runActive) return;
  runActive = true;
  const button = document.getElementById('btn-check');
  const previousLabel = button.textContent;
  button.disabled = true;
  button.textContent = 'Running…';
  runProgress = new Map();
  recordCheckAttempt(hintState);
  try {
    const outcome = await runner.runAll({ onProgress: renderRunProgress });
    if (!Object.prototype.hasOwnProperty.call(outcome, 'score')) {
      runProgress.clear();
      renderChecklist();
      return;
    }
    scorm.reportScore(outcome.score);
    renderChecklist(outcome.results, { showFeedback: true });
    document.getElementById('score-display').textContent = `${outcome.score}%`;
    setStatus(`${outcome.earnedPoints} of ${outcome.totalPoints} points`, 'info');
    evaluateHintEvent({
      type: 'test_fail',
      failedCheckCount: outcome.results.filter((result) => !result.passed).length,
    });
  } catch (error) {
    setStatus(`Test run failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
  } finally {
    runActive = false;
    button.disabled = false;
    button.textContent = previousLabel;
  }
}

async function resetSession() {
  runner?.cancel();
  grader.reset();
  hintState = createHintState();
  eventLog = [];
  runProgress.clear();
  hintDebouncer.cancel();
  clearTimeout(hintTimer);
  hintTimer = undefined;
  clearTimeout(sceneSaveTimer);
  sceneSaveTimer = null;
  renderEventLog();
  renderChecklist();
  renderHints();
  document.getElementById('score-display').textContent = '—';
  setStatus('Session evidence reset. The scene remains loaded.', 'info');
  if (persistence) {
    try {
      // The current scene becomes the baseline: if the reset re-emits a
      // code-load for the same bundle, the debounced save is a fingerprint
      // no-op and the discarded session stays discarded.
      await persistence.discard(
        typeof sceneCache === 'string' && sceneCache.length > 0
          ? { scene_bundle_base64: sceneCache }
          : undefined,
      );
    } catch (error) {
      setStatus(`Saved state could not be cleared: ${error instanceof Error ? error.message : String(error)}`, 'error');
    }
  }
  if (bridgeReady) {
    try {
      await bridge.reset();
    } catch (error) {
      setStatus(`Simulator reset failed: ${error.message}`, 'error');
    }
  }
}


function evaluateHintEvent(event) {
  clearTimeout(hintTimer);
  hintTimer = undefined;
  const result = evaluateHints(config.hints, hintState, event, grader.evaluate);
  renderHints(result);
  if (result.nextEvaluationDelayMs !== null) {
    hintTimer = setTimeout(() => evaluateHintEvent({ type: 'timer' }), result.nextEvaluationDelayMs);
  }
}

function renderChecklist(results = [], { showFeedback = false, progress = runProgress } = {}) {
  const panel = document.getElementById('test-checklist');
  panel.replaceChildren();
  const resultsById = new Map(results.map((result) => [result.id, result]));
  let passed = 0;
  config.evaluation.test_cases.forEach((testCase) => {
    const result = resultsById.get(testCase.id);
    const state = result
      ? result.passed ? 'passed' : 'failed'
      : progress.get(testCase.id) ?? 'not run';
    if (state === 'passed') passed += 1;
    const points = testCase.points ?? 1;
    const row = document.createElement('div');
    row.className = 'test-row';
    row.dataset.passed = String(state === 'passed');
    row.dataset.status = state;
    const mark = document.createElement('span');
    mark.className = 'test-row-mark';
    mark.textContent = state === 'passed' ? '✓' : state === 'failed' ? '×' : state === 'running' ? '…' : '·';
    const content = document.createElement('span');
    content.className = 'test-row-content';
    const title = document.createElement('strong');
    title.textContent = testCase.id;
    const detail = document.createElement('small');
    detail.textContent = `${state === 'running' ? 'running…' : state} · ${points} pt${points === 1 ? '' : 's'}`;
    content.append(title, detail);
    if (showFeedback && result) {
      const feedback = document.createElement('small');
      feedback.className = 'test-feedback';
      feedback.textContent = result.passed ? testCase.feedback_on_pass ?? '' : testCase.feedback_on_fail ?? '';
      if (feedback.textContent) content.append(feedback);
      if (!result.passed && result.detail) {
        const resultDetail = document.createElement('small');
        resultDetail.className = 'test-result-detail';
        resultDetail.textContent = result.detail;
        content.append(resultDetail);
      }
    }
    row.append(mark, content);
    panel.append(row);
  });
  document.getElementById('check-count').textContent = `${passed} / ${config.evaluation.test_cases.length}`;
}

function renderEventLog() {
  const list = document.getElementById('event-log');
  list.replaceChildren();
  document.getElementById('event-count').textContent = String(eventLog.length);
  if (eventLog.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'event-log-empty';
    empty.textContent = 'No simulation effects yet.';
    list.append(empty);
    return;
  }
  for (const payload of eventLog.slice(-80).reverse()) {
    const line = document.createElement('li');
    line.dataset.kind = payload.event.kind;
    line.textContent = formatEvent(payload);
    list.append(line);
  }
}

function renderHints(result = evaluateHints(config.hints, hintState, { type: 'timer' }, grader.evaluate)) {
  const list = document.getElementById('hint-list');
  const requestButton = document.getElementById('btn-request-hint');
  list.replaceChildren();
  const manual = getManualHintRequestState(config.hints, hintState, grader.evaluate);
  requestButton.hidden = !manual.hasManualHints;
  requestButton.disabled = !manual.canRequest;
  if (result.visibleHints.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'hint-empty';
    empty.textContent = 'Hints appear as you explore.';
    list.append(empty);
  }
  document.getElementById('hint-count').textContent = String(result.visibleHints.length);
  for (const hint of result.visibleHints) {
    const card = document.createElement(hint.display_mode === 'checklist' ? 'div' : 'article');
    card.className = hint.display_mode === 'checklist' ? 'hint-checklist-item' : 'hint-card';
    card.classList.toggle('is-complete', hint.triggered);
    card.dataset.style = hint.style ?? 'info';
    const mark = document.createElement('span');
    mark.className = 'hint-mark';
    mark.textContent = hint.triggered ? '✓' : '·';
    const message = document.createElement('span');
    message.className = 'hint-message';
    message.textContent = hint.message;
    card.append(mark, message);
    list.append(card);
    if (hint.show_once && hint.triggered && hint.display_mode !== 'checklist') consumeHint(hintState, hint.id);
  }
}

function formatEvent(payload) {
  const event = payload.event;
  switch (event.kind) {
    case 'serial': return `${event.device_id} · serial: ${event.text}`;
    case 'button': return `${event.device_id} · ${event.button} ${event.pressed ? 'pressed' : 'released'}`;
    case 'radio-tx': return `${event.device_id} · radio TX · group ${event.packet.group ?? '—'} · channel ${event.packet.channel ?? '—'}`;
    case 'radio-rx': return `${event.device_id} ← ${event.from_device_id} · radio RX · RSSI ${event.rssi}`;
    case 'radio-blocked': return `${event.device_id} · radio blocked · ${event.reason}`;
    case 'sensor': return `${event.device_id} · ${event.sensor}: ${event.value}`;
    case 'display': return `${event.device_id} · display ${event.pixels.filter((pixel) => pixel > 0).length} lit`;
    case 'code-load': return `${event.device_id} · program loaded; evidence reset`;
    default: return event.kind;
  }
}

function setStatus(message, kind) {
  const status = document.getElementById('status-bar');
  status.textContent = message;
  status.className = `status-bar status-${kind}`;
}
function finishSession() {
  if (terminated) return;
  terminated = true;
  hintDebouncer.cancel();
  clearTimeout(hintTimer);
  hintTimer = undefined;
  // persistNow is synchronous suspend_data writes, so the save survives teardown.
  flushSceneSaveNow();
  scorm.terminate();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void startActivity(), { once: true });
} else {
  void startActivity();
}
