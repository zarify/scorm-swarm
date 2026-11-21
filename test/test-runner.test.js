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
// State reads model a real bridge: `displayLatencyMs`/`positionLatencyMs` are
// the reply time (Infinity = the bridge never answers in time and the request
// is rejected), and an abort rejects immediately.
function createHarness({
  displays = {},
  devicePositions = {},
  sourcePositions = {},
  handlers = {},
  gated = false,
  displayLatencyMs = 0,
  positionLatencyMs = 0,
  hangStateReads = false,
} = {}) {
  const clock = { t: 1000 };
  const state = {
    displays,
    device: new Map(Object.entries(devicePositions)),
    source: new Map(Object.entries(sourcePositions)),
  };
  const commands = [];
  const scheduled = [];
  const releases = [];
  const sleepWaiters = [];
  const stateRequests = [];
  const requestWaiters = [];
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

  function settleStateRequests() {
    for (let index = stateRequests.length - 1; index >= 0; index -= 1) {
      const request = stateRequests[index];
      if (request.replyAt <= clock.t) {
        stateRequests.splice(index, 1);
        request.resolve(request.produce());
      } else if (request.deadline <= clock.t) {
        stateRequests.splice(index, 1);
        request.reject(new Error(`${request.kind} timed out`));
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
    settleStateRequests();
  };

  function record(type, payload) {
    commands.push({ type, payload, at: clock.t });
    if (handlers[type]) handlers[type](payload);
  }

  function stateRequest(kind, options, produce) {
    const timeoutMs = options && Number.isFinite(options.timeoutMs) ? options.timeoutMs : Infinity;
    const latency = kind === 'positions' ? positionLatencyMs : displayLatencyMs;
    const request = {
      kind,
      produce,
      deadline: clock.t + timeoutMs,
      replyAt: hangStateReads ? Infinity : clock.t + latency,
    };
    return new Promise((resolve, reject) => {
      request.resolve = resolve;
      request.reject = reject;
      if (hangStateReads) {
        options?.signal?.addEventListener('abort', () => {
          const index = stateRequests.indexOf(request);
          if (index !== -1) stateRequests.splice(index, 1);
          reject(new Error(`${kind} aborted`));
        }, { once: true });
        // The real bridge owns the timer for its own requests; emulate that
        // deadline on the fake clock so the runner cannot await forever.
        if (Number.isFinite(request.deadline)) {
          setTimeout(() => {
            const index = stateRequests.indexOf(request);
            if (index === -1) return;
            stateRequests.splice(index, 1);
            if (clock.t < request.deadline) {
              clock.t = request.deadline;
              drainSchedule();
            }
            reject(new Error(`${kind} timed out`));
            settleStateRequests();
          }, 0);
        }
      }
      stateRequests.push(request);
      for (const wake of requestWaiters.splice(0)) wake();
      if (request.replyAt <= clock.t) {
        stateRequests.splice(stateRequests.indexOf(request), 1);
        resolve(produce());
      }
    });
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
    moveNode: async (payload) => {
      record('move-node', payload);
      const target = state.source.has(payload.node_id) ? state.source : state.device;
      if (target.has(payload.node_id)) target.set(payload.node_id, { x: payload.x, y: payload.y });
    },
    getDisplay: async (options) => {
      commands.push({ type: 'get-display', at: clock.t });
      return stateRequest('display', options, () => state.displays);
    },
    getNodePositions: async (nodes, options) => {
      commands.push({ type: 'get-node-positions', payload: nodes, at: clock.t });
      return stateRequest('positions', options, () => nodes.flatMap((node) => {
        const position = (node.kind === 'device' ? state.device : state.source).get(node.id);
        return position ? [{ kind: node.kind, id: node.id, x: position.x, y: position.y }] : [];
      }));
    },
  };

  return {
    bridge,
    commands,
    clock,
    state,
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
    async waitForStateRequest() {
      if (stateRequests.length > 0) return;
      await new Promise((resolve) => requestWaiters.push(resolve));
    },
  };
}

function checkStep(condition, timeoutMs = 0) {
  return { type: 'check', condition, timeout_ms: timeoutMs };
}

function serialCheck(value, timeoutMs = 0, extra = {}) {
  return checkStep(
    { type: 'serial_output', device_id: 'alice', match: 'contains', value, ...extra },
    timeoutMs,
  );
}

function pressATest(overrides = {}) {
  return {
    id: 'press-a',
    points: 1,
    trigger: [{ type: 'press_button', device_id: 'alice', button: 'A', count: 1, interval_ms: 0 }],
    steps: overrides.steps ?? [serialCheck('button a', 5000)],
    ...overrides,
  };
}

function makeRunner(h, testCases) {
  return createTestRunner({ testCases, bridge: h.bridge, sleep: h.sleep, now: h.now });
}

test('repeated trigger actions fire count times with interval between fires', async () => {
  const h = createHarness();
  const runner = makeRunner(h, [pressATest({
    trigger: [{ type: 'press_button', device_id: 'alice', button: 'A', count: 3, interval_ms: 200 }],
    steps: [serialCheck('button a', 0)],
  })]);
  const outcome = await runner.runAll();
  const presses = h.commands.filter((command) => command.type === 'press-button');
  assert.deepEqual(presses.map((press) => press.at), [1000, 1200, 1400]);
  assert.deepEqual(presses.map((press) => press.payload), [
    { device_id: 'alice', button: 'A' },
    { device_id: 'alice', button: 'A' },
    { device_id: 'alice', button: 'A' },
  ]);
  assert.equal(outcome.results[0].passed, false);
  assert.equal(outcome.results[0].detail, 'Condition not met.');
});

test('radio broadcast commands carry UTF-8 base64 payload, channel, and group', async () => {
  const h = createHarness();
  const runner = makeRunner(h, [pressATest({
    trigger: [{ type: 'radio_broadcast', device_id: 'alice', channel: null, group: 42, payload: 'héllo', count: 1, interval_ms: 0 }],
    steps: [serialCheck('never', 0)],
  })]);
  await runner.runAll();
  assert.deepEqual(h.commands.find((command) => command.type === 'radio-broadcast').payload, {
    device_id: 'alice',
    payload_b64: Buffer.from('héllo', 'utf8').toString('base64'),
    channel: null,
    group: 42,
  });
});

test('set_node_level, add_node and move_node wire through to bridge payloads', async () => {
  const h = createHarness();
  const runner = makeRunner(h, [pressATest({
    trigger: [
      { type: 'set_node_level', node_id: 'lamp', value: 8 },
      { type: 'add_node', node_type: 'temperature', x: 3, y: 4, level: null, duration_seconds: 5 },
      { type: 'move_node', node_id: 'lamp', x: 103, y: 104 },
    ],
    steps: [serialCheck('never', 0)],
  })]);
  await runner.runAll();
  assert.deepEqual(h.commands.find((command) => command.type === 'set-node-level').payload, { node_id: 'lamp', value: 8 });
  assert.deepEqual(h.commands.find((command) => command.type === 'add-node').payload, {
    node_type: 'temperature', x: 3, y: 4, level: null, duration_seconds: 5,
  });
  assert.deepEqual(h.commands.find((command) => command.type === 'move-node').payload, {
    node_id: 'lamp', x: 103, y: 104,
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
  const runner = makeRunner(h, [
    pressATest({ points: 2 }),
    pressATest({
      id: 'never',
      points: 3,
      steps: [
        serialCheck('nope', 0),
        serialCheck('button a', 0),
      ],
    }),
  ]);
  const progress = [];
  const outcome = await runner.runAll({ onProgress: (update) => progress.push(update) });
  assert.deepEqual(outcome.results[0], {
    id: 'press-a', passed: true, failedStepIndex: null, detail: 'passed', points: 2,
  });
  assert.deepEqual(outcome.results[1], {
    id: 'never', passed: false, failedStepIndex: 0, detail: 'Condition not met.', points: 3,
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
  const runner = makeRunner(h, [pressATest({
    trigger: [{ type: 'press_button', device_id: 'alice', button: 'A', count: 2, interval_ms: 200 }],
    steps: [checkStep({ type: 'serial_output', device_id: 'bob', match: 'contains', value: 'pong' }, 0)],
  })]);
  const outcome = await runner.runAll();
  assert.equal(outcome.results[0].passed, true);
});

test('a static display is visible to a check the moment the step starts', async () => {
  const h = createHarness({ displays: { alice: HAPPY_FRAME } });
  const runner = makeRunner(h, [pressATest({
    steps: [checkStep({ type: 'led_display', device_id: 'alice', layout: HAPPY_LAYOUT }, 0)],
  })]);
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
      steps: [checkStep({ type: 'led_display', device_id: 'alice', layout: HAPPY_LAYOUT }, 600)],
    })],
    bridge: h.bridge,
    sleep,
    now: h.now,
  });
  const outcome = await runner.runAll();
  assert.equal(outcome.results[0].passed, true);
  // State-dependent pacing sleeps min(200, floor(600 / 4)) = 150 ms, so the
  // frame that lands at 1200 ms is first seen by the poll at 1300 ms.
  assert.equal(h.commands.filter((command) => command.type === 'get-display').length, 3);
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
        steps: [checkStep({ type: 'led_display', device_id: 'alice', layout: HAPPY_LAYOUT }, 400)],
      }),
      pressATest({
        id: 'second',
        steps: [checkStep({ type: 'led_display', device_id: 'alice', layout: HAPPY_LAYOUT }, 400)],
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
  const passRunner = makeRunner(h, [pressATest({
    trigger: [{ type: 'press_button', device_id: 'alice', button: 'A', count: 2, interval_ms: 300 }],
    steps: [
      checkStep({ type: 'serial_output', device_id: 'alice', match: 'exact', value: 'ready' }, 2000),
      checkStep({ type: 'serial_output', device_id: 'alice', match: 'exact', value: 'done' }, 2000),
    ],
  })]);
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
  const failRunner = makeRunner(h2, [pressATest({
    trigger: [{ type: 'press_button', device_id: 'alice', button: 'A', count: 2, interval_ms: 300 }],
    steps: [
      checkStep({ type: 'serial_output', device_id: 'alice', match: 'exact', value: 'ready' }, 2000),
      checkStep({ type: 'serial_output', device_id: 'alice', match: 'exact', value: 'done' }, 400),
    ],
  })]);
  const failOutcome = await failRunner.runAll();
  assert.equal(failOutcome.results[0].passed, false);
  assert.equal(failOutcome.results[0].failedStepIndex, 1);
  assert.equal(failOutcome.results[0].detail, 'Test timed out.');
  assert.doesNotMatch(failOutcome.results[0].detail, /Step 2|\bms\b/);
});

test('an action step executes mid-chain and its evidence is checkable immediately after', async () => {
  const h = createHarness({
    handlers: {
      'press-button': (payload) => {
        if (payload.button === 'B') h.emit({ kind: 'serial', device_id: 'alice', text: 'b pressed' });
      },
    },
  });
  const runner = makeRunner(h, [pressATest({
    steps: [
      { type: 'action', action: { type: 'press_button', device_id: 'alice', button: 'B', count: 1, interval_ms: 0 } },
      serialCheck('b pressed', 200),
    ],
  })]);
  const outcome = await runner.runAll();
  assert.equal(outcome.results[0].passed, true);
  assert.deepEqual(
    h.commands.filter((command) => command.type === 'press-button').map((command) => command.payload.button),
    ['A', 'B'],
  );
});

test('cancel resolves the run with cancelled details and no score', async () => {
  const h = createHarness({ gated: true });
  const runner = makeRunner(h, [pressATest(), pressATest({ id: 'second' })]);
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

test('cancelling during a state request produces no score', async () => {
  const h = createHarness({ hangStateReads: true });
  const runner = makeRunner(h, [pressATest({
    steps: [checkStep({ type: 'led_display', device_id: 'alice', layout: HAPPY_LAYOUT }, 5000)],
  })]);
  const runPromise = runner.runAll();
  await h.waitForStateRequest();
  runner.cancel();
  const outcome = await runPromise;
  assert.equal(Object.hasOwn(outcome, 'score'), false);
  assert.equal(outcome.results[0].detail, 'cancelled');
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
  const runner = makeRunner(h, [pressATest()]);
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

test('a rejected trigger action fails that test before any check runs', async () => {
  const h = createHarness();
  const failingBridge = {
    ...h.bridge,
    pressButton: async (payload) => {
      if (payload.device_id === 'ghost') throw new Error('Unknown device: ghost');
      h.bridge.pressButton(payload);
    },
  };
  const runner = createTestRunner({
    testCases: [pressATest({
      trigger: [
        { type: 'press_button', device_id: 'alice', button: 'A', count: 1, interval_ms: 0 },
        { type: 'press_button', device_id: 'ghost', button: 'A', count: 1, interval_ms: 0 },
      ],
      steps: [serialCheck('button a', 0)],
    })],
    bridge: failingBridge,
    sleep: h.sleep,
    now: h.now,
  });
  const outcome = await runner.runAll();
  assert.deepEqual(outcome.results[0], {
    id: 'press-a',
    passed: false,
    failedStepIndex: null,
    detail: 'Trigger action 2 failed: Unknown device: ghost',
    points: 1,
  });
  assert.equal(h.commands.filter((command) => command.type === 'get-display').length, 0);
});

test('a rejected flow action names its step, skips the rest of the test, and later tests still score', async () => {
  const h = createHarness({
    handlers: {
      'press-button': () => h.emit({ kind: 'serial', device_id: 'alice', text: 'button a' }),
    },
  });
  const failing = {
    ...h.bridge,
    moveNode: async () => { throw new Error('Unknown environment node: lamp'); },
  };
  const runner = createTestRunner({
    testCases: [
      {
        id: 'mover',
        points: 2,
        trigger: [{ type: 'press_button', device_id: 'alice', button: 'A', count: 1, interval_ms: 0 }],
        steps: [
          serialCheck('button a', 0),
          { type: 'action', action: { type: 'move_node', node_id: 'lamp', x: 1, y: 2 } },
          serialCheck('never', 0),
        ],
      },
      pressATest({ id: 'later', points: 3 }),
    ],
    bridge: failing,
    sleep: h.sleep,
    now: h.now,
  });
  const outcome = await runner.runAll();
  assert.deepEqual(outcome.results[0], {
    id: 'mover',
    passed: false,
    failedStepIndex: 1,
    detail: 'Step 2 action failed: Unknown environment node: lamp',
    points: 2,
  });
  assert.equal(outcome.results[1].passed, true);
  assert.equal(outcome.score, 60);
});

test('an event after the deadline cannot satisfy a check, an earlier one can', async () => {
  const h = createHarness();
  const runner = makeRunner(h, [pressATest({
    trigger: [],
    steps: [serialCheck('late', 125)],
  })]);
  h.schedule(1126, { kind: 'serial', device_id: 'alice', text: 'late' });
  const outcome = await runner.runAll();
  assert.equal(outcome.results[0].passed, false);
  assert.equal(outcome.results[0].detail, 'Test timed out.');

  const h2 = createHarness();
  h2.schedule(1124, { kind: 'serial', device_id: 'alice', text: 'late' });
  const passing = await makeRunner(h2, [pressATest({
    trigger: [],
    steps: [serialCheck('late', 125)],
  })]).runAll();
  assert.equal(passing.results[0].passed, true);
});

test('a zero timeout evaluates once and never polls displays', async () => {
  const h = createHarness();
  h.schedule(1050, { kind: 'serial', device_id: 'alice', text: 'later' });
  const outcome = await makeRunner(h, [pressATest({
    trigger: [],
    steps: [serialCheck('later', 0)],
  })]).runAll();
  assert.equal(outcome.results[0].passed, false);
  assert.equal(h.commands.filter((command) => command.type === 'get-display').length, 0);
  assert.equal(h.commands.filter((command) => command.type === 'get-node-positions').length, 0);
});

test('a missing display reply ends the check instead of hanging', async () => {
  const h = createHarness({ hangStateReads: true });
  const outcome = await makeRunner(h, [pressATest({
    trigger: [],
    steps: [checkStep({ type: 'led_display', device_id: 'alice', layout: HAPPY_LAYOUT }, 300)],
  })]).runAll();
  assert.equal(outcome.results[0].passed, false);
  assert.equal(outcome.results[0].detail, 'Test timed out.');
});

test('a missing position reply times out instead of claiming an unknown node', async () => {
  const h = createHarness({ hangStateReads: true });
  const outcome = await makeRunner(h, [pressATest({
    trigger: [],
    steps: [checkStep({
      type: 'node_distance',
      node_a: { kind: 'source', id: 'light-1' },
      node_b: { kind: 'source', id: 'light-2' },
      min: null,
      max: 5,
    }, 300)],
  })]).runAll();
  assert.equal(outcome.results[0].passed, false);
  assert.equal(outcome.results[0].detail, 'Test timed out.');
});

test('a zero-timeout distance check reads the position an acknowledged move produced', async () => {
  const h = createHarness({
    sourcePositions: { 'light-1': { x: 0, y: 0 }, 'light-2': { x: 110, y: 104 } },
  });
  const runner = makeRunner(h, [pressATest({
    trigger: [{ type: 'move_node', node_id: 'light-1', x: 105, y: 104 }],
    steps: [checkStep({
      type: 'node_distance',
      node_a: { kind: 'source', id: 'light-1' },
      node_b: { kind: 'source', id: 'light-2' },
      min: 5,
      max: 5,
    }, 0)],
  })]);
  const outcome = await runner.runAll();
  assert.equal(outcome.results[0].passed, true);
  assert.deepEqual(h.commands.filter((command) => command.type === 'get-node-positions')[0].payload, [
    { kind: 'source', id: 'light-1' },
    { kind: 'source', id: 'light-2' },
  ]);
});

test('distance checks use an exact 3-4-5 boundary and never round the comparison', async () => {
  const h = createHarness({
    devicePositions: { alice: { x: 10, y: 20 } },
    sourcePositions: { lamp: { x: 13, y: 24 } },
  });
  const condition = {
    type: 'node_distance',
    node_a: { kind: 'device', id: 'alice' },
    node_b: { kind: 'source', id: 'lamp' },
    min: 5,
    max: 5,
  };
  const exact = await makeRunner(h, [pressATest({ trigger: [], steps: [checkStep(condition, 0)] })]).runAll();
  assert.equal(exact.results[0].passed, true);

  const h2 = createHarness({
    devicePositions: { alice: { x: 10, y: 20 } },
    sourcePositions: { lamp: { x: 13, y: 24 } },
  });
  const below = await makeRunner(h2, [pressATest({
    trigger: [],
    steps: [checkStep({ ...condition, min: null, max: 4.999 }, 0)],
  })]).runAll();
  assert.equal(below.results[0].passed, false);
});

test('an unknown distance endpoint fails a none composite instead of passing it', async () => {
  const h = createHarness({
    sourcePositions: { 'light-1': { x: 0, y: 0 } },
  });
  const outcome = await makeRunner(h, [pressATest({
    trigger: [],
    steps: [checkStep({
      type: 'none',
      conditions: [
        {
          type: 'node_distance',
          node_a: { kind: 'source', id: 'light-1' },
          node_b: { kind: 'source', id: 'ghost' },
          min: null,
          max: 5,
        },
      ],
    }, 100)],
  })]).runAll();
  assert.equal(outcome.results[0].passed, false);
  assert.equal(outcome.results[0].detail, 'Step 1 cannot check distance: unknown source ghost.');
  assert.equal(outcome.results[0].failedStepIndex, 0);
});
