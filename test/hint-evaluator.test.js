import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  consumeHint,
  createHintEventDebouncer,
  createHintState,
  evaluateHints,
  getManualHintRequestState,
  recordCheckAttempt,
} from '../src/shared/hint-evaluator.js';

const always = () => ({ passed: true });

function ids(result) {
  return result.visibleHints.map((hint) => hint.id);
}

test('a fresh hint state is isolated and delayed hints use explicit time', () => {
  const first = createHintState();
  const second = createHintState();
  first.consumed.add('old');
  assert.equal(second.consumed.has('old'), false);

  const hint = { id: 'delayed', message: 'wait', delay_seconds: 2, trigger: { event: 'sim_event', conditions: {} } };
  let result = evaluateHints([hint], second, { type: 'sim_event' }, always, { now: 1000 });
  assert.deepEqual(ids(result), []);
  assert.equal(result.nextEvaluationDelayMs, 2000);
  result = evaluateHints([hint], second, { type: 'timer' }, always, { now: 2999 });
  assert.deepEqual(ids(result), []);
  assert.equal(result.nextEvaluationDelayMs, 1);
  result = evaluateHints([hint], second, { type: 'timer' }, always, { now: 3000 });
  assert.deepEqual(ids(result), ['delayed']);
});

test('a false live condition resets its delay clock and can invalidate an already triggered hint', () => {
  const hint = {
    id: 'live',
    message: 'condition hint',
    delay_seconds: 1,
    trigger: { event: 'sim_event', conditions: {}, invalidate_on_condition_false: true },
  };
  const state = createHintState();
  evaluateHints([hint], state, { type: 'sim_event' }, always, { now: 1000 });
  let result = evaluateHints([hint], state, { type: 'sim_event' }, () => ({ passed: false }), { now: 1500 });
  assert.equal(result.nextEvaluationDelayMs, null);
  assert.equal(state.firstTriggered.has('live'), false);
  result = evaluateHints([hint], state, { type: 'sim_event' }, always, { now: 2000 });
  assert.equal(result.nextEvaluationDelayMs, 1000);
  result = evaluateHints([hint], state, { type: 'timer' }, always, { now: 3000 });
  assert.deepEqual(ids(result), ['live']);
  result = evaluateHints([hint], state, { type: 'sim_event' }, () => ({ passed: false }), { now: 3100 });
  assert.deepEqual(ids(result), []);
  assert.equal(state.triggered.has('live'), false);
});

test('after_attempts uses Check attempts, not the number of failed tests', () => {
  const hint = { id: 'retry', message: 'try again', trigger: { event: 'test_fail', conditions: {}, after_attempts: 2 } };
  const state = createHintState();
  let calls = 0;
  const evaluator = () => { calls += 1; return true; };
  recordCheckAttempt(state);
  assert.deepEqual(ids(evaluateHints([hint], state, { type: 'test_fail', failedCheckCount: 8 }, evaluator)), []);
  assert.equal(calls, 0);
  recordCheckAttempt(state);
  assert.deepEqual(ids(evaluateHints([hint], state, { type: 'test_fail', failedCheckCount: 0 }, evaluator)), []);
  assert.equal(calls, 0);
  assert.deepEqual(ids(evaluateHints([hint], state, { type: 'test_fail', failedCheckCount: 1 }, evaluator)), ['retry']);
  assert.equal(calls, 1);
});

test('checklist hints stay listed, triggered hints wait, and priority determines order', () => {
  const hints = [
    { id: 'low', message: 'low', priority: 1, display_mode: 'triggered', trigger: { event: 'manual', conditions: {} } },
    { id: 'check', message: 'check', priority: 2, display_mode: 'checklist', trigger: { event: 'manual', conditions: {} } },
    { id: 'high', message: 'high', priority: 4, display_mode: 'triggered', trigger: { event: 'manual', conditions: {} } },
  ];
  const state = createHintState();
  let result = evaluateHints(hints, state, null, always);
  assert.deepEqual(ids(result), ['check']);
  result = evaluateHints(hints, state, { type: 'manual' }, always);
  assert.deepEqual(ids(result), ['high', 'check', 'low']);
  assert.equal(result.visibleHints.find((hint) => hint.id === 'check').triggered, true);
});

test('show-once hints remain until the caller consumes them', () => {
  const hint = { id: 'once', message: 'one time', show_once: true, trigger: { event: 'manual', conditions: {} } };
  const state = createHintState();
  assert.deepEqual(ids(evaluateHints([hint], state, { type: 'manual' }, always)), ['once']);
  assert.deepEqual(ids(evaluateHints([hint], state, { type: 'manual' }, always)), ['once']);
  assert.equal(state.consumed.has('once'), false);
  consumeHint(state, 'once');
  assert.deepEqual(ids(evaluateHints([hint], state, { type: 'manual' }, always)), []);
});

test('manual request state reflects conditions, attempt thresholds, and consumption', () => {
  const hint = { id: 'manual', message: 'help', show_once: true, trigger: { event: 'manual', conditions: {}, after_attempts: 1 } };
  const state = createHintState();
  assert.deepEqual(getManualHintRequestState([hint], state, always), { hasManualHints: true, canRequest: false });
  recordCheckAttempt(state);
  assert.deepEqual(getManualHintRequestState([hint], state, always), { hasManualHints: true, canRequest: true });
  consumeHint(state, 'manual');
  assert.deepEqual(getManualHintRequestState([hint], state, always), { hasManualHints: true, canRequest: false });
});

test('simulation hint events debounce to the latest event after the quiet interval', async () => {
  const seen = [];
  const debouncer = createHintEventDebouncer((event) => seen.push(event), 10);
  debouncer.push({ type: 'sim_event', seq: 1 });
  debouncer.push({ type: 'sim_event', seq: 2 });
  await new Promise((resolve) => setTimeout(resolve, 25));
  assert.deepEqual(seen, [{ type: 'sim_event', seq: 2 }]);
  debouncer.cancel();
});
