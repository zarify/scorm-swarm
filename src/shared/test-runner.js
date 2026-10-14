import { evaluateCondition } from './effect-evaluator.js';
import { bytesToBase64 } from './swarm-bundle.js';

const CHECK_POLL_MS = 200;
const DEFAULT_CHECK_TIMEOUT_SECONDS = 5;

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

  function cancelledResult(testCase) {
    return {
      id: testCase.id,
      passed: false,
      failedStepIndex: null,
      detail: 'cancelled',
      points: normalizePoints(testCase.points),
    };
  }

  function timeoutSecondsOf(step) {
    return Number.isFinite(step?.timeout_seconds)
      ? step.timeout_seconds
      : DEFAULT_CHECK_TIMEOUT_SECONDS;
  }

  function encodeUtf8Base64(text) {
    return bytesToBase64(textEncoder.encode(String(text ?? '')));
  }

  async function executeAction(action) {
    if (!action || typeof action !== 'object') return;
    const count = Number.isFinite(action.count) ? Math.max(1, Math.trunc(action.count)) : 1;
    const intervalMs = Number.isFinite(action.interval_ms) ? Math.max(0, action.interval_ms) : 0;
    for (let fire = 0; fire < count; fire += 1) {
      if (cancelled) return;
      switch (action.type) {
        case 'radio_broadcast':
          await bridge.radioBroadcast({
            device_id: action.device_id ?? null,
            payload_b64: encodeUtf8Base64(action.payload ?? ''),
            channel: action.channel ?? null,
            group: action.group ?? null,
          });
          break;
        case 'press_button':
          await bridge.pressButton({
            device_id: action.device_id ?? null,
            button: action.button ?? 'A',
          });
          break;
        case 'set_node_level':
          await bridge.setNodeLevel({
            node_id: action.node_id ?? null,
            value: action.value ?? 0,
          });
          break;
        case 'add_node':
          await bridge.addNode({
            node_type: action.node_type,
            x: action.x,
            y: action.y,
            level: action.level ?? null,
            duration_seconds: action.duration_seconds ?? 10,
          });
          break;
        default:
          break;
      }
      if (fire < count - 1 && intervalMs > 0 && !cancelled) await sleepFn(intervalMs);
    }
  }

  async function pollDisplays() {
    try {
      const displays = await bridge.getDisplay();
      return displays && typeof displays === 'object' ? displays : {};
    } catch {
      if (!displayWarningEmitted) {
        displayWarningEmitted = true;
        onEvent({ kind: 'runner-warning', message: 'Display polling failed; treating displays as empty.' });
      }
      return {};
    }
  }

  function appendDisplayEvents(feed, displays, previous) {
    for (const [deviceId, pixels] of Object.entries(displays)) {
      if (!Array.isArray(pixels)) continue;
      if (previous) {
        const before = previous[deviceId];
        if (before && framesEqual(before, pixels)) continue;
      }
      feed.push({
        ts: nowFn(),
        event: { kind: 'display', device_id: deviceId, pixels: [...pixels] },
      });
    }
  }

  async function runCheckStep(step, feed, since) {
    const timeoutSeconds = timeoutSecondsOf(step);
    const timeoutMs = Math.max(0, timeoutSeconds * 1000);
    const startedAt = nowFn();
    let previousDisplays = null;

    while (true) {
      if (cancelled) return { cancelled: true };
      const displays = await pollDisplays();
      appendDisplayEvents(feed, displays, previousDisplays);
      previousDisplays = Object.fromEntries(
        Object.entries(displays)
          .filter(([, pixels]) => Array.isArray(pixels))
          .map(([deviceId, pixels]) => [deviceId, [...pixels]]),
      );

      const evaluation = evaluateCondition(step?.condition, feed, nowFn(), { since });
      if (evaluation.passed) return { passed: true };
      if (cancelled) return { cancelled: true };
      if (timeoutMs === 0 || nowFn() - startedAt >= timeoutMs) return { passed: false };
      await sleepFn(CHECK_POLL_MS);
    }
  }

  async function runTest(testCase, feed) {
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
    for (const action of trigger) {
      if (cancelled) return result(false, null, 'cancelled');
      await executeAction(action);
    }
    if (cancelled) return result(false, null, 'cancelled');

    for (let stepIndex = 0; stepIndex < steps.length; stepIndex += 1) {
      const step = steps[stepIndex];
      if (cancelled) return result(false, null, 'cancelled');
      if (step?.type === 'action') {
        since = nowFn();
        await executeAction(step.action);
        if (cancelled) return result(false, null, 'cancelled');
        continue;
      }
      const outcome = await runCheckStep(step, feed, since);
      if (outcome.cancelled) return result(false, null, 'cancelled');
      if (!outcome.passed) {
        return result(
          false,
          stepIndex,
          `step ${stepIndex + 1} timed out after ${timeoutSecondsOf(step)}s`,
        );
      }
      since = nowFn();
    }
    return result(true, null, 'passed');
  }

  async function runAll({ onProgress = () => {} } = {}) {
    cancelled = false;
    displayWarningEmitted = false;
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
        if (cancelled) {
          onProgress({ id: testCase.id, index, total, status: 'cancelled' });
          continue;
        }
        onProgress({ id: testCase.id, index, total, status: 'running' });
        const result = await runTest(testCase, feed);
        if (cancelled || result.detail === 'cancelled') {
          onProgress({ id: testCase.id, index, total, status: 'cancelled' });
          continue;
        }
        results.push(result);
        if (result.passed) earnedPoints += result.points;
        onProgress({
          id: testCase.id,
          index,
          total,
          status: result.passed ? 'passed' : 'failed',
        });
      }
    } finally {
      if (unsubscribe) unsubscribe();
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
  }

  return { runAll, cancel };
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
