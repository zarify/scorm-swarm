import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTestRunner } from '../src/shared/test-runner.js';

const HAPPY_FRAME = [
  0, 0, 0, 0, 0,
  0, 9, 0, 9, 0,
  0, 0, 0, 0, 0,
  9, 0, 0, 0, 9,
  0, 9, 9, 9, 0,
];
const HAPPY_LAYOUT = '.....\n.#.#.\n.....\n#...#\n.###.';

// Deterministic fake clock + bridge: sleep advances the clock, commands are
// recorded with the clock value at dispatch time, handlers may emit feed
// events, and events can be scheduled at a future clock time. With `gated`,
// every sleep parks until the test releases it (for cancellation).
function createHarness({ displays = {}, handlers = {}, gated = false } = {}) {
  const clock = { t: 1000 };
  const state = { displays };
  const commands = [];
  const scheduled = [];
  const releases = [];
  const sleepWaiters = [];
  let listener = null;
  let nextSeq = 0;

  function emit(event, ts = clock.t) {
    if (!listener) return;
    listener({ ts, seq: nextSeq += 1, event });
  }

  function schedule(at, event) {
    scheduled.push({ at, event });
  }

  function drainSchedule() {
    for (let index = scheduled.length - 1; index >= 0; index -= 1) {
      if (scheduled[index].at <= clock.t) {
        const [item] = scheduled.splice(index, 1);
        emit(item.event, item.at);
      }
    }
  }

  const sleep = async (ms) => {
    if (gated) {
      await new Promise((resolve) => {
        releases.push(resolve);
        for (const wake of sleepWaiters.splice(0)) wake();
      });
    }
    clock.t += ms;
    drainSchedule();
  };

  function record(type, payload) {
    commands.push({ type, payload, at: clock.t });
    if (handlers[type]) handlers[type](payload);
  }

  const bridge = {
    onEvent(callback) {
      listener = callback;
      return () => { if (listener === callback) listener = null; };
    },
    pressButton: async (payload) => { record('press-button', payload); },
    radioBroadcast: async (payload) => { record('radio-broadcast', payload); },
    setNodeLevel: async (payload) => { record('set-node-level', payload); },
    addNode: async (payload) => { record('add-node', payload); },
    getDisplay: async () => {
      commands.push({ type: 'get-display', at: clock.t });
      return state.displays;
    },
  };

  return {
    bridge,
    commands,
    clock,
    sleep,
    now: () => clock.t,
    emit,
    schedule,
    setDisplays(next) { state.displays = next; },
    release() { const resolve = releases.shift(); if (resolve) resolve(); },
    async waitForSleep() {
      if (releases.length > 0) return;
      await new Promise((resolve) => sleepWaiters.push(resolve));
    },
  };
}

function pressATest(overrides = {}) {
  return {
    id: 'press-a',
    points: 1,
    trigger: [{ type: 'press_button', device_id: 'alice', button: 'A', count: 1, interval_ms: 0 }],
    steps: overrides.steps ?? [
      { type: 'check', condition: { type: 'serial_output', device_id: 'alice', match: 'contains', value: 'button a', case_sensitive: true, min_count: 1 }, timeout_seconds: 5 },
    ],
    ...overrides,
  };
}

test('repeated trigger actions fire count times with interval between fires', async () => {
  const h = createHarness();
  const runner = createTestRunner({
    testCases: [pressATest({
      trigger: [{ type: 'press_button', device_id: 'alice', button: 'A', count: 3, interval_ms: 200 }],
      steps: [{ type: 'check', condition: { type: 'serial_output', device_id: 'alice', match: 'contains', value: 'button a' }, timeout_seconds: 0 }],
    })],
    bridge: h.bridge,
    sleep: h.sleep,
    now: h.now,
  });
  const outcome = await runner.runAll();
  const presses = h.commands.filter((command) => command.type === 'press-button');
  assert.deepEqual(presses.map((press) => press.at), [1000, 1200, 1400]);
  assert.deepEqual(presses.map((press) => press.payload), [
    { device_id: 'alice', button: 'A' },
    { device_id: 'alice', button: 'A' },
    { device_id: 'alice', button: 'A' },
  ]);
  assert.equal(outcome.results[0].passed, false);
  assert.equal(outcome.results[0].detail, 'step 1 timed out after 0s');
});

test('radio broadcast commands carry UTF-8 base64 payload, channel, and group', async () => {
  const h = createHarness();
  const runner = createTestRunner({
    testCases: [pressATest({
      trigger: [{ type: 'radio_broadcast', device_id: 'alice', channel: null, group: 42, payload: 'héllo', count: 1, interval_ms: 0 }],
      steps: [{ type: 'check', condition: { type: 'serial_output', device_id: null, match: 'contains', value: 'never' }, timeout_seconds: 0 }],
    })],
    bridge: h.bridge,
    sleep: h.sleep,
    now: h.now,
  });
  await runner.runAll();
  assert.deepEqual(h.commands.find((command) => command.type === 'radio-broadcast').payload, {
    device_id: 'alice',
    payload_b64: Buffer.from('héllo', 'utf8').toString('base64'),
    channel: null,
    group: 42,
  });
});

test('set_node_level and add_node wire through to bridge payloads', async () => {
  const h = createHarness();
  const runner = createTestRunner({
    testCases: [pressATest({
      trigger: [
        { type: 'set_node_level', node_id: 'lamp', value: 8 },
        { type: 'add_node', node_type: 'temperature', x: 3, y: 4, level: null, duration_seconds: 5 },
      ],
      steps: [{ type: 'check', condition: { type: 'serial_output', device_id: null, match: 'contains', value: 'never' }, timeout_seconds: 0 }],
    })],
    bridge: h.bridge,
    sleep: h.sleep,
    now: h.now,
  });
  await runner.runAll();
  assert.deepEqual(h.commands.find((command) => command.type === 'set-node-level').payload, { node_id: 'lamp', value: 8 });
  assert.deepEqual(h.commands.find((command) => command.type === 'add-node').payload, {
    node_type: 'temperature', x: 3, y: 4, level: null, duration_seconds: 5,
  });
});

test('a passing chain scores points; the first failing step stops the chain', async () => {
  const h = createHarness({
    handlers: {
      'press-button': (payload) => {
        if (payload.device_id === 'alice' && payload.button === 'A') {
          h.emit({ kind: 'serial', device_id: 'alice', text: 'button a' });
        }
      },
    },
  });
  const runner = createTestRunner({
    testCases: [
      pressATest({ points: 2 }),
      pressATest({
        id: 'never',
        points: 3,
        steps: [
          { type: 'check', condition: { type: 'serial_output', device_id: 'alice', match: 'contains', value: 'nope' }, timeout_seconds: 0 },
          { type: 'check', condition: { type: 'serial_output', device_id: 'alice', match: 'contains', value: 'button a' }, timeout_seconds: 0 },
        ],
      }),
    ],
    bridge: h.bridge,
    sleep: h.sleep,
    now: h.now,
  });
  const progress = [];
  const outcome = await runner.runAll({ onProgress: (update) => progress.push(update) });
  assert.deepEqual(outcome.results[0], {
    id: 'press-a', passed: true, failedStepIndex: null, detail: 'passed', points: 2,
  });
  assert.deepEqual(outcome.results[1], {
    id: 'never', passed: false, failedStepIndex: 0, detail: 'step 1 timed out after 0s', points: 3,
  });
  // One trigger press per test: the failing first check stops each chain.
  assert.equal(h.commands.filter((command) => command.type === 'press-button').length, 2);
  assert.equal(outcome.earnedPoints, 2);
  assert.equal(outcome.totalPoints, 5);
  assert.equal(outcome.score, 40);
  assert.deepEqual(progress.map((update) => `${update.id}:${update.status}`), [
    'press-a:running', 'press-a:passed', 'never:running', 'never:failed',
  ]);
});

test('a response emitted during a multi-fire trigger is visible to the first check', async () => {
  let fires = 0;
  const h = createHarness({
    handlers: {
      'press-button': () => {
        fires += 1;
        // The response arrives between fire 1 and fire 2.
        if (fires === 1) h.schedule(1100, { kind: 'serial', device_id: 'bob', text: 'pong' });
      },
    },
  });
  const runner = createTestRunner({
    testCases: [pressATest({
      trigger: [{ type: 'press_button', device_id: 'alice', button: 'A', count: 2, interval_ms: 200 }],
      steps: [{ type: 'check', condition: { type: 'serial_output', device_id: 'bob', match: 'contains', value: 'pong', min_count: 1 }, timeout_seconds: 0 }],
    })],
    bridge: h.bridge,
    sleep: h.sleep,
    now: h.now,
  });
  const outcome = await runner.runAll();
  assert.equal(outcome.results[0].passed, true);
});

test('a static display is visible to a check the moment the step starts', async () => {
  const h = createHarness({ displays: { alice: HAPPY_FRAME } });
  const runner = createTestRunner({
    testCases: [pressATest({
      steps: [{ type: 'check', condition: { type: 'led_display', device_id: 'alice', layout: HAPPY_LAYOUT }, timeout_seconds: 0 }],
    })],
    bridge: h.bridge,
    sleep: h.sleep,
    now: h.now,
  });
  const outcome = await runner.runAll();
  assert.equal(outcome.results[0].passed, true);
  assert.equal(h.commands.filter((command) => command.type === 'get-display').length, 1);
});

test('display changes during a check are picked up on later polls', async () => {
  const h = createHarness({ displays: { alice: new Array(25).fill(0) } });
  const sleep = async (ms) => {
    await h.sleep(ms);
    if (h.clock.t >= 1200) h.setDisplays({ alice: HAPPY_FRAME });
  };
  const runner = createTestRunner({
    testCases: [pressATest({
      steps: [{ type: 'check', condition: { type: 'led_display', device_id: 'alice', layout: HAPPY_LAYOUT }, timeout_seconds: 0.6 }],
    })],
    bridge: h.bridge,
    sleep,
    now: h.now,
  });
  const outcome = await runner.runAll();
  assert.equal(outcome.results[0].passed, true);
  assert.equal(h.commands.filter((command) => command.type === 'get-display').length, 2);
});

test('getDisplay failures act as empty displays and warn only once', async () => {
  const warnings = [];
  const h = createHarness();
  const failingBridge = {
    ...h.bridge,
    getDisplay: async () => { throw new Error('gone'); },
  };
  const runner = createTestRunner({
    testCases: [
      pressATest({
        steps: [{ type: 'check', condition: { type: 'led_display', device_id: 'alice', layout: HAPPY_LAYOUT }, timeout_seconds: 0.4 }],
      }),
      pressATest({
        id: 'second',
        steps: [{ type: 'check', condition: { type: 'led_display', device_id: 'alice', layout: HAPPY_LAYOUT }, timeout_seconds: 0.4 }],
      }),
    ],
    bridge: failingBridge,
    sleep: h.sleep,
    now: h.now,
    onEvent: (event) => { if (event.kind === 'runner-warning') warnings.push(event); },
  });
  const outcome = await runner.runAll();
  assert.deepEqual(outcome.results.map((result) => result.passed), [false, false]);
  assert.equal(warnings.length, 1);
});

test('checks are order-sensitive: evidence before the previous check resolve time is excluded', async () => {
  let fired = 0;
  const h = createHarness({
    handlers: {
      'press-button': () => {
        fired += 1;
        if (fired === 1) h.emit({ kind: 'serial', device_id: 'alice', text: 'ready' });
        if (fired === 2) h.emit({ kind: 'serial', device_id: 'alice', text: 'done' });
      },
    },
  });
  // "ready" arrives at 1000 (fire 1); check 1 resolves there; "done" arrives at
  // 1300 (fire 2), after check 1's resolve time, so check 2 sees it.
  const passRunner = createTestRunner({
    testCases: [pressATest({
      trigger: [{ type: 'press_button', device_id: 'alice', button: 'A', count: 2, interval_ms: 300 }],
      steps: [
        { type: 'check', condition: { type: 'serial_output', device_id: 'alice', match: 'exact', value: 'ready', min_count: 1 }, timeout_seconds: 2 },
        { type: 'check', condition: { type: 'serial_output', device_id: 'alice', match: 'exact', value: 'done', min_count: 1 }, timeout_seconds: 2 },
      ],
    })],
    bridge: h.bridge,
    sleep: h.sleep,
    now: h.now,
  });
  const passOutcome = await passRunner.runAll();
  assert.equal(passOutcome.results[0].passed, true);

  // Reverse the serial order: "done" arrives before "ready". Check 1 waits for
  // "ready" (fires at 1300); check 2 then looks for "done", but the only
  // "done" predates check 1's resolve time.
  fired = 0;
  const h2 = createHarness({
    handlers: {
      'press-button': () => {
        fired += 1;
        if (fired === 1) h2.emit({ kind: 'serial', device_id: 'alice', text: 'done' });
        if (fired === 2) h2.emit({ kind: 'serial', device_id: 'alice', text: 'ready' });
      },
    },
  });
  const failRunner = createTestRunner({
    testCases: [pressATest({
      trigger: [{ type: 'press_button', device_id: 'alice', button: 'A', count: 2, interval_ms: 300 }],
      steps: [
        { type: 'check', condition: { type: 'serial_output', device_id: 'alice', match: 'exact', value: 'ready', min_count: 1 }, timeout_seconds: 2 },
        { type: 'check', condition: { type: 'serial_output', device_id: 'alice', match: 'exact', value: 'done', min_count: 1 }, timeout_seconds: 0.4 },
      ],
    })],
    bridge: h2.bridge,
    sleep: h2.sleep,
    now: h2.now,
  });
  const failOutcome = await failRunner.runAll();
  assert.equal(failOutcome.results[0].passed, false);
  assert.equal(failOutcome.results[0].failedStepIndex, 1);
  assert.equal(failOutcome.results[0].detail, 'step 2 timed out after 0.4s');
});

test('an action step executes mid-chain and its evidence is checkable immediately after', async () => {
  const h = createHarness({
    handlers: {
      'press-button': (payload) => {
        if (payload.button === 'B') h.emit({ kind: 'serial', device_id: 'alice', text: 'b pressed' });
      },
    },
  });
  const runner = createTestRunner({
    testCases: [pressATest({
      trigger: [{ type: 'press_button', device_id: 'alice', button: 'A', count: 1, interval_ms: 0 }],
      steps: [
        { type: 'action', action: { type: 'press_button', device_id: 'alice', button: 'B', count: 1, interval_ms: 0 } },
        { type: 'check', condition: { type: 'serial_output', device_id: 'alice', match: 'contains', value: 'b pressed', min_count: 1 }, timeout_seconds: 0.2 },
      ],
    })],
    bridge: h.bridge,
    sleep: h.sleep,
    now: h.now,
  });
  const outcome = await runner.runAll();
  assert.equal(outcome.results[0].passed, true);
  assert.deepEqual(
    h.commands.filter((command) => command.type === 'press-button').map((command) => command.payload.button),
    ['A', 'B'],
  );
});

test('cancel resolves the run with cancelled details and no score', async () => {
  const h = createHarness({ gated: true });
  const runner = createTestRunner({
    testCases: [pressATest(), pressATest({ id: 'second' })],
    bridge: h.bridge,
    sleep: h.sleep,
    now: h.now,
  });
  const runPromise = runner.runAll();
  await h.waitForSleep();
  runner.cancel();
  h.release();
  const outcome = await runPromise;
  assert.deepEqual(outcome, {
    results: [
      { id: 'press-a', passed: false, failedStepIndex: null, detail: 'cancelled', points: 1 },
      { id: 'second', passed: false, failedStepIndex: null, detail: 'cancelled', points: 1 },
    ],
    earnedPoints: 0,
    totalPoints: 2,
  });
  assert.equal(Object.hasOwn(outcome, 'score'), false);
});

test('a cancelled run leaves the next runAll usable', async () => {
  let emitSerial = false;
  const h = createHarness({
    gated: true,
    handlers: {
      'press-button': () => {
        if (emitSerial) h.emit({ kind: 'serial', device_id: 'alice', text: 'button a' });
      },
    },
  });
  const runner = createTestRunner({
    testCases: [pressATest()],
    bridge: h.bridge,
    sleep: h.sleep,
    now: h.now,
  });
  const runPromise = runner.runAll();
  await h.waitForSleep();
  runner.cancel();
  h.release();
  await runPromise;

  emitSerial = true;
  const outcome = await runner.runAll();
  assert.equal(outcome.results[0].passed, true);
  assert.equal(outcome.score, 100);
});

test('bridge command failures reject runAll', async () => {
  const h = createHarness();
  const failingBridge = {
    ...h.bridge,
    pressButton: async () => { throw new Error('bridge dead'); },
  };
  const runner = createTestRunner({
    testCases: [pressATest()],
    bridge: failingBridge,
    sleep: h.sleep,
    now: h.now,
  });
  await assert.rejects(() => runner.runAll(), /bridge dead/);
});
