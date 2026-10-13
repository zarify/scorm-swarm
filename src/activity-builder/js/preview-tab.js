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
import { getConfig, getSceneBundle, onConfigChange, onSceneChange, showToast } from './app.js';

let bridge;
let bridgeReady = false;
let grader;
let hintState;
let latestHintResult = { visibleHints: [], nextEvaluationDelayMs: null };
let eventLog = [];
let hintTimer;
const hintDebouncer = createHintEventDebouncer(evaluateHintEvent, 250);

export function initPreviewTab() {
  grader = createGrader({ testCases: getConfig().evaluation.test_cases });
  hintState = createHintState();
  const iframe = document.getElementById('preview-iframe');
  void connectPreview(iframe);
  document.getElementById('btn-reset-session').addEventListener('click', () => void resetSession());
  document.getElementById('btn-check-session').addEventListener('click', checkSession);
  onConfigChange((config) => {
    grader = createGrader({ testCases: config.evaluation.test_cases });
    hintState = createHintState();
    eventLog = [];
    hintDebouncer.cancel();
    clearTimeout(hintTimer);
    hintTimer = undefined;
    renderEventLog();
    renderGrades(null);
    evaluateHintEvent({ type: 'timer' });
    if (bridgeReady) void bridge.setCapabilities(config.capabilities);
  });
  onSceneChange((bundle) => {
    grader.reset();
    hintState = createHintState();
    eventLog = [];
    hintDebouncer.cancel();
    clearTimeout(hintTimer);
    hintTimer = undefined;
    renderEventLog();
    renderGrades(null);
    evaluateHintEvent({ type: 'timer' });
    if (bundle && bridgeReady) {
      void bridge.loadBundle(bundle).catch((error) =>
        showToast(`Could not load preview scene: ${error.message}`, 'error'),
      );
    }
  });
  renderEventLog();
  renderGrades(null);
  renderHints();
}

async function connectPreview(iframe) {
  bridge?.close();
  bridgeReady = false;
  setPreviewStatus('Waiting for learner simulator…');
  if (!iframe.contentWindow) {
    setPreviewStatus('Learner simulator frame is unavailable.', 'error');
    return;
  }
  const learnerUrl = 'sim/index.html?mode=learner';
  const targetOrigin = new URL(learnerUrl, window.location.href).origin;
  bridge = connectSimBridge(iframe.contentWindow, targetOrigin);
  const connectingBridge = bridge;
  bridge.onEvent((payload) => {
    const event = payload.event;
    grader.record(payload);
    if (event.kind === 'code-load') {
      hintState = createHintState();
      hintDebouncer.cancel();
    }
    eventLog.push(payload);
    if (eventLog.length > 100) eventLog.shift();
    renderEventLog();
    renderGrades(grader.grade());
    hintDebouncer.push({ type: 'sim_event', payload });
  });
  iframe.src = learnerUrl;

  try {
    const ready = await connectingBridge.ready;
    if (!ready || connectingBridge !== bridge) return;
    bridgeReady = true;
    await connectingBridge.setCapabilities(getConfig().capabilities);
    const bundle = getSceneBundle();
    if (bundle) await connectingBridge.loadBundle(bundle);
    setPreviewStatus('Learner simulator connected.');
  } catch (error) {
    setPreviewStatus(error instanceof Error ? error.message : 'Learner simulator failed to connect.', 'error');
  }
}

function checkSession() {
  recordCheckAttempt(hintState);
  const grades = grader.grade();
  const failedCheckCount = grades.filter((grade) => !grade.passed).length;
  renderGrades(grades);
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
  renderGrades(null);
  evaluateHintEvent({ type: 'timer' });
  if (bridgeReady) {
    try {
      await bridge.reset();
    } catch (error) {
      showToast(`Could not reset simulator: ${error.message}`, 'error');
    }
  }
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

function renderEventLog() {
  const list = document.getElementById('preview-event-log');
  list.replaceChildren();
  document.getElementById('preview-event-count').textContent = String(eventLog.length);
  if (eventLog.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'event-log-empty';
    empty.textContent = 'No simulator events yet.';
    list.append(empty);
    return;
  }
  for (const payload of eventLog.slice(-60).reverse()) {
    const line = document.createElement('li');
    line.dataset.kind = payload.event.kind;
    line.textContent = formatEvent(payload);
    list.append(line);
  }
}

function renderGrades(grades) {
  const list = document.getElementById('preview-grades');
  list.replaceChildren();
  if (!grades) {
    const empty = document.createElement('p');
    empty.className = 'empty-note';
    empty.textContent = 'Run the scene, then select Check.';
    list.append(empty);
    document.getElementById('preview-score').textContent = '—';
    return;
  }
  const config = getConfig();
  const cases = config.evaluation.test_cases;
  const byId = new Map(cases.map((testCase) => [testCase.id, testCase]));
  let earned = 0;
  let possible = 0;
  for (const grade of grades) {
    const testCase = byId.get(grade.id);
    const points = testCase?.points ?? 1;
    possible += points;
    if (grade.passed) earned += points;
    const row = document.createElement('div');
    row.className = 'grade-row';
    row.dataset.passed = String(grade.passed);
    const title = document.createElement('strong');
    title.textContent = grade.id;
    const detail = document.createElement('span');
    const feedback = grade.passed ? testCase?.feedback_on_pass : testCase?.feedback_on_fail;
    detail.textContent = `${grade.passed ? 'PASS' : 'WAIT'} · ${grade.matchCount} match${grade.matchCount === 1 ? '' : 'es'} · ${points} pt${points === 1 ? '' : 's'}${feedback ? ` · ${feedback}` : ''}`;
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

function formatEvent(payload) {
  const event = payload.event;
  const time = new Date(payload.ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  switch (event.kind) {
    case 'serial':
      return `${time} · ${event.device_id} · serial: ${event.text}`;
    case 'button':
      return `${time} · ${event.device_id} · ${event.button} ${event.pressed ? 'pressed' : 'released'}`;
    case 'radio-tx':
      return `${time} · ${event.device_id} · radio TX group ${event.packet.group ?? '—'} / ch ${event.packet.channel ?? '—'}`;
    case 'radio-rx':
      return `${time} · ${event.device_id} ← ${event.from_device_id} · radio RX RSSI ${event.rssi}`;
    case 'radio-blocked':
      return `${time} · ${event.device_id} · radio blocked: ${event.reason}`;
    case 'sensor':
      return `${time} · ${event.device_id} · ${event.sensor} = ${event.value}`;
    case 'code-load':
      return `${time} · ${event.device_id} · program loaded (evidence reset)`;
    default:
      return `${time} · ${event.kind}`;
  }
}

function setPreviewStatus(message, status = 'ready') {
  const statusElement = document.getElementById('preview-status');
  statusElement.lastChild.textContent = message;
  const dot = document.getElementById('preview-status-dot');
  dot.classList.toggle('is-ready', status === 'ready');
  dot.classList.toggle('is-error', status === 'error');
}
