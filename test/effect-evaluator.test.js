import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGrader, evaluateCondition } from '../src/shared/effect-evaluator.js';

function envelope(seq, ts, event) {
  return { seq, ts, event };
}

test('serial conditions match contains, exact, and regular expressions', () => {
  const grader = createGrader({
    testCases: [
      { id: 'contains', conditions: { type: 'serial_output', device_id: 'alice', match: 'contains', value: 'HELLO', case_sensitive: false } },
      { id: 'regex', conditions: { type: 'serial_output', device_id: null, match: 'regex', value: '^hello [0-9]+$' } },
      { id: 'exact', conditions: { type: 'serial_output', device_id: 'bob', match: 'exact', value: 'ready' } },
    ],
  });
  grader.record(envelope(1, 1000, { kind: 'serial', device_id: 'alice', text: 'hello 42' }));
  grader.record(envelope(2, 1001, { kind: 'serial', device_id: 'bob', text: 'ready' }));
  assert.deepEqual(grader.grade().map(({ id, passed }) => [id, passed]), [
    ['contains', true], ['regex', true], ['exact', true],
  ]);
});

test('button AB presses count, while identical transitions inside 150 ms are deduplicated', () => {
  const grader = createGrader({ testCases: [{
    id: 'both',
    conditions: { type: 'button_press', device_id: 'alice', button: 'AB', min_count: 2 },
  }] });
  assert.equal(grader.record(envelope(1, 1000, { kind: 'button', device_id: 'alice', button: 'AB', pressed: true })), true);
  assert.equal(grader.record(envelope(2, 1100, { kind: 'button', device_id: 'alice', button: 'AB', pressed: true })), false);
  assert.equal(grader.record(envelope(3, 1150, { kind: 'button', device_id: 'alice', button: 'AB', pressed: true })), true);
  assert.equal(grader.grade()[0].passed, true);
});

test('radio reception filters sender, channel, group, RSSI, and raw payload hex', () => {
  const grader = createGrader({ testCases: [
    { id: 'match', conditions: { type: 'radio_rx', device_id: 'bob', from_device_id: 'alice', channel: 7, group: 42, payload: { match: 'hex', value: '4869' }, rssi_min: -60, rssi_max: -30 } },
    { id: 'wrong-channel', conditions: { type: 'radio_rx', device_id: null, channel: 8 } },
    { id: 'weak', conditions: { type: 'radio_rx', device_id: null, rssi_min: -30 } },
    { id: 'wrong-payload', conditions: { type: 'radio_rx', device_id: null, payload: { match: 'hex', value: '6e6f' } } },
  ] });
  grader.record(envelope(1, 1000, {
    kind: 'radio-rx',
    device_id: 'bob',
    from_device_id: 'alice',
    packet: { data_b64: Buffer.from('Hi').toString('base64'), group: 42, channel: 7, signal_strength: null },
    rssi: -42,
  }));
  assert.deepEqual(grader.grade().map(({ passed }) => passed), [true, false, false, false]);
});

test('sensor readings require a continuously held in-range value and latches after passing', (t) => {
  let now = 10000;
  t.mock.method(Date, 'now', () => now);
  const condition = { type: 'sensor_reading', device_id: 'alice', sensor: 'lightLevel', min: 40, max: 60, min_duration_seconds: 2 };
  const grader = createGrader({ testCases: [{ id: 'held', conditions: condition }] });
  grader.record(envelope(1, now, { kind: 'sensor', device_id: 'alice', sensor: 'lightLevel', value: 50 }));
  now = 11999;
  assert.equal(grader.grade()[0].passed, false);
  now = 12000;
  assert.equal(grader.grade()[0].passed, true);
  now = 12100;
  grader.record(envelope(2, now, { kind: 'sensor', device_id: 'alice', sensor: 'lightLevel', value: 20 }));
  assert.equal(grader.evaluate(condition, now).passed, false);
  assert.equal(grader.grade()[0].passed, true);
});

test('composites use all/any and none means no child condition is satisfied', () => {
  const events = [envelope(1, 100, { kind: 'button', device_id: 'alice', button: 'A', pressed: true })];
  const none = { type: 'none', conditions: [
    { type: 'button_press', device_id: null, button: 'A' },
    { type: 'button_press', device_id: null, button: 'B' },
  ] };
  assert.equal(evaluateCondition(none, events).passed, false);
  assert.equal(evaluateCondition(none, []).passed, true);
  assert.equal(evaluateCondition({ type: 'any', conditions: none.conditions }, events).passed, true);
  assert.equal(evaluateCondition({ type: 'all', conditions: none.conditions }, events).passed, false);
});

test('min_count reports evidence count; reset and code-load clear the latch', () => {
  const grader = createGrader({ testCases: [{
    id: 'three',
    conditions: { type: 'serial_output', device_id: null, match: 'contains', value: 'tick', min_count: 3 },
  }] });
  grader.record(envelope(1, 1000, { kind: 'serial', device_id: 'alice', text: 'tick 1' }));
  grader.record(envelope(2, 1001, { kind: 'serial', device_id: 'bob', text: 'tick 2' }));
  assert.deepEqual(grader.grade()[0], { id: 'three', passed: false, matchCount: 2 });
  grader.record(envelope(3, 1002, { kind: 'serial', device_id: 'alice', text: 'tick 3' }));
  assert.equal(grader.grade()[0].passed, true);
  grader.record(envelope(4, 1003, { kind: 'code-load', device_id: 'alice' }));
  assert.deepEqual(grader.grade()[0], { id: 'three', passed: false, matchCount: 0 });
  grader.record(envelope(5, 1004, { kind: 'serial', device_id: 'alice', text: 'tick 4' }));
  grader.reset();
  assert.deepEqual(grader.grade()[0], { id: 'three', passed: false, matchCount: 0 });
});
