/**
 * Session persistence — the layered store behind `restore`/`persist`.
 *
 * Layer 1 is the LMS's `cmi.suspend_data` (a truncating 4096-character field),
 * layer 2 is IndexedDB on the Moodle origin. Node ships no IndexedDB, so this
 * file provides a small asynchronous stand-in (`createFakeIndexedDb`) with the
 * same observable contract for the calls the module makes: `open` (with the
 * upgrade notification), `transaction().objectStore()`, and `get`/`getAll`/
 * `put`/`delete` requests that settle on a later microtask. It also models the
 * two failure modes that matter here — a store that cannot be opened at all,
 * and a `put` that fails with `QuotaExceededError`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as scorm from '../src/scorm-template/js/scorm-wrapper.js';
import { createSessionPersistence } from '../src/scorm-template/js/session-persistence.js';
import {
  decodeSessionPayload,
  encodeSessionReference,
  encodeSessionState,
} from '../src/scorm-template/js/state-codec.js';
import { installLms } from './helpers/lms.js';

const ACTIVITY_ID = 'activity-1';
const STUDENT_ID = 'student-42';
const SUSPEND_DATA = 'cmi.suspend_data';
const SPEC_LIMIT = 4096;

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

/** A deterministic, high-entropy ASCII string: LZW cannot shrink it. */
function noisyText(length, seed = 0x2545f491) {
  let state = seed >>> 0;
  const chars = [];
  for (let i = 0; i < length; i += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    chars.push(String.fromCharCode(33 + ((state >>> 0) % 94)));
  }
  return chars.join('');
}

/** A small, distinguishable scene state. */
const sceneState = (id) => ({ scene_bundle_base64: `bundle-${id}` });

/** Larger than the 4096-character suspend_data field can hold. */
const hugeState = () => ({ scene_bundle_base64: noisyText(6000) });

/** Sits between the 300-characters test LMS stores and the field width. */
const overCapState = (length) => ({ scene_bundle_base64: noisyText(length) });

/** Length of the layer-1 encoding of a state, ignoring any cap. */
function payloadLength(state) {
  const payload = encodeSessionState({
    activityId: ACTIVITY_ID,
    state,
    savedAt: 0,
    limit: Number.MAX_SAFE_INTEGER,
  });
  assert.ok(payload, 'fixture state must be encodable');
  return payload.length;
}

/* -------------------------------------------------------------------------- */
/* A minimal IndexedDB                                                        */
/* -------------------------------------------------------------------------- */

function createFakeIndexedDb({ failOpen = false } = {}) {
  const store = new Map();
  const storeNames = new Set();
  const putDelays = [];
  const putErrors = [];
  const clone = (value) => structuredClone(value);
  const makeRequest = () => ({ result: undefined, error: null, onsuccess: null, onerror: null });

  /** Settle a request after `hops` microtasks, so handlers are attached first. */
  const settle = (request, { result, error }, hops = 0) => {
    let turn = Promise.resolve();
    for (let hop = 0; hop < hops; hop += 1) turn = turn.then(() => {});
    turn.then(() => {
      if (error) {
        request.error = error;
        request.onerror?.(new Error('request failed'));
      } else {
        request.result = result;
        request.onsuccess?.();
      }
    });
  };

  const objectStore = () => ({
    get(key) {
      const request = makeRequest();
      settle(request, { result: store.has(key) ? clone(store.get(key)) : undefined });
      return request;
    },
    getAll() {
      const request = makeRequest();
      settle(request, { result: [...store.values()].map(clone) });
      return request;
    },
    put(value) {
      const request = makeRequest();
      const error = putErrors.shift();
      if (error) {
        settle(request, { error });
        return request;
      }
      store.set(value.key, clone(value));
      settle(request, { result: value.key }, putDelays.shift() ?? 0);
      return request;
    },
    delete(key) {
      const request = makeRequest();
      store.delete(key);
      settle(request, { result: undefined });
      return request;
    },
  });

  const database = {
    objectStoreNames: { contains: (name) => storeNames.has(name) },
    createObjectStore: (name) => {
      storeNames.add(name);
      return {};
    },
    transaction: (name) => {
      if (!storeNames.has(name)) throw new Error(`No such object store: ${name}`);
      return { objectStore: () => objectStore() };
    },
  };

  return {
    indexedDB: {
      open() {
        if (failOpen) throw new Error('IndexedDB is unavailable here');
        const request = makeRequest();
        request.result = database;
        Promise.resolve()
          .then(() => request.onupgradeneeded?.())
          .then(() => request.onsuccess?.());
        return request;
      },
    },
    /** The live records, so a test can age, corrupt or evict them. */
    store,
    /** The only record, failing loudly when the store holds another number of them. */
    only() {
      const records = [...store.values()];
      assert.equal(records.length, 1, 'expected exactly one stored record');
      return records[0];
    },
    seed(record) {
      store.set(record.key, clone(record));
    },
    delaysNextPut(hops) {
      putDelays.push(hops);
    },
    failsNextPut(error) {
      putErrors.push(error);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Harness                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Install a fake LMS (and, optionally, the fake IndexedDB) and open a session.
 * Extra controllers created through `openController` share the same LMS, which
 * is what a later page load looks like.
 */
function startSession(t, { lms = {}, indexedDb = false, connect = true, persistence = {} } = {}) {
  const fake = indexedDb ? createFakeIndexedDb(indexedDb === true ? {} : indexedDb) : null;
  if (fake) globalThis.indexedDB = fake.indexedDB;
  else delete globalThis.indexedDB;

  const server = installLms(lms);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  // Swallowed: the module's warnings are asserted through the mock's calls.
  const warn = t.mock.method(console, 'warn', () => {});
  const warnings = [];

  const openController = (options = {}) => createSessionPersistence({
    activityId: ACTIVITY_ID,
    studentId: STUDENT_ID,
    onWarning: (message) => warnings.push(message),
    ...options,
  });

  const controller = openController(persistence);

  if (connect) scorm.init();
  else scorm.terminate();

  t.after(() => {
    scorm.terminate();
    server.restore();
    delete globalThis.indexedDB;
  });

  return { lms: server, fake, controller, openController, warnings, warn };
}

/** Warnings the persistence module itself logged (the SCORM wrapper logs its own). */
function persistenceWarnings(warn) {
  return warn.mock.calls
    .map((call) => String(call.arguments[0]))
    .filter((message) => message.startsWith('[SessionPersistence]'));
}

/** Number of writes the module made through the LMS's suspend_data field. */
function suspendDataWrites(lms) {
  return lms.callsOf('LMSSetValue').filter((call) => call.args[0] === SUSPEND_DATA).length;
}

/** Emptied through the LMS API, the way a student's field starts out elsewhere. */
function clearSuspendDataFromLms(lms) {
  lms.model.delete(SUSPEND_DATA);
}

const storedState = (lms) => decodeSessionPayload({
  payload: lms.valueOf(SUSPEND_DATA),
  activityId: ACTIVITY_ID,
});

/**
 * A controller for the same package served from another Moodle path. The
 * module reads `location.pathname` once, when the controller is created, to
 * tell two copies of one package apart.
 */
function controllerAtPath(pathname, options = {}) {
  const previous = globalThis.location;
  globalThis.location = { pathname };
  try {
    return createSessionPersistence({
      activityId: ACTIVITY_ID,
      studentId: STUDENT_ID,
      onWarning: () => {},
      ...options,
    });
  } finally {
    if (previous === undefined) delete globalThis.location;
    else globalThis.location = previous;
  }
}

/* -------------------------------------------------------------------------- */
/* Restore                                                                    */
/* -------------------------------------------------------------------------- */

test('restore reports nothing stored, with no notice', async (t) => {
  const { controller } = startSession(t, { persistence: { studentId: '' } });

  assert.deepEqual(await controller.restore(), { state: null, source: null, savedAt: 0, notice: null });
});

test('restore ignores suspend_data written for another activity, without a notice', async (t) => {
  const { lms, controller } = startSession(t, { persistence: { studentId: '' } });
  const mine = sceneState(1);

  lms.model.set(SUSPEND_DATA, encodeSessionState({
    activityId: 'another-activity',
    state: sceneState(2),
    savedAt: 10,
    limit: SPEC_LIMIT,
  }));
  assert.deepEqual(await controller.restore(), { state: null, source: null, savedAt: 0, notice: null });

  lms.model.set(SUSPEND_DATA, encodeSessionState({
    activityId: ACTIVITY_ID,
    state: mine,
    savedAt: 20,
    limit: SPEC_LIMIT,
  }));
  assert.deepEqual(await controller.restore(), {
    state: mine,
    source: 'suspend_data',
    savedAt: 20,
    notice: null,
  });
});

test('restore ignores a truncated payload and still uses the browser copy', async (t) => {
  const { lms, fake, controller, openController } = startSession(t, { indexedDb: true });
  const state = sceneState(3);
  await controller.persist(state);
  const stored = lms.valueOf(SUSPEND_DATA);

  // The LMS stored only the first 30 characters of the field.
  lms.model.set(SUSPEND_DATA, stored.slice(0, 30));
  const restored = await controller.restore();
  assert.equal(restored.source, 'indexeddb');
  assert.deepEqual(restored.state, fake.only().state);
  assert.equal(restored.notice, null);

  // With no browser copy the truncated payload is simply nothing.
  const anonymous = openController({ studentId: '' });
  assert.deepEqual(await anonymous.restore(), { state: null, source: null, savedAt: 0, notice: null });

  // Raw JSON from an older version of the package is ignored rather than reported as lost.
  lms.model.set(SUSPEND_DATA, JSON.stringify({ scene_bundle_base64: 'bundle-1' }));
  assert.deepEqual(await anonymous.restore(), { state: null, source: null, savedAt: 0, notice: null });
});

test('restore prefers the suspend_data snapshot when both layers hold it', async (t) => {
  const { fake, controller } = startSession(t, { indexedDb: true });
  const state = sceneState(2);
  await controller.persist(state);
  const record = fake.only();

  const restored = await controller.restore();
  assert.equal(restored.source, 'suspend_data');
  assert.equal(restored.savedAt, record.savedAt);
  assert.deepEqual(restored.state, state);
});

test('restore takes the newest snapshot when the layers disagree', async (t) => {
  const { lms, fake, controller, openController } = startSession(t, { indexedDb: true });
  const older = sceneState(1);
  await controller.persist(older);
  const record = fake.only();
  const base = record.savedAt;

  // The browser copy is newer than the copy the LMS is holding.
  const newerOnDevice = sceneState(2);
  record.savedAt = base + 60_000;
  record.state = structuredClone(newerOnDevice);
  assert.deepEqual(await openController().restore(), {
    state: newerOnDevice,
    source: 'indexeddb',
    savedAt: base + 60_000,
    notice: null,
  });

  // A session on another device left a newer copy in the LMS.
  const newerOnLms = sceneState(3);
  record.savedAt = base - 60_000;
  record.state = structuredClone(older);
  lms.model.set(SUSPEND_DATA, encodeSessionState({
    activityId: ACTIVITY_ID,
    state: newerOnLms,
    savedAt: base + 120_000,
    limit: SPEC_LIMIT,
  }));
  assert.deepEqual(await openController().restore(), {
    state: newerOnLms,
    source: 'suspend_data',
    savedAt: base + 120_000,
    notice: null,
  });
});

test('restore ignores a record for another activity or one holding an unusable state', async (t) => {
  const { lms, fake, controller } = startSession(t, { indexedDb: true });
  await controller.persist(sceneState(2));
  const record = fake.only();
  clearSuspendDataFromLms(lms);

  record.activityId = 'a-different-activity';
  assert.deepEqual(await controller.restore(), { state: null, source: null, savedAt: 0, notice: null });

  record.activityId = ACTIVITY_ID;
  record.state = { scene_bundle_base64: 5 };
  assert.deepEqual(await controller.restore(), { state: null, source: null, savedAt: 0, notice: null });
});

test('a reference in suspend_data with the browser copy gone reports the lost copy', async (t) => {
  const { lms, fake, controller, openController } = startSession(t, { indexedDb: true });
  const state = sceneState(2);
  await controller.persist(state);
  const record = fake.only();

  // The LMS knows about the saved session; this browser has lost the scene.
  fake.store.clear();
  lms.model.set(SUSPEND_DATA, encodeSessionReference({
    activityId: ACTIVITY_ID,
    savedAt: record.savedAt,
  }));
  const lost = await openController().restore();
  assert.equal(lost.state, null);
  assert.equal(lost.source, null);
  assert.equal(lost.savedAt, 0);
  assert.match(lost.notice, /no longer has the saved copy/);

  // The same reference, with the browser copy back in place.
  fake.seed(record);
  const found = await openController().restore();
  assert.equal(found.source, 'indexeddb');
  assert.equal(found.notice, null);
  assert.deepEqual(found.state, state);
});

test('an empty student id keeps the browser copy out of reach', async (t) => {
  const { fake, controller, openController, warnings } = startSession(t, { indexedDb: true });
  const onLms = sceneState(1);
  const onDevice = sceneState(4);
  await controller.persist(onLms);
  const record = fake.only();
  record.savedAt += 60_000;
  record.state = structuredClone(onDevice);

  const anonymous = openController({ studentId: '' });
  const restored = await anonymous.restore();
  assert.equal(restored.source, 'suspend_data');
  assert.deepEqual(restored.state, onLms);

  // Without a student id there is no fallback layer for what the LMS cannot keep.
  assert.equal(await anonymous.persist(hugeState()), 'none');
  assert.equal(fake.store.size, 1);
  assert.deepEqual(warnings, [
    'Your scene is too large to save, so it will not be restored next session.',
  ]);
});

test('a second copy of the package in the same browser does not see the first copy’s scene', async (t) => {
  const { lms, fake, controller } = startSession(t, { indexedDb: true });
  const stateA = sceneState(1);
  await controller.persist(stateA);
  const recordA = fake.only();
  clearSuspendDataFromLms(lms);

  const elsewhere = controllerAtPath('/mod/scorm/instance-2/view.php');
  // Layer 1 is shared, layer 2 is not: the other copy finds nothing to restore.
  assert.deepEqual(await elsewhere.restore(), { state: null, source: null, savedAt: 0, notice: null });

  const stateB = sceneState(2);
  assert.equal(await elsewhere.persist(stateB), 'suspend_data');
  assert.equal(fake.store.size, 2);
  assert.deepEqual(fake.store.get(recordA.key).state, stateA);

  // Each copy reads back its own browser record.
  clearSuspendDataFromLms(lms);
  assert.deepEqual((await elsewhere.restore()).state, stateB);
  assert.deepEqual((await controller.restore()).state, stateA);
});

/* -------------------------------------------------------------------------- */
/* Persist                                                                    */
/* -------------------------------------------------------------------------- */

test('persist writes a payload the next session can load, and names the layer', async (t) => {
  const { lms, controller, openController } = startSession(t, { indexedDb: true });
  const state = { scene_bundle_base64: 'QUJDRA=='.repeat(50) };

  assert.equal(await controller.persist(state), 'suspend_data');
  assert.equal(storedState(lms).kind, 'state');

  const restored = await openController().restore();
  assert.equal(restored.source, 'suspend_data');
  assert.deepEqual(restored.state, state);
});

test('persist leaves an unchanged state alone', async (t) => {
  const { lms, fake, controller } = startSession(t, { indexedDb: true });
  const state = sceneState(2);
  await controller.persist(state);
  const writes = suspendDataWrites(lms);
  const savedAt = fake.only().savedAt;

  assert.equal(await controller.persist(state), 'suspend_data');
  assert.equal(await controller.persist(structuredClone(state)), 'suspend_data');
  assert.equal(suspendDataWrites(lms), writes);
  assert.equal(fake.only().savedAt, savedAt);

  assert.equal(await controller.persist(sceneState(3)), 'suspend_data');
  assert.equal(suspendDataWrites(lms), writes + 1);
});

test('a snapshot restored from the browser copy is not written back on load', async (t) => {
  const { lms, controller, openController } = startSession(t, {
    indexedDb: true,
    lms: { rejectSuspendData: true },
  });
  const state = sceneState(2);
  assert.equal(await controller.persist(state), 'indexeddb');
  const writes = suspendDataWrites(lms);

  const next = openController();
  const restored = await next.restore();
  assert.equal(restored.source, 'indexeddb');
  assert.deepEqual(restored.state, state);

  assert.equal(await next.persist(restored.state), 'indexeddb');
  assert.equal(suspendDataWrites(lms), writes);
});

test('two persists in flight land in order', async (t) => {
  const { lms, fake, controller } = startSession(t, { indexedDb: true });
  fake.delaysNextPut(8);

  const results = await Promise.all([
    controller.persist(sceneState(1)),
    controller.persist(sceneState(5)),
  ]);
  assert.deepEqual(results, ['suspend_data', 'suspend_data']);

  assert.equal(storedState(lms).state.scene_bundle_base64, 'bundle-5');
  const order = lms.callsOf('LMSSetValue')
    .filter((call) => call.args[0] === SUSPEND_DATA)
    .map((call) => decodeSessionPayload({ payload: call.args[1], activityId: ACTIVITY_ID })
      ?.state?.scene_bundle_base64);
  assert.deepEqual(order, ['bundle-1', 'bundle-5']);
});

test('nothing is written before the SCORM session is active', async (t) => {
  const { lms, controller, warnings } = startSession(t, {
    connect: false,
    persistence: { studentId: '' },
  });
  const state = sceneState(1);

  assert.equal(await controller.persist(state), 'none');
  assert.equal(controller.persistNow(state), 'none');
  assert.deepEqual(lms.callsOf('LMSSetValue'), []);
  assert.deepEqual(warnings, []);
  assert.deepEqual(await controller.restore(), { state: null, source: null, savedAt: 0, notice: null });
});

test('persistNow writes straight through the suspend_data layer', async (t) => {
  const { lms, controller, warnings } = startSession(t, { indexedDb: true });
  const first = sceneState(1);
  await controller.persist(first);

  const second = sceneState(2);
  assert.equal(controller.persistNow(second), 'suspend_data');
  assert.deepEqual(storedState(lms).state, second);
  const writes = suspendDataWrites(lms);
  assert.equal(controller.persistNow(second), 'suspend_data');
  assert.equal(suspendDataWrites(lms), writes);

  // Something too large for the field cannot use the browser copy left by `persist`.
  assert.equal(controller.persistNow(hugeState()), 'indexeddb');
  assert.deepEqual(warnings, [
    'Your scene is stored in this browser only — it is too large for the LMS to keep.',
  ]);
  assert.deepEqual(storedState(lms).state, second);
});

/* -------------------------------------------------------------------------- */
/* Failure paths                                                              */
/* -------------------------------------------------------------------------- */

test('a truncating LMS is caught by read-back: the cap drops, one warning, the browser copy takes over', async (t) => {
  const { lms, fake, controller, warn, warnings } = startSession(t, {
    indexedDb: true,
    lms: { suspendDataLimit: 300 },
  });
  const small = sceneState(1);
  const big = overCapState(400);
  assert.ok(payloadLength(small) <= 300, 'small fixture fits the field');
  assert.ok(payloadLength(big) > 300 && payloadLength(big) <= SPEC_LIMIT, 'big fixture crosses 300 only');

  assert.equal(await controller.persist(small), 'suspend_data');
  assert.deepEqual(persistenceWarnings(warn), []);

  assert.equal(await controller.persist(big), 'indexeddb');
  assert.deepEqual(fake.only().state, big);
  // The truncated write was replaced by the last snapshot that fit.
  assert.deepEqual(storedState(lms).state, small);
  const logged = persistenceWarnings(warn);
  assert.equal(logged.length, 1);
  assert.match(logged[0], /stored 300 of \d+ characters; capping suspend data at 300/);
  assert.deepEqual(warnings, []);

  // A second over-cap write warns no further, and does not shrink the cap again.
  const secondBig = overCapState(350);
  assert.ok(payloadLength(secondBig) > 300, 'second fixture still over the cap');
  assert.equal(await controller.persist(secondBig), 'indexeddb');
  assert.equal(persistenceWarnings(warn).length, 1);
  assert.deepEqual(storedState(lms).state, small);
  assert.equal(fake.only().suspendLimit, 300);
});

test('the cap learned in an earlier session is reused instead of rediscovered', async (t) => {
  const { lms, fake, controller, openController, warn } = startSession(t, {
    indexedDb: true,
    lms: { suspendDataLimit: 300 },
  });
  const small = sceneState(1);
  const big = overCapState(400);
  assert.equal(await controller.persist(big), 'indexeddb');
  assert.equal(await controller.persist(small), 'suspend_data');
  assert.equal(fake.only().suspendLimit, 300);
  assert.equal(persistenceWarnings(warn).length, 1);

  const writes = suspendDataWrites(lms);
  const next = openController();
  const restored = await next.restore();
  assert.equal(restored.source, 'suspend_data');
  assert.equal(restored.state.scene_bundle_base64, small.scene_bundle_base64);
  // Reading the cap back wrote nothing.
  assert.equal(suspendDataWrites(lms), writes);
  assert.equal(persistenceWarnings(warn).length, 1);

  // A payload between the learned cap and the field width goes straight to the
  // browser layer: it is refused before the LMS can truncate (and warn) again.
  const overCap = overCapState(1500);
  assert.ok(payloadLength(overCap) > 300 && payloadLength(overCap) <= SPEC_LIMIT, 'fixture sits between the cap and the field width');
  assert.equal(await next.persist(overCap), 'indexeddb');
  assert.equal(fake.only().suspendLimit, 300);
  assert.equal(persistenceWarnings(warn).length, 1);
  assert.equal(suspendDataWrites(lms), writes);
  assert.deepEqual(storedState(lms).state, small);

  const fitting = sceneState(2);
  assert.ok(payloadLength(fitting) <= 300, 'fixture must fit the learned cap');
  assert.equal(await next.persist(fitting), 'suspend_data');
  assert.equal(persistenceWarnings(warn).length, 1);
});

test('an LMS that stores nothing at all does not drag the cap to zero', async (t) => {
  const { lms, fake, controller, openController, warnings, warn } = startSession(t, {
    indexedDb: true,
    lms: { suspendDataLimit: 0 },
  });
  const state = sceneState(3);

  assert.equal(await controller.persist(state), 'indexeddb');
  assert.equal(fake.only().suspendLimit, SPEC_LIMIT);
  // Nothing half-written is left behind for the next session to read.
  assert.equal(lms.valueOf(SUSPEND_DATA), '');
  assert.equal(persistenceWarnings(warn).length, 1);
  assert.deepEqual(warnings, []);

  const restored = await openController().restore();
  assert.equal(restored.source, 'indexeddb');
  assert.deepEqual(restored.state, fake.only().state);
  assert.deepEqual(restored.state, state);
});

test('a write the LMS refuses leaves the browser copy as the only layer, without alarming the student', async (t) => {
  const { lms, fake, controller, warnings, warn } = startSession(t, {
    indexedDb: true,
    lms: { rejectSuspendData: true },
  });

  assert.equal(await controller.persist(sceneState(1)), 'indexeddb');
  assert.equal(await controller.persist(sceneState(2)), 'indexeddb');
  assert.equal(lms.valueOf(SUSPEND_DATA), '');
  assert.ok(lms.rejected.length > 0);
  // The work is stored in the browser, so there is nothing to warn about.
  assert.deepEqual(warnings, []);
  assert.deepEqual(persistenceWarnings(warn), []);
  assert.deepEqual(fake.only().state, sceneState(2));
});

test('a refused write with no browser copy tells the student the scene will not be restored', async (t) => {
  const { controller, warnings } = startSession(t, {
    lms: { rejectSuspendData: true },
    persistence: { studentId: '' },
  });

  assert.equal(await controller.persist(sceneState(1)), 'none');
  assert.equal(await controller.persist(sceneState(2)), 'none');
  assert.deepEqual(warnings, [
    'The LMS did not store your scene, so it will not be restored next session.',
  ]);
});

test('a scene too large for either layer warns once with the consequence', async (t) => {
  const { lms, controller, openController, warnings } = startSession(t, { indexedDb: true });
  const huge = hugeState();
  assert.equal(encodeSessionState({
    activityId: ACTIVITY_ID,
    state: huge,
    savedAt: 0,
    limit: SPEC_LIMIT,
  }), null, 'fixture must not fit the spec limit');

  const anonymous = openController({ studentId: '' });
  assert.equal(await anonymous.persist(huge), 'none');
  assert.equal(await anonymous.persist(huge), 'none');

  // The browser copy can hold it, and the student is told where it went.
  assert.equal(await controller.persist(huge), 'indexeddb');
  assert.equal(storedState(lms).kind, 'reference');
  assert.deepEqual(warnings, [
    'Your scene is too large to save, so it will not be restored next session.',
    'Your scene is stored in this browser only — it is too large for the LMS to keep.',
  ]);

  const restored = await openController().restore();
  assert.equal(restored.source, 'indexeddb');
  assert.equal(restored.notice, null);
  assert.deepEqual(restored.state, huge);
});

test('a broken IndexedDB never breaks the suspend_data layer', async (t) => {
  const { controller, openController } = startSession(t, { indexedDb: { failOpen: true } });
  const state = sceneState(2);

  assert.equal(await controller.persist(state), 'suspend_data');

  const restored = await openController().restore();
  assert.equal(restored.source, 'suspend_data');
  assert.deepEqual(restored.state, state);
});

test('a full browser store makes room instead of losing the save', async (t) => {
  const { fake, controller } = startSession(t, { indexedDb: true });
  const stranger = {
    key: 'other::record',
    activityId: 'another-activity',
    studentId: STUDENT_ID,
    savedAt: Date.now(),
    suspendLimit: SPEC_LIMIT,
    state: sceneState(1),
  };
  fake.seed(stranger);
  fake.failsNextPut(Object.assign(new Error('quota exceeded'), { name: 'QuotaExceededError' }));

  const state = sceneState(2);
  assert.equal(await controller.persist(state), 'suspend_data');
  assert.equal(fake.store.has(stranger.key), false);
  assert.deepEqual(fake.only().state, state);
});

test('an unusable state never leaves a broken payload behind', async (t) => {
  const { lms, controller, openController } = startSession(t, { indexedDb: true });

  for (const unusable of [null, undefined, 'not a state', { blocks: {} }]) {
    await controller.persist(unusable);
    const stored = storedState(lms);
    assert.ok(stored === null || stored.kind === 'reference', `layer 1 holds ${JSON.stringify(stored)}`);
  }

  // The junk records are not handed back as a scene.
  const restored = await openController().restore();
  assert.equal(restored.state, null);

  // And a real state still stores normally afterwards.
  const state = sceneState(2);
  assert.equal(await controller.persist(state), 'suspend_data');
  assert.deepEqual(storedState(lms).state, state);
});

/* -------------------------------------------------------------------------- */
/* Limits and discard                                                         */
/* -------------------------------------------------------------------------- */

test('the cap is normalized before it reaches the encoder', async (t) => {
  const { openController, warnings } = startSession(t, { persistence: { studentId: '' } });
  const state = overCapState(1500);
  const length = payloadLength(state);
  assert.ok(length > 1024 && length <= 2048, `fixture must sit between the two test limits (got ${length})`);

  // Under the cap the payload is refused; over it the payload goes through.
  assert.equal(await openController({ limit: 1024.9 }).persist(state), 'none');
  assert.equal(await openController({ limit: '2048' }).persist(state), 'suspend_data');
  // Unusable limits fall back to the SCORM field width.
  for (const limit of [0, -10, Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
    assert.equal(
      await openController({ limit }).persist(state),
      'suspend_data',
      `limit ${String(limit)} should fall back to the field width`,
    );
  }
  assert.deepEqual(warnings, [
    'Your scene is too large to save, so it will not be restored next session.',
  ]);
});

test('discard clears both layers and keeps the given state as the baseline', async (t) => {
  const { lms, fake, controller } = startSession(t, { indexedDb: true });
  const state = sceneState(2);
  await controller.persist(state);
  assert.equal(fake.store.size, 1);
  const writes = suspendDataWrites(lms);

  await controller.discard(state);
  assert.equal(lms.valueOf(SUSPEND_DATA), '');
  assert.equal(fake.store.size, 0);

  // The reset does not write the same scene straight back.
  assert.equal(await controller.persist(state), 'none');
  assert.equal(suspendDataWrites(lms), writes + 1);

  // A changed scene stores again, into both layers.
  assert.equal(await controller.persist(sceneState(3)), 'suspend_data');
  assert.equal(fake.store.size, 1);
});
