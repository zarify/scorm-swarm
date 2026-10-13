import * as scorm from './scorm-wrapper.js';
import { createGrader } from '../../shared/effect-evaluator.js';
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
let hintState;
let bridge;
let bridgeReady = false;
let eventLog = [];
let hintTimer;
let terminated = false;

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
    grader = createGrader({ testCases: config.evaluation.test_cases });
    hintState = createHintState();
    renderActivityHeader();
    renderChecklist(grader.grade());
    renderHints();
    document.getElementById('btn-check').addEventListener('click', checkActivity);
    document.getElementById('btn-reset-session').addEventListener('click', () => void resetSession());
    document.getElementById('btn-request-hint').addEventListener('click', () => evaluateHintEvent({ type: 'manual' }));
    window.addEventListener('pagehide', finishSession);
    window.addEventListener('pageshow', (event) => {
      if (!event.persisted) return;
      terminated = false;
      scorm.resume();
    });
    await connectSimulator();
    setStatus('Activity ready. Explore the swarm, then check your evidence.', 'info');
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

async function connectSimulator() {
  const frame = document.getElementById('simulator-frame');
  const simulatorUrl = 'sim/index.html?mode=learner&bundle=../config/scene.swarm';
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
  document.getElementById('simulator-status').textContent = 'Connected';
}

function handleSimulatorEvent(payload) {
  const event = payload.event;
  grader.record(payload);
  if (event.kind === 'code-load') {
    hintState = createHintState();
    hintDebouncer.cancel();
    renderHints();
  }
  eventLog.push(payload);
  if (eventLog.length > 200) eventLog.shift();
  renderEventLog();
  renderChecklist(grader.grade());
  hintDebouncer.push({ type: 'sim_event', payload });
}

function checkActivity() {
  if (!grader) return;
  recordCheckAttempt(hintState);
  const results = grader.grade();
  const failedCheckCount = results.filter((result) => !result.passed).length;
  const testCases = config.evaluation.test_cases;
  const pointsById = new Map(testCases.map((testCase) => [testCase.id, testCase.points ?? 1]));
  const totalPoints = testCases.reduce((sum, testCase) => sum + (testCase.points ?? 1), 0);
  const earnedPoints = results.reduce((sum, result) =>
    sum + (result.passed ? (pointsById.get(result.id) ?? 0) : 0), 0);
  const score = totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 100) : 0;
  const passed = score >= config.evaluation.pass_threshold;
  scorm.reportScore(score, config.evaluation.pass_threshold);
  renderChecklist(results, { showFeedback: true });
  document.getElementById('score-display').textContent = `${score}%`;
  setStatus(
    `${earnedPoints} of ${totalPoints} points · ${passed ? 'passing score' : `pass threshold ${config.evaluation.pass_threshold}%`}`,
    passed ? 'success' : 'warning',
  );
  evaluateHintEvent({ type: 'test_fail', failedCheckCount });
}

async function resetSession() {
  grader.reset();
  hintState = createHintState();
  eventLog = [];
  hintDebouncer.cancel();
  clearTimeout(hintTimer);
  hintTimer = undefined;
  renderEventLog();
  renderChecklist(grader.grade());
  renderHints();
  document.getElementById('score-display').textContent = '—';
  setStatus('Session evidence reset. The scene remains loaded.', 'info');
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

function renderChecklist(results, { showFeedback = false } = {}) {
  const panel = document.getElementById('test-checklist');
  panel.replaceChildren();
  const resultsById = new Map(results.map((result) => [result.id, result]));
  let passed = 0;
  config.evaluation.test_cases.forEach((testCase) => {
    const result = resultsById.get(testCase.id) ?? { passed: false, matchCount: 0 };
    if (result.passed) passed += 1;
    const row = document.createElement('div');
    row.className = 'test-row';
    row.dataset.passed = String(result.passed);
    const mark = document.createElement('span');
    mark.className = 'test-row-mark';
    mark.textContent = result.passed ? '✓' : '·';
    const content = document.createElement('span');
    content.className = 'test-row-content';
    const title = document.createElement('strong');
    title.textContent = testCase.id;
    const detail = document.createElement('small');
    detail.textContent = `${result.passed ? 'Evidence collected' : `${result.matchCount} matching event${result.matchCount === 1 ? '' : 's'}`} · ${testCase.points ?? 1} pt${testCase.points === 1 ? '' : 's'}`;
    content.append(title, detail);
    if (showFeedback) {
      const feedback = document.createElement('small');
      feedback.className = 'test-feedback';
      feedback.textContent = result.passed ? testCase.feedback_on_pass ?? '' : testCase.feedback_on_fail ?? '';
      if (feedback.textContent) content.append(feedback);
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
  scorm.terminate();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void startActivity(), { once: true });
} else {
  void startActivity();
}
