import { evaluateCondition } from './effect-evaluator.js';
import { bytesToBase64 } from './swarm-bundle.js';

const CHECK_POLL_MS = 200;
const DEFAULT_CHECK_TIMEOUT_MS = 5000;
const INSTANT_SAMPLE_TIMEOUT_MS = 250;
const ACTION_TIMEOUT_MS = 5000;

const textEncoder = new TextEncoder();

export function createTestRunner({
  testCases = [],
  bridge,
  onEvent = () => {},
  sleep,
  now,
} = {}) {
  if (!bridge || typeof bridge !== 'object') {
    throw new TypeError('createTestRunner requires a bridge');
  }
  const sleepFn = typeof sleep === 'function'
    ? sleep
    : (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
  const nowFn = typeof now === 'function' ? now : () => Date.now();

  let cancelled = false;
  let displayWarningEmitted = false;
  let activeRun = null;

  function cancelledResult(testCase) {
    return {
      id: testCase.id,
      passed: false,
      failedStepIndex: null,
      detail: 'cancelled',
      points: normalizePoints(testCase.points),
    };
  }

  function isStale(run) {
    return cancelled || run !== activeRun;
  }

  function encodeUtf8Base64(text) {
    return bytesToBase64(textEncoder.encode(String(text ?? '')));
  }

  async function executeAction(action, run) {
    if (!action || typeof action !== 'object') return;
    const count = Number.isFinite(action.count) ? Math.max(1, Math.trunc(action.count)) : 1;
    const intervalMs = Number.isFinite(action.interval_ms) ? Math.max(0, action.interval_ms) : 0;
    const options = { timeoutMs: ACTION_TIMEOUT_MS, signal: run.signal };
    for (let fire = 0; fire < count; fire += 1) {
      if (isStale(run)) return;
      switch (action.type) {
        case 'radio_broadcast':
          await bridge.radioBroadcast({
            device_id: action.device_id ?? null,
            payload_b64: encodeUtf8Base64(action.payload ?? ''),
            channel: action.channel ?? null,
            group: action.group ?? null,
          }, options);
          break;
        case 'press_button':
          await bridge.pressButton({
            device_id: action.device_id ?? null,
            button: action.button ?? 'A',
          }, options);
          break;
        case 'set_node_level':
          await bridge.setNodeLevel({
            node_id: action.node_id ?? null,
            value: action.value ?? 0,
          }, options);
          break;
        case 'move_node':
          await bridge.moveNode({
            node_id: action.node_id ?? null,
            x: action.x,
            y: action.y,
          }, options);
          break;
        case 'add_node':
          await bridge.addNode({
            node_type: action.node_type,
            x: action.x,
            y: action.y,
            level: action.level ?? null,
            duration_seconds: action.duration_seconds ?? 10,
          }, options);
          break;
        default:
          break;
      }
      if (fire < count - 1 && intervalMs > 0 && !isStale(run)) await sleepFn(intervalMs);
    }
  }

  function warnDisplayPollingFailure() {
    if (displayWarningEmitted) return;
    displayWarningEmitted = true;
    onEvent({ kind: 'runner-warning', message: 'Display polling failed; treating displays as empty.' });
  }

  async function readDisplays(options) {
    try {
      const displays = await bridge.getDisplay(options);
      return displays && typeof displays === 'object' ? displays : {};
    } catch {
      if (!options.signal?.aborted) warnDisplayPollingFailure();
      return undefined;
    }
  }

  async function readNodePositions(nodeRefs, options) {
    if (nodeRefs.length === 0) return undefined;
    try {
      const positions = await bridge.getNodePositions(nodeRefs, options);
      return toPositionMaps(positions);
    } catch {
      return undefined;
    }
  }

  function appendDisplayEvents(feed, displays, previous) {
    const updated = {};
    for (const [deviceId, pixels] of Object.entries(displays)) {
      if (!Array.isArray(pixels)) continue;
      updated[deviceId] = [...pixels];
      if (previous) {
        const before = previous[deviceId];
        if (before && framesEqual(before, pixels)) continue;
      }
      feed.push({
        ts: nowFn(),
        event: { kind: 'display', device_id: deviceId, pixels: [...pixels] },
      });
    }
    return updated;
  }

  function evaluateStep(step, feed, since, until, nowValue, nodePositions) {
    return evaluateCondition(step?.condition, feed, nowValue, { since, until, nodePositions });
  }

  function missingNodeDetail(stepIndex, evaluation) {
    const { kind, id } = evaluation.missingNode;
    return `Step ${stepIndex + 1} cannot check distance: unknown ${kind} ${id}.`;
  }

  async function runCheckStep(step, feed, since, stepIndex, run) {
    const timeoutMs = checkTimeoutMs(step);
    const startedAt = nowFn();
    const deadline = startedAt + timeoutMs;
    const needsDisplay = conditionNeedsDisplay(step?.condition);
    const needsPositions = conditionNeedsPositions(step?.condition);
    const nodeRefs = needsPositions ? collectNodeRefs(step.condition) : [];
    const needsState = needsDisplay || needsPositions;
    let previousDisplays = null;
    let nodePositions;

    if (timeoutMs === 0) {
      // One evaluation. A state sample gets its own bounded transport ceiling,
      // and evidence is still limited to what existed when the step started.
      if (needsState) {
        const options = { timeoutMs: INSTANT_SAMPLE_TIMEOUT_MS, signal: run.signal };
        const [sampledDisplays, sampledPositions] = await Promise.all([
          needsDisplay ? readDisplays(options) : undefined,
          needsPositions ? readNodePositions(nodeRefs, options) : undefined,
        ]);
        if (isStale(run)) return { cancelled: true };
        nodePositions = sampledPositions;
        if (sampledDisplays) {
          previousDisplays = appendDisplayEvents(feed, sampledDisplays, previousDisplays);
          backdateDisplayEvents(feed, previousDisplays, startedAt);
        }
      }
      const evaluation = evaluateStep(step, feed, since, startedAt, startedAt, nodePositions);
      if (evaluation.missingNode && nodePositions) {
        return { passed: false, detail: missingNodeDetail(stepIndex, evaluation) };
      }
      return { passed: evaluation.passed };
    }

    const pollCeiling = needsState
      ? Math.min(CHECK_POLL_MS, Math.max(1, Math.floor(timeoutMs / 4)))
      : CHECK_POLL_MS;

    while (true) {
      if (isStale(run)) return { cancelled: true };
      const remaining = deadline - nowFn();
      if (remaining <= 0) break;
      if (needsState) {
        const options = { timeoutMs: remaining, signal: run.signal };
        const [sampledDisplays, sampledPositions] = await Promise.all([
          needsDisplay ? readDisplays(options) : undefined,
          needsPositions ? readNodePositions(nodeRefs, options) : undefined,
        ]);
        if (isStale(run)) return { cancelled: true };
        // A reply that lands after the deadline is not in-budget evidence.
        const inBudget = nowFn() <= deadline;
        if (inBudget && sampledDisplays) {
          previousDisplays = appendDisplayEvents(feed, sampledDisplays, previousDisplays);
        }
        if (inBudget && sampledPositions) nodePositions = sampledPositions;
      }
      const evaluation = evaluateStep(
        step,
        feed,
        since,
        deadline,
        Math.min(nowFn(), deadline),
        nodePositions,
      );
      if (evaluation.missingNode && nodePositions) {
        return { passed: false, detail: missingNodeDetail(stepIndex, evaluation) };
      }
      if (evaluation.passed) return { passed: true };
      const budget = deadline - nowFn();
      if (budget <= 0) break;
      await sleepFn(Math.min(pollCeiling, budget));
    }
    if (isStale(run)) return { cancelled: true };
    const finalEvaluation = evaluateStep(
      step,
      feed,
      since,
      deadline,
      Math.min(nowFn(), deadline),
      nodePositions,
    );
    if (finalEvaluation.missingNode && nodePositions) {
      return { passed: false, detail: missingNodeDetail(stepIndex, finalEvaluation) };
    }
    return { passed: finalEvaluation.passed };
  }

  async function runTest(testCase, feed, run) {
    const points = normalizePoints(testCase.points);
    const result = (passed, failedStepIndex, detail) => ({
      id: testCase.id,
      passed,
      failedStepIndex,
      detail,
      points,
    });
    const steps = Array.isArray(testCase.steps) ? testCase.steps : [];
    const trigger = Array.isArray(testCase.trigger) ? testCase.trigger : [];

    let since = nowFn();
    for (let actionIndex = 0; actionIndex < trigger.length; actionIndex += 1) {
      if (isStale(run)) return result(false, null, 'cancelled');
      try {
        await executeAction(trigger[actionIndex], run);
      } catch (error) {
        if (isStale(run)) return result(false, null, 'cancelled');
        return result(false, null, `Trigger action ${actionIndex + 1} failed: ${errorMessage(error)}`);
      }
    }
    if (isStale(run)) return result(false, null, 'cancelled');

    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      const step = steps[stepIndex];
      if (isStale(run)) return result(false, null, 'cancelled');
      if (step?.type === 'action') {
        since = nowFn();
        try {
          await executeAction(step.action, run);
        } catch (error) {
          if (isStale(run)) return result(false, null, 'cancelled');
          return result(false, stepIndex, `Step ${stepIndex + 1} action failed: ${errorMessage(error)}`);
        }
        continue;
      }
      const outcome = await runCheckStep(step, feed, since, stepIndex, run);
      if (outcome.cancelled) return result(false, null, 'cancelled');
      if (!outcome.passed) {
        if (outcome.detail) return result(false, stepIndex, outcome.detail);
        return result(
          false,
          stepIndex,
          `Step ${stepIndex + 1} timed out after ${checkTimeoutMs(step)} ms.`,
        );
      }
      since = nowFn();
    }
    return result(true, null, 'passed');
  }

  async function runAll({ onProgress = () => {} } = {}) {
    cancelled = false;
    displayWarningEmitted = false;
    const controller = new AbortController();
    const run = { controller, signal: controller.signal };
    activeRun = run;
    const feed = [];
    const results = [];
    let earnedPoints = 0;
    const total = testCases.length;

    const unsubscribe = typeof bridge.onEvent === 'function'
      ? bridge.onEvent((payload) => {
        if (!payload || typeof payload !== 'object') return;
        feed.push({
          ts: Number.isFinite(payload.ts) ? payload.ts : nowFn(),
          event: payload.event,
        });
        onEvent(payload);
      })
      : null;

    try {
      for (let index = 0; index < total; index += 1) {
        const testCase = testCases[index];
        if (isStale(run)) {
          onProgress({ id: testCase.id, index, total, status: 'cancelled' });
          continue;
        }
        onProgress({ id: testCase.id, index, total, status: 'running' });
        const result = await runTest(testCase, feed, run);
        if (isStale(run) || result.detail === 'cancelled') {
          if (run === activeRun) onProgress({ id: testCase.id, index, total, status: 'cancelled' });
          continue;
        }
        results.push(result);
        if (result.passed) earnedPoints += result.points;
        if (run === activeRun) {
          onProgress({
            id: testCase.id,
            index,
            total,
            status: result.passed ? 'passed' : 'failed',
          });
        }
      }
    } finally {
      if (unsubscribe) unsubscribe();
      if (activeRun === run) activeRun = null;
    }

    if (cancelled) {
      return {
        results: testCases.map(cancelledResult),
        earnedPoints: 0,
        totalPoints: testCases.reduce((sum, testCase) => sum + normalizePoints(testCase.points), 0),
      };
    }
    const totalPoints = testCases.reduce((sum, testCase) => sum + normalizePoints(testCase.points), 0);
    return {
      results,
      earnedPoints,
      totalPoints,
      score: totalPoints > 0 ? Math.round((earnedPoints / totalPoints) * 100) : 0,
    };
  }

  function cancel() {
    cancelled = true;
    activeRun?.controller.abort();
  }

  return { runAll, cancel };
}

function checkTimeoutMs(step) {
  return Number.isFinite(step?.timeout_ms)
    ? Math.max(0, step.timeout_ms)
    : DEFAULT_CHECK_TIMEOUT_MS;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function conditionNeedsDisplay(condition) {
  if (!condition || typeof condition !== 'object') return false;
  if (condition.type === 'led_display') return true;
  return Array.isArray(condition.conditions) && condition.conditions.some(conditionNeedsDisplay);
}

function conditionNeedsPositions(condition) {
  if (!condition || typeof condition !== 'object') return false;
  if (condition.type === 'node_distance') return true;
  return Array.isArray(condition.conditions) && condition.conditions.some(conditionNeedsPositions);
}

/** Collect each distinct (kind, id) endpoint once per check. */
function collectNodeRefs(condition, refs = [], seen = new Set()) {
  if (!condition || typeof condition !== 'object') return refs;
  if (condition.type === 'node_distance') {
    for (const ref of [condition.node_a, condition.node_b]) {
      if (!ref || typeof ref !== 'object' || typeof ref.id !== 'string') continue;
      const kind = ref.kind === 'device' ? 'device' : 'source';
      const key = `${kind}\u0000${ref.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      refs.push({ kind, id: ref.id });
    }
  }
  if (Array.isArray(condition.conditions)) {
    for (const child of condition.conditions) collectNodeRefs(child, refs, seen);
  }
  return refs;
}

function toPositionMaps(positions) {
  const device = new Map();
  const source = new Map();
  for (const position of Array.isArray(positions) ? positions : []) {
    if (!position || typeof position !== 'object') continue;
    if (!Number.isFinite(position.x) || !Number.isFinite(position.y)) continue;
    const target = position.kind === 'device' ? device : position.kind === 'source' ? source : null;
    if (!target) continue;
    target.set(position.id, { x: position.x, y: position.y });
  }
  return { device, source };
}

/** An instant check reads the state as it was when the step started. */
function backdateDisplayEvents(feed, displays, startedAt) {
  const deviceIds = new Set(Object.keys(displays ?? {}));
  for (let index = feed.length - 1; index >= 0; index -= 1) {
    const entry = feed[index];
    if (entry.event?.kind !== 'display' || !deviceIds.has(entry.event.device_id)) continue;
    if (entry.ts > startedAt) entry.ts = startedAt;
  }
}

function normalizePoints(points) {
  return Number.isFinite(points) && points >= 0 ? points : 1;
}

function framesEqual(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
