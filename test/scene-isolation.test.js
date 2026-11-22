import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  base64ToBytes,
  bytesToBase64,
  decodeSwarmBundle,
  encodeSwarmBundle,
} from '../src/shared/swarm-bundle.js';
import { createSceneIsolation, restoreAuthoredScene } from '../src/shared/scene-isolation.js';

const now = '2026-06-01T02:03:04.000Z';

function artifact(id, mainPy) {
  return {
    id,
    name: `${id}.hex`,
    artifactKind: 'hex',
    runtimeSource: 'micropython',
    program: {
      runtimeSource: 'micropython',
      filesystemBase64: { 'main.py': btoa(mainPy) },
    },
    createdAt: now,
  };
}

function authoredScene() {
  return {
    schemaVersion: 9,
    id: 'isolation-scene',
    name: 'Isolation scene',
    createdAt: now,
    updatedAt: now,
    viewOptions: { showRadioRange: true },
    devices: [
      {
        id: 'device-1',
        name: 'Node 1',
        position: { x: 100, y: 100 },
        programArtifactId: 'authored-code',
      },
      {
        id: 'device-2',
        name: 'Node 2',
        position: { x: 200, y: 200 },
        locked: true,
      },
    ],
    artifacts: [artifact('authored-code', 'print("authored")')],
    environmentSources: [
      {
        id: 'light-1',
        type: 'light',
        name: 'Light 1',
        position: { x: 50, y: 50 },
        radius: 120,
        intensity: 0.4,
        locked: true,
      },
    ],
  };
}

/** The live scene: the learner moved everything and edited the code. */
function liveScene() {
  return {
    schemaVersion: 9,
    id: 'isolation-scene',
    name: 'Isolation scene',
    createdAt: now,
    updatedAt: '2026-06-02T00:00:00.000Z',
    viewOptions: { showRadioRange: false },
    devices: [
      {
        id: 'device-1',
        name: 'Node 1',
        position: { x: 400, y: 300 },
        programArtifactId: 'learner-code',
        editableProgram: {
          runtimeSource: 'micropython',
          baseArtifactId: 'learner-code',
          revision: 3,
          updatedAt: now,
          files: { 'main.py': 'print("learner")' },
        },
      },
      {
        id: 'device-2',
        name: 'Node 2',
        position: { x: 420, y: 260 },
        locked: true,
      },
    ],
    artifacts: [artifact('learner-code', 'print("learner")')],
    environmentSources: [
      {
        id: 'light-1',
        type: 'light',
        name: 'Light 1',
        position: { x: 700, y: 400 },
        radius: 120,
        intensity: 1,
        locked: true,
      },
      {
        id: 'sound-9',
        type: 'sound',
        name: 'Sound 9',
        position: { x: 10, y: 10 },
        radius: 100,
        intensity: 1,
      },
    ],
  };
}

function encoded(project) {
  return bytesToBase64(encodeSwarmBundle(project));
}

function createBridge({ live = liveScene(), restartDeviceIds = ['device-1'] } = {}) {
  const listeners = new Set();
  const loads = [];
  const bridge = {
    onEvent(callback) {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    async getBundle() {
      return encoded(live);
    },
    async loadBundle(base64, options) {
      loads.push({ project: decodeSwarmBundle(base64ToBytes(base64)), options });
      // The real simulator answers before the runtimes have restarted.
      for (const deviceId of restartDeviceIds) {
        for (const listener of [...listeners]) {
          listener({ ts: Date.now(), event: { kind: 'code-restart', device_id: deviceId } });
        }
      }
    },
    emit(event) {
      for (const listener of [...listeners]) listener({ ts: Date.now(), event });
    },
  };
  return { bridge, loads };
}

test('the authored geometry wins and the live code assignments ride along', () => {
  const authored = authoredScene();
  const live = liveScene();
  const merged = restoreAuthoredScene(authored, live);

  assert.deepEqual(merged.devices.map((device) => device.id), ['device-1', 'device-2']);
  assert.deepEqual(merged.devices[0].position, { x: 100, y: 100 });
  assert.equal(merged.devices[0].programArtifactId, 'learner-code');
  assert.deepEqual(merged.devices[0].editableProgram, live.devices[0].editableProgram);
  // A locked, pinned or re-levelled scene object is authored state, not learner state.
  assert.deepEqual(merged.devices[1], authored.devices[1]);
  assert.deepEqual(merged.environmentSources, authored.environmentSources);
  // Test-added nodes are gone, and only referenced artifacts remain.
  assert.deepEqual(merged.artifacts.map((entry) => entry.id), ['learner-code']);
  assert.equal(merged.viewOptions.showRadioRange, live.viewOptions.showRadioRange);
});

test('authored code survives when the live scene still references it', () => {
  const authored = authoredScene();
  const live = liveScene();
  const merged = restoreAuthoredScene(authored, {
    ...live,
    devices: live.devices.map((device) =>
      device.id === 'device-1' ? { ...device, programArtifactId: 'authored-code' } : device,
    ),
    artifacts: [...live.artifacts, ...authored.artifacts],
  });

  assert.equal(merged.devices[0].programArtifactId, 'authored-code');
  assert.deepEqual(merged.artifacts.map((entry) => entry.id), ['authored-code']);
});

test('a live device without code keeps its authored pin but not its authored code', async () => {
  const authored = authoredScene();
  authored.devices = [{ ...authored.devices[0], positionPinned: true }];
  const live = {
    ...liveScene(),
    devices: [{ id: 'device-1', name: 'Node 1', position: { x: 10, y: 20 } }],
    artifacts: [],
  };
  const { bridge, loads } = createBridge({ live, restartDeviceIds: [] });
  const isolation = createSceneIsolation({ bridge, authoredBundleBase64: encoded(authored) });

  const prepared = await isolation.prepare();
  assert.deepEqual(prepared, { authored: true, deviceCount: 0 });
  await isolation.isolate({});

  const device = loads[0].project.devices[0];
  assert.equal(device.positionPinned, true);
  assert.deepEqual(device.position, { x: 100, y: 100 });
  assert.equal(device.programArtifactId, undefined);
  assert.equal(device.editableProgram, undefined);
  assert.deepEqual(loads[0].project.artifacts, []);
});

test('isolate loads the merged baseline and waits for every programmed device', async () => {
  const { bridge, loads } = createBridge({ restartDeviceIds: ['device-1'] });
  const isolation = createSceneIsolation({ bridge, authoredBundleBase64: encoded(authoredScene()) });

  const prepared = await isolation.prepare();
  assert.deepEqual(prepared, { authored: true, deviceCount: 1 });

  await isolation.isolate({});
  assert.equal(loads.length, 1);
  const loaded = loads[0].project;
  assert.deepEqual(loaded.devices[0].position, { x: 100, y: 100 });
  assert.equal(loaded.devices[0].programArtifactId, 'learner-code');
  assert.deepEqual(loaded.environmentSources, authoredScene().environmentSources);
  assert.ok(loads[0].options.timeoutMs > 0);
});

test('a restart that never arrives fails the isolation with the device named', async () => {
  const { bridge } = createBridge({ restartDeviceIds: [] });
  const isolation = createSceneIsolation({
    bridge,
    authoredBundleBase64: encoded(authoredScene()),
    restartTimeoutMs: 20,
  });
  await isolation.prepare();

  await assert.rejects(
    () => isolation.isolate({}),
    /The simulator did not restart device-1 within 20 ms\./,
  );
});

test('code-load also counts as a restart, and idle devices never block', async () => {
  const { bridge, loads } = createBridge({ restartDeviceIds: [] });
  const isolation = createSceneIsolation({
    bridge,
    authoredBundleBase64: encoded(authoredScene()),
    restartTimeoutMs: 20,
  });
  await isolation.prepare();
  const pending = isolation.isolate({});
  bridge.emit({ kind: 'code-load', device_id: 'device-1' });
  await pending;
  assert.equal(loads.length, 1);
});

test('an abort while waiting rejects with the abort reason', async () => {
  const { bridge } = createBridge({ restartDeviceIds: [] });
  const isolation = createSceneIsolation({
    bridge,
    authoredBundleBase64: encoded(authoredScene()),
    restartTimeoutMs: 5_000,
  });
  await isolation.prepare();

  const controller = new AbortController();
  const pending = isolation.isolate({ signal: controller.signal });
  controller.abort(new Error('run cancelled'));
  await assert.rejects(() => pending, /run cancelled/);
});

test('without an authored bundle the live positions are the baseline', async () => {
  const { bridge, loads } = createBridge({ restartDeviceIds: ['device-1'] });
  const isolation = createSceneIsolation({ bridge, authoredBundleBase64: null });
  const prepared = await isolation.prepare();
  assert.equal(prepared.authored, false);

  await isolation.isolate({});
  assert.deepEqual(loads[0].project.devices[0].position, { x: 400, y: 300 });
  assert.deepEqual(loads[0].project.environmentSources.map((source) => source.id), ['light-1', 'sound-9']);
});

test('a corrupt authored bundle warns and falls back to the live scene', async () => {
  const warnings = [];
  const { bridge, loads } = createBridge({ restartDeviceIds: ['device-1'] });
  const isolation = createSceneIsolation({
    bridge,
    authoredBundleBase64: bytesToBase64(new TextEncoder().encode('not a swarm bundle')),
    onWarning: (message) => warnings.push(message),
  });
  await isolation.prepare();
  await isolation.isolate({});

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /Authored scene could not be read/);
  assert.deepEqual(loads[0].project.devices[0].position, { x: 400, y: 300 });
});

test('isolate prepares lazily when the host forgot to', async () => {
  const { bridge, loads } = createBridge({ restartDeviceIds: ['device-1'] });
  const isolation = createSceneIsolation({ bridge, authoredBundleBase64: encoded(authoredScene()) });

  await isolation.isolate({});
  assert.equal(loads.length, 1);
});

test('an empty get-bundle reply stops the run instead of loading nothing', async () => {
  const isolation = createSceneIsolation({
    bridge: { onEvent: () => () => {}, async getBundle() { return undefined; }, async loadBundle() {} },
    authoredBundleBase64: encoded(authoredScene()),
  });

  await assert.rejects(() => isolation.prepare(), /did not return its scene/);
});
