/**
 * Scene state codec — the payload written to SCORM 1.2 `cmi.suspend_data`.
 *
 * The interesting edges are the fixed width of that field (4096 characters,
 * below which the codec would rather store nothing than store a truncated
 * scene), the encodings it chooses between, the ASCII-only data-model type
 * that pushes any non-ASCII value onto the base64/LZW path, and the activity
 * id baked into the header — a payload may only be restored by the activity
 * that wrote it. The state itself is `{ scene_bundle_base64: string }`, so
 * there is nothing to compact: the compact `C` format is decode-only.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SUSPEND_DATA_MAX_LENGTH,
  SUSPEND_DATA_MIN_LENGTH,
  compactSessionState,
  decodeSessionPayload,
  encodeSessionReference,
  encodeSessionState,
  sanitizeActivityId,
} from '../src/scorm-template/js/state-codec.js';

/** A fixed timestamp keeps every payload length in this file deterministic. */
const SAVED_AT = 1700000000000;
const SAVED_AT_BASE36 = 'loyw3v28';

const scene = (bundle) => ({ scene_bundle_base64: bundle });
const helloScene = () => scene('aGVsbG8=');

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

/** 140 distinct CJK code points: not ASCII, and not compressible either. */
const uniqueCjk = () => Array.from({ length: 140 }, (_, i) => String.fromCodePoint(0x4e00 + i)).join('');

const formatOf = (payload) => payload.split('|')[2];
const encode = (overrides) => encodeSessionState({ activityId: 'act', savedAt: SAVED_AT, ...overrides });
const decode = (payload, activityId = 'act') => decodeSessionPayload({ payload, activityId });

test('the persisted payload is prefix, activity, format, base36 timestamp, data', () => {
  const payload = encode({ activityId: 'act-1', state: helloScene() });

  assert.equal(payload, `BS1|act-1|J|${SAVED_AT_BASE36}|{"scene_bundle_base64":"aGVsbG8="}`);
  assert.equal(Number.parseInt(SAVED_AT_BASE36, 36), SAVED_AT);
});

test('a state carrying the scene bundle takes the raw JSON format and comes back unchanged', () => {
  const state = helloScene();

  const payload = encode({ state });

  assert.equal(formatOf(payload), 'J');
  assert.deepEqual(decode(payload), { kind: 'state', format: 'J', savedAt: SAVED_AT, state });
});

test('a non-ASCII bundle takes the base64 path and the payload stays printable ASCII', () => {
  const bundle = `${uniqueCjk()} 🚀`;
  const state = scene(bundle);

  const payload = encode({ state });

  assert.equal(formatOf(payload), 'B');
  assert.match(payload, /^[\x20-\x7e]+$/);
  assert.equal(decode(payload).state.scene_bundle_base64, bundle);
});

test('a large repetitive bundle takes the LZW path and still fits the field', () => {
  const state = scene('QUJD'.repeat(990));

  const payload = encode({ state });

  assert.equal(formatOf(payload), 'L');
  assert.ok(payload.length <= SUSPEND_DATA_MAX_LENGTH, 'payload should still fit the SCORM field');
  assert.ok(payload.length < JSON.stringify(state).length, 'compression should beat the raw state');
  assert.deepEqual(decode(payload), { kind: 'state', format: 'L', savedAt: SAVED_AT, state });
});

test('a bundle large enough to fill the LZW dictionary still round-trips', () => {
  // High-entropy noise fills the 16-bit dictionary, then a long repetition
  // exploits it; the noise alone would never be chosen for compression.
  const bundle = noisyText(120000) + 'abcdefghij'.repeat(20000);
  const state = scene(bundle);

  const payload = encode({ state, limit: 1e6 });

  assert.equal(formatOf(payload), 'L');
  assert.equal(decode(payload).state.scene_bundle_base64, bundle);
});

test('a payload exactly at the limit is kept, one character over is refused', () => {
  const state = scene(noisyText(900));

  const payload = encode({ state });
  assert.ok(payload.length > SUSPEND_DATA_MIN_LENGTH, 'the exact-fit boundary must sit above the minimum');

  assert.equal(encode({ state, limit: payload.length }), payload);
  assert.equal(encode({ state, limit: payload.length - 1 }), null);
  assert.equal(encode({ state, limit: payload.length - 0.1 }), null);
});

test('the SCORM field width is the default limit, and an oversized scene is refused', () => {
  const state = scene(noisyText(6000));
  const payload = encode({ state, limit: 20000 });

  assert.equal(SUSPEND_DATA_MAX_LENGTH, 4096);
  assert.ok(payload.length > SUSPEND_DATA_MAX_LENGTH);
  assert.equal(decode(payload).state.scene_bundle_base64, noisyText(6000));
  assert.equal(encode({ state }), null);
});

test('a limit under the minimum is raised to the minimum, so only tiny payloads survive', () => {
  const tiny = encode({ state: scene('x') });
  const overMinimum = encode({ state: scene(uniqueCjk()) });

  assert.equal(SUSPEND_DATA_MIN_LENGTH, 512);
  assert.ok(tiny.length < SUSPEND_DATA_MIN_LENGTH);
  assert.ok(overMinimum.length > SUSPEND_DATA_MIN_LENGTH);

  for (const limit of [0, 1, -1000, SUSPEND_DATA_MIN_LENGTH - 1]) {
    assert.equal(encode({ state: scene('x'), limit }), tiny, `limit ${limit} should still admit a tiny payload`);
    assert.equal(encode({ state: scene(uniqueCjk()), limit }), null, `limit ${limit} should refuse an over-minimum payload`);
  }
  assert.equal(encode({ state: scene(uniqueCjk()), limit: SUSPEND_DATA_MIN_LENGTH }), null);
});

test('a limit that is not a usable number falls back to the field width', () => {
  const state = scene(uniqueCjk());
  const payload = encode({ state });

  for (const limit of [NaN, Infinity, -Infinity, 'many', {}, undefined]) {
    assert.equal(encode({ state, limit }), payload, `limit ${String(limit)} should fall back to the maximum`);
  }
  // Numeric strings and fractions are coerced towards the limit they carry.
  assert.equal(encode({ state, limit: '2000' }), payload);
  assert.equal(encode({ state, limit: payload.length + 0.9 }), payload);
  // ...while null coerces to zero and therefore floors at the minimum.
  assert.equal(encode({ state, limit: null }), null);
});

test('a payload is restored only by the activity id that wrote it', () => {
  const state = helloScene();
  const forA = encode({ state, activityId: 'Act-1' });
  const forB = encode({ state, activityId: 'Act-2' });

  assert.equal(decode(forA, 'Act-1').kind, 'state');
  assert.equal(decode(forB, 'Act-2').kind, 'state');
  assert.equal(decode(forA, 'Act-2'), null);
  assert.equal(decode(forB, 'Act-1'), null);

  // Header ids are compared exactly, after sanitising, so case and stray
  // punctuation both separate two activities.
  assert.equal(decode(forA, 'act-1'), null);
  assert.equal(decode(forA, 'Act-1 '), null);
  assert.equal(decode(forA, ''), null);

  const forDefault = encode({ state, activityId: '' });
  assert.equal(decode(forDefault, 'Act-1'), null);
  assert.equal(decode(forDefault, '').kind, 'state');

  const reference = encodeSessionReference({ activityId: 'Act-1', savedAt: SAVED_AT });
  assert.equal(decode(reference, 'Act-2'), null);
  assert.equal(decode(reference, 'Act-1').kind, 'reference');
});

test('an activity id containing the header delimiter cannot break the framing', () => {
  const state = helloScene();

  const payload = encode({ state, activityId: 'course|1' });

  assert.equal(payload.split('|')[1], 'course_1');
  assert.equal(formatOf(payload), 'J');
  assert.deepEqual(decode(payload, 'course|1').state, state);
  // Scoping follows the sanitised id, so any id that sanitises to the same
  // string — here the literal 'course_1' — is treated as the same activity.
  assert.equal(decode(payload, 'course_1').kind, 'state');
});

test('an activity id is reduced to the ASCII subset the header can carry', () => {
  assert.equal(sanitizeActivityId('12345'), '12345');
  assert.equal(sanitizeActivityId('course-1.v2_x'), 'course-1.v2_x');
  assert.equal(sanitizeActivityId('a b'), 'a_b');
  assert.equal(sanitizeActivityId('a/b\\c'), 'a_b_c');
  assert.equal(sanitizeActivityId('id|1'), 'id_1');
  assert.equal(sanitizeActivityId('héllo'), 'h_llo');
  assert.equal(sanitizeActivityId('日本'), '__');
  assert.equal(sanitizeActivityId('a🚀b'), 'a__b');
  assert.equal(sanitizeActivityId(''), '');
  assert.equal(sanitizeActivityId(null), '');
  assert.equal(sanitizeActivityId(undefined), '');
  assert.equal(sanitizeActivityId(0), '0');
  assert.equal(sanitizeActivityId(42), '42');

  const long = sanitizeActivityId('x'.repeat(5000) + '€');
  assert.equal(long, `${'x'.repeat(5000)}_`);
});

test('a very long activity id costs payload room without changing the format', () => {
  const state = helloScene();
  const activityId = 'a'.repeat(1000);

  const short = encode({ state, activityId: 'a' });
  const long = encode({ state, activityId });

  assert.equal(formatOf(long), formatOf(short));
  assert.equal(long.length, short.length + activityId.length - 1);
  assert.equal(decode(long, activityId).kind, 'state');
  assert.equal(decode(long, 'a'), null);
});

test('a reference payload decodes as a reference that carries no state', () => {
  const reference = encodeSessionReference({ activityId: 'act-1', savedAt: SAVED_AT });

  assert.equal(reference, `BS1|act-1|I|${SAVED_AT_BASE36}|`);
  assert.deepEqual(decodeSessionPayload({ payload: reference, activityId: 'act-1' }), {
    kind: 'reference',
    format: 'I',
    savedAt: SAVED_AT,
    state: null,
  });

  const bare = encodeSessionReference({ savedAt: SAVED_AT });
  assert.equal(bare, `BS1||I|${SAVED_AT_BASE36}|`);
  assert.equal(decodeSessionPayload({ payload: bare }).kind, 'reference');
});

test('foreign or truncated payloads are refused instead of throwing', (t) => {
  t.mock.method(console, 'warn', () => {});

  const stateJson = '{"scene_bundle_base64":"aGVsbG8="}';
  const foreign = [
    undefined,
    null,
    '',
    42,
    {},
    [],
    'BS1',
    'BS1|',
    `BS2||J|loyw3v28|${stateJson}`,
    `bs1||J|loyw3v28|${stateJson}`,
    'BS1||J',
    'BS1||J|loyw3v28',
    'BS1||J|loyw3v28|',
    'BS1||J|loyw3v28|{oops}',
    `BS1||j|loyw3v28|${stateJson}`,
    `BS1||X|loyw3v28|${stateJson}`,
    'BS1||B|loyw3v28|!!!!',
    'BS1||B|loyw3v28|aGVsbG8=',
    'BS1||B|loyw3v28|W10=',
    'BS1||B|loyw3v28|NQ==',
    'BS1||B|loyw3v28|e30=',
    'BS1||L|loyw3v28|!!!!',
    'BS1||L|loyw3v28|AAAAA',
    'BS1||C|loyw3v28|{"scene_bundle":{}}',
  ];

  for (const payload of foreign) {
    assert.equal(decodeSessionPayload({ payload, activityId: '' }), null, `expected ${JSON.stringify(payload)} to be refused`);
  }
  assert.equal(decodeSessionPayload(), null);
});

test('a readable body that is not a usable session state is refused', () => {
  const bodies = [
    'null',
    '5',
    '"text"',
    '[]',
    '{}',
    '{"scene_bundle_base64":5}',
    '{"scene_bundle_base64":null}',
    '{"scene_bundle_base64":[]}',
    '{"scene_bundle_base64":{}}',
    '{"scene_bundle_base64":""}',
    // A workspace payload from another package is not a scene state.
    '{"blocks":{"blocks":[]}}',
  ];

  for (const body of bodies) {
    assert.equal(decodeSessionPayload({ payload: `BS1||J|loyw3v28|${body}` }), null, body);
  }

  assert.deepEqual(decodeSessionPayload({ payload: 'BS1||J|loyw3v28|{"scene_bundle_base64":"aGVsbG8="}' }).state, {
    scene_bundle_base64: 'aGVsbG8=',
  });
});

test('a pipe inside the bundle value survives the header intact', () => {
  const state = scene('aGVs|bG8=');

  const payload = encode({ state });

  assert.equal(formatOf(payload), 'J');
  assert.equal(decode(payload).state.scene_bundle_base64, 'aGVs|bG8=');
});

test('the timestamp survives every format', () => {
  const cases = [
    ['J', helloScene()],
    ['B', scene(`${uniqueCjk()} 🚀`)],
    ['L', scene('QUJD'.repeat(990))],
  ];

  for (const [format, state] of cases) {
    const payload = encode({ state });
    assert.equal(formatOf(payload), format);
    assert.equal(decode(payload).savedAt, SAVED_AT);
  }
});

test('a zero, fractional, negative or huge timestamp is kept as written', () => {
  const state = helloScene();

  assert.equal(decode(encode({ state, savedAt: 0 })).savedAt, 0);
  assert.equal(decode(encode({ state, savedAt: 1000.9 })).savedAt, 1000);
  assert.equal(decode(encode({ state, savedAt: -5 })).savedAt, -5);
  assert.equal(decode(encode({ state, savedAt: Number.MAX_SAFE_INTEGER })).savedAt, Number.MAX_SAFE_INTEGER);
});

test('a missing or unusable timestamp falls back to the encode instant', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1700000000000 });

  for (const savedAt of [undefined, null, NaN, Infinity, '1234', {}]) {
    const payload = encodeSessionState({ activityId: 'act', state: helloScene(), savedAt });
    assert.equal(decode(payload).savedAt, 1700000000000, `savedAt ${String(savedAt)}`);
  }

  assert.equal(decode(encodeSessionState({ activityId: 'act', state: helloScene() })).savedAt, 1700000000000);
  assert.equal(
    decodeSessionPayload({ payload: encodeSessionReference() }).savedAt,
    1700000000000,
  );
});

test('encoding without a session-state object produces no payload', () => {
  for (const state of [undefined, null, 'text', 7, true, () => {}]) {
    assert.equal(encodeSessionState({ activityId: 'act', savedAt: SAVED_AT, state }), null, String(state));
  }
  assert.equal(encodeSessionState(), null);
  assert.equal(encodeSessionState({ savedAt: SAVED_AT }), null);
  assert.equal(encodeSessionState({ state: null, limit: 1e6 }), null);
});

test('compaction carries the scene state through unchanged', () => {
  const state = helloScene();
  const big = scene('QUJD'.repeat(200));

  assert.equal(compactSessionState(state), state);
  assert.equal(compactSessionState(big), big);
  assert.deepEqual(compactSessionState(big), { scene_bundle_base64: 'QUJD'.repeat(200) });
});

test('the compact format is never emitted but still decodes', () => {
  const states = [
    helloScene(),
    scene('x'),
    scene(uniqueCjk()),
    scene('QUJD'.repeat(50)),
    scene(noisyText(700)),
    scene('aGVs|bG8='),
  ];
  for (const state of states) {
    const payload = encode({ state });
    assert.ok(payload);
    assert.notEqual(formatOf(payload), 'C', 'the compact format is decode-only');
  }

  const legacy = `BS1|act|C|${SAVED_AT_BASE36}|{"scene_bundle_base64":"aGVsbG8="}`;
  assert.deepEqual(decode(legacy, 'act'), { kind: 'state', format: 'C', savedAt: SAVED_AT, state: helloScene() });
});
