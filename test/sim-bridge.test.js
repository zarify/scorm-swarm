import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { connectSimBridge, SimBridgeError } from '../src/shared/sim-bridge.js';

const ORIGIN = 'https://lms.example';
const previousWindow = globalThis.window;

/**
 * Minimal window/iframe pair: the bridge only needs message listener plumbing
 * and a postMessage target, so replies are delivered by hand.
 */
function createHarness() {
  const listeners = new Set();
  const sent = [];
  const frameWindow = {
    postMessage(message) {
      sent.push(message);
    },
  };
  const windowStub = {
    addEventListener(type, listener) {
      if (type === 'message') listeners.add(listener);
    },
    removeEventListener(type, listener) {
      if (type === 'message') listeners.delete(listener);
    },
  };
  return {
    frameWindow,
    sent,
    listenerCount: () => listeners.size,
    reply(data) {
      for (const listener of [...listeners]) {
        listener({ source: frameWindow, origin: ORIGIN, data });
      }
    },
    install() {
      globalThis.window = windowStub;
    },
  };
}

async function createConnectedBridge() {
  const harness = createHarness();
  harness.install();
  const bridge = connectSimBridge(harness.frameWindow, ORIGIN);
  harness.reply({ source: 'swarm-sim-bridge', v: 1, type: 'ready', payload: {} });
  await bridge.ready;
  await flush();
  harness.sent.length = 0;
  return { harness, bridge };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

after(() => {
  globalThis.window = previousWindow;
});

test('a request without a reply rejects at its own deadline', async () => {
  const { bridge, harness } = await createConnectedBridge();
  const started = Date.now();
  await assert.rejects(
    () => bridge.getDisplay({ timeoutMs: 30 }),
    (error) => error instanceof SimBridgeError && /did not answer get-display within 30 ms/.test(error.message),
  );
  assert.ok(Date.now() - started >= 25, 'the deadline was actually waited out');
  assert.equal(harness.sent[0].type, 'get-display');
  assert.match(harness.sent[0].id, /^swarm-/);
  bridge.close();
});

test('a late reply is ignored and the next request still works', async () => {
  const { bridge, harness } = await createConnectedBridge();
  await assert.rejects(() => bridge.getDisplay({ timeoutMs: 20 }));
  const firstId = harness.sent[0].id;
  // The simulator answers after the caller gave up.
  harness.reply({ source: 'swarm-sim-bridge', v: 1, type: 'display', id: firstId, payload: { displays: {} } });

  const pending = bridge.getBundle({ timeoutMs: 200 });
  await flush();
  const bundleMessage = harness.sent.at(-1);
  harness.reply({
    source: 'swarm-sim-bridge',
    v: 1,
    type: 'bundle',
    id: bundleMessage.id,
    payload: 'U1dBUk0=',
  });
  assert.equal(await pending, 'U1dBUk0=');
  bridge.close();
});

test('a mismatched response type does not clear a live request', async () => {
  const { bridge, harness } = await createConnectedBridge();
  const pending = bridge.getDisplay({ timeoutMs: 500 });
  await flush();
  const { id } = harness.sent[0];
  // A stray ack for this id must not resolve or destroy the display request.
  harness.reply({ source: 'swarm-sim-bridge', v: 1, type: 'ack', id, payload: {} });
  harness.reply({ source: 'swarm-sim-bridge', v: 1, type: 'display', id, payload: { displays: { alice: [1] } } });
  assert.deepEqual(await pending, { alice: [1] });
  bridge.close();
});

test('an aborted request rejects immediately with the abort reason', async () => {
  const { bridge } = await createConnectedBridge();
  const controller = new AbortController();
  const pending = bridge.getDisplay({ timeoutMs: 5_000, signal: controller.signal });
  controller.abort(new Error('run cancelled'));
  await assert.rejects(() => pending, /run cancelled/);
  bridge.close();
});

test('scripted actions wait for their acknowledgement', async () => {
  const { bridge, harness } = await createConnectedBridge();
  const pending = bridge.moveNode({ node_id: 'light-1', x: 103, y: 104 }, { timeoutMs: 500 });
  await flush();
  const message = harness.sent[0];
  assert.equal(message.type, 'move-node');
  assert.deepEqual(message.payload, { node_id: 'light-1', x: 103, y: 104 });
  harness.reply({ source: 'swarm-sim-bridge', v: 1, type: 'ack', id: message.id, payload: {} });
  assert.equal(await pending, true);

  const rejected = bridge.pressButton({ device_id: 'ghost', button: 'A' }, { timeoutMs: 500 });
  await flush();
  const second = harness.sent[1];
  harness.reply({
    source: 'swarm-sim-bridge',
    v: 1,
    type: 'error',
    id: second.id,
    payload: { message: 'Unknown device: ghost' },
  });
  await assert.rejects(() => rejected, /Unknown device: ghost/);
  bridge.close();
});

test('node position requests carry the pairs and return the reported rows', async () => {
  const { bridge, harness } = await createConnectedBridge();
  const nodes = [{ kind: 'source', id: 'light-1' }, { kind: 'device', id: 'alice' }];
  const pending = bridge.getNodePositions(nodes, { timeoutMs: 500 });
  await flush();
  const message = harness.sent[0];
  assert.deepEqual(message.payload, { nodes });
  harness.reply({
    source: 'swarm-sim-bridge',
    v: 1,
    type: 'node-positions',
    id: message.id,
    payload: { positions: [{ kind: 'source', id: 'light-1', x: 103, y: 104 }] },
  });
  assert.deepEqual(await pending, [{ kind: 'source', id: 'light-1', x: 103, y: 104 }]);
  bridge.close();
});

test('close rejects every pending request and stops listening', async () => {
  const { bridge, harness } = await createConnectedBridge();
  const pending = bridge.getDisplay({ timeoutMs: 5_000 });
  await flush();
  bridge.close();
  await assert.rejects(() => pending, /closed before responding/);
  assert.equal(harness.listenerCount(), 0);
  assert.equal(harness.sent.length, 1, 'closing does not post extra messages');
  await assert.rejects(() => bridge.getDisplay({ timeoutMs: 10 }), /closed/);
});
