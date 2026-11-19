import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createGrader, evaluateCondition } from '../src/shared/effect-evaluator.js';

function envelope(seq, ts, event) {
  return { seq, ts, event };
}

const HAPPY_FRAME = [
  0, 0, 0, 0, 0,
  0, 9, 0, 9, 0,
  0, 0, 0, 0, 0,
  9, 0, 0, 0, 9,
  0, 9, 9, 9, 0,
];
const HAPPY_LAYOUT = '.....\n.#.#.\n.....\n#...#\n.###.';

test('serial conditions match contains, exact, and regular expressions', () => {
  const events = [
    envelope(1, 1000, { kind: 'serial', device_id: 'alice', text: 'hello 42' }),
    envelope(2, 1001, { kind: 'serial', device_id: 'bob', text: 'ready' }),
  ];
  assert.equal(evaluateCondition({ type: 'serial_output', device_id: 'alice', match: 'contains', value: 'HELLO', case_sensitive: false }, events).passed, true);
  assert.equal(evaluateCondition({ type: 'serial_output', device_id: null, match: 'regex', value: '^hello [0-9]+$' }, events).passed, true);
  assert.equal(evaluateCondition({ type: 'serial_output', device_id: 'bob', match: 'exact', value: 'ready' }, events).passed, true);
  assert.equal(evaluateCondition({ type: 'serial_output', device_id: 'bob', match: 'exact', value: 'ready' }, events, 1001).matchCount, 1);
});

test('radio reception filters sender, channel, group, RSSI, and raw payload hex', () => {
  const events = [envelope(1, 1000, {
    kind: 'radio-rx',
    device_id: 'bob',
    from_device_id: 'alice',
    packet: { data_b64: Buffer.from('Hi').toString('base64'), group: 42, channel: 7, signal_strength: null },
    rssi: -42,
  })];
  assert.equal(evaluateCondition({ type: 'radio_rx', device_id: 'bob', from_device_id: 'alice', channel: 7, group: 42, payload: { match: 'hex', value: '4869' }, rssi_min: -60, rssi_max: -30 }, events).passed, true);
  assert.equal(evaluateCondition({ type: 'radio_rx', device_id: null, channel: 8 }, events).passed, false);
  assert.equal(evaluateCondition({ type: 'radio_rx', device_id: null, rssi_min: -30 }, events).passed, false);
  assert.equal(evaluateCondition({ type: 'radio_rx', device_id: null, payload: { match: 'hex', value: '6e6f' } }, events).passed, false);
});

test('button AB presses count, while identical transitions inside 150 ms are deduplicated', () => {
  const grader = createGrader();
  assert.equal(grader.record(envelope(1, 1000, { kind: 'button', device_id: 'alice', button: 'AB', pressed: true })), true);
  assert.equal(grader.record(envelope(2, 1100, { kind: 'button', device_id: 'alice', button: 'AB', pressed: true })), false);
  assert.equal(grader.record(envelope(3, 1150, { kind: 'button', device_id: 'alice', button: 'AB', pressed: true })), true);
  assert.equal(
    grader.evaluate({ type: 'button_press', device_id: 'alice', button: 'AB', min_count: 2 }, 1150).passed,
    true,
  );
});

test('sensor readings require a continuously held in-range value', (t) => {
  let now = 10000;
  t.mock.method(Date, 'now', () => now);
  const condition = { type: 'sensor_reading', device_id: 'alice', sensor: 'lightLevel', min: 40, max: 60, min_duration_seconds: 2 };
  const grader = createGrader();
  grader.record(envelope(1, now, { kind: 'sensor', device_id: 'alice', sensor: 'lightLevel', value: 50 }));
  now = 11999;
  assert.equal(grader.evaluate(condition).passed, false);
  now = 12000;
  assert.equal(grader.evaluate(condition).passed, true);
  grader.record(envelope(2, now, { kind: 'sensor', device_id: 'alice', sensor: 'lightLevel', value: 20 }));
  assert.equal(grader.evaluate(condition).passed, false);
});

test('led_display matches the latest display frame as lit/unlit cells', () => {
  const grader = createGrader();
  grader.record(envelope(1, 1000, { kind: 'display', device_id: 'alice', pixels: HAPPY_FRAME }));
  assert.equal(grader.evaluate({ type: 'led_display', device_id: 'alice', layout: HAPPY_LAYOUT }, 1000).passed, true);
  // #/1 both mean lit, ./0 both mean unlit.
  assert.equal(grader.evaluate({ type: 'led_display', device_id: 'alice', layout: '00000\n01010\n00000\n10001\n01110' }, 1000).passed, true);
  assert.equal(grader.evaluate({ type: 'led_display', device_id: 'alice', layout: HAPPY_LAYOUT.split('\n').reverse().join('\n') }, 1000).passed, false);
  assert.equal(grader.evaluate({ type: 'led_display', device_id: 'bob', layout: HAPPY_LAYOUT }, 1000).passed, false);
  // Latest frame wins.
  grader.record(envelope(2, 1100, { kind: 'display', device_id: 'alice', pixels: new Array(25).fill(0) }));
  assert.equal(grader.evaluate({ type: 'led_display', device_id: 'alice', layout: HAPPY_LAYOUT }, 1100).passed, false);
  assert.equal(grader.evaluate({ type: 'led_display', device_id: 'alice', layout: '.....\n.....\n.....\n.....\n.....' }, 1100).passed, true);
  grader.reset();
  assert.equal(grader.evaluate({ type: 'led_display', device_id: 'alice', layout: '.....\n.....\n.....\n.....\n.....' }, 1100).passed, false);
});

test('led_display ignores zero-value pixels and short frames', () => {
  const events = [
    envelope(1, 1000, { kind: 'display', device_id: 'alice', pixels: HAPPY_FRAME.map((value) => (value > 0 ? 0 : value)) }),
    envelope(2, 1000, { kind: 'display', device_id: 'bob', pixels: [1, 0, 1] }),
  ];
  assert.equal(evaluateCondition({ type: 'led_display', device_id: 'alice', layout: HAPPY_LAYOUT }, events).passed, false);
  assert.equal(evaluateCondition({ type: 'led_display', device_id: 'bob', layout: '###' }, events).passed, false);
  assert.equal(evaluateCondition({ type: 'led_display', device_id: 'alice', layout: '...' }, events).passed, false);
});

test('since windows filter event counts but not sensor or display state', () => {
  const events = [
    envelope(1, 1000, { kind: 'serial', device_id: 'alice', text: 'tick' }),
    envelope(2, 1500, { kind: 'serial', device_id: 'alice', text: 'tick' }),
    envelope(3, 1500, { kind: 'sensor', device_id: 'alice', sensor: 'lightLevel', value: 50 }),
    envelope(4, 1500, { kind: 'display', device_id: 'alice', pixels: HAPPY_FRAME }),
  ];
  const serial = { type: 'serial_output', device_id: 'alice', match: 'contains', value: 'tick', min_count: 2 };
  assert.equal(evaluateCondition(serial, events, 1600).matchCount, 2);
  assert.equal(evaluateCondition(serial, events, 1600, { since: 1200 }).matchCount, 1);
  assert.equal(evaluateCondition(serial, events, 1600, { since: 1500 }).matchCount, 1);
  assert.equal(evaluateCondition(serial, events, 1600, { since: 1600 }).passed, false);
  // State conditions use the latest state regardless of since.
  const sensor = { type: 'sensor_reading', device_id: 'alice', sensor: 'lightLevel', min: 40, max: 60 };
  assert.equal(evaluateCondition(sensor, events, 1600, { since: 1600 }).passed, true);
  const display = { type: 'led_display', device_id: 'alice', layout: HAPPY_LAYOUT };
  assert.equal(evaluateCondition(display, events, 1600, { since: 1600 }).passed, true);
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

test('an until window excludes later events from counts, sensors, and displays', () => {
  const events = [
    envelope(1, 1000, { kind: 'serial', device_id: 'alice', text: 'tick' }),
    envelope(2, 1126, { kind: 'serial', device_id: 'alice', text: 'tick' }),
    envelope(3, 1126, { kind: 'sensor', device_id: 'alice', sensor: 'lightLevel', value: 5 }),
    envelope(4, 1126, { kind: 'display', device_id: 'alice', pixels: HAPPY_FRAME }),
  ];
  const serial = { type: 'serial_output', device_id: 'alice', match: 'contains', value: 'tick', min_count: 2 };
  assert.equal(evaluateCondition(serial, events, 1200, { until: 1125 }).passed, false);
  assert.equal(evaluateCondition(serial, events, 1200, { until: 1126 }).passed, true);

  // A sensor value that only arrived after the deadline is not evidence.
  const wide = { type: 'sensor_reading', device_id: 'alice', sensor: 'lightLevel', min: 1 };
  assert.equal(evaluateCondition(wide, events, 1200, { until: 1100 }).passed, false);
  const display = { type: 'led_display', device_id: 'alice', layout: HAPPY_LAYOUT };
  assert.equal(evaluateCondition(display, events, 1200, { until: 1100 }).passed, false);
});

test('node distance compares live positions against inclusive bounds', () => {
  const nodePositions = {
    device: new Map([['alice', { x: 10, y: 20 }]]),
    source: new Map([['lamp', { x: 13, y: 24 }]]),
  };
  const condition = {
    type: 'node_distance',
    node_a: { kind: 'device', id: 'alice' },
    node_b: { kind: 'source', id: 'lamp' },
    min: 5,
    max: 5,
  };
  assert.equal(evaluateCondition(condition, [], 1200, { nodePositions }).passed, true);
  assert.equal(evaluateCondition({ ...condition, max: 4.999 }, [], 1200, { nodePositions }).passed, false);
  assert.equal(evaluateCondition({ ...condition, min: 5.001 }, [], 1200, { nodePositions }).passed, false);
  assert.equal(evaluateCondition({ ...condition, min: null }, [], 1200, { nodePositions }).passed, true);

  const missing = evaluateCondition(
    { ...condition, node_b: { kind: 'source', id: 'ghost' } },
    [],
    1200,
    { nodePositions },
  );
  assert.equal(missing.passed, false);
  assert.deepEqual(missing.missingNode, { kind: 'source', id: 'ghost' });

  // Composites propagate the missing endpoint instead of silently passing.
  const none = evaluateCondition({
    type: 'none',
    conditions: [{ ...condition, node_b: { kind: 'device', id: 'ghost' } }],
  }, [], 1200, { nodePositions });
  assert.deepEqual(none.missingNode, { kind: 'device', id: 'ghost' });
});

test('min_count reports evidence count and code-load/reset clear the grader state', () => {
  const grader = createGrader();
  const condition = { type: 'serial_output', device_id: null, match: 'contains', value: 'tick', min_count: 3 };
  grader.record(envelope(1, 1000, { kind: 'serial', device_id: 'alice', text: 'tick 1' }));
  grader.record(envelope(2, 1001, { kind: 'serial', device_id: 'bob', text: 'tick 2' }));
  assert.deepEqual(grader.evaluate(condition, 1001), { passed: false, matchCount: 2 });
  grader.record(envelope(3, 1002, { kind: 'serial', device_id: 'alice', text: 'tick 3' }));
  assert.equal(grader.evaluate(condition, 1002).passed, true);
  grader.record(envelope(4, 1003, { kind: 'code-load', device_id: 'alice' }));
  assert.deepEqual(grader.evaluate(condition, 1003), { passed: false, matchCount: 0 });
  grader.record(envelope(5, 1004, { kind: 'serial', device_id: 'alice', text: 'tick 4' }));
  assert.equal(grader.evaluate(condition, 1004).matchCount, 1);
  grader.reset();
  assert.deepEqual(grader.evaluate(condition, 1004), { passed: false, matchCount: 0 });
});
