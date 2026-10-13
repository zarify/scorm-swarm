import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeSwarmBundle,
  encodeSwarmBundle,
  setDeviceFlags,
  setNodeFlags,
  SwarmBundleError,
} from '../src/shared/swarm-bundle.js';

const project = {
  schemaVersion: 9,
  id: 'bundle-test',
  nested: { preserve: ['this', 7] },
  devices: [
    {
      id: 'alice',
      name: 'Alice',
      locked: false,
      positionPinned: false,
      editableProgram: { runtimeSource: 'micropython', files: { 'main.py': 'print(1)' } },
      privateExtension: { enabled: true },
    },
    { id: 'bob', name: 'Bob' },
  ],
  environmentSources: [
    { id: 'lamp', type: 'light', locked: false, positionPinned: false, intensity: 0.6 },
  ],
};

test('SWARM v2 bundles round-trip compressed and uncompressed project JSON', () => {
  for (const compress of [false, true]) {
    const bundle = encodeSwarmBundle(project, { compress });
    assert.equal(bundle[5], 2);
    assert.equal(bundle[6], compress ? 1 : 0);
    assert.deepEqual(decodeSwarmBundle(bundle), project);
  }
});

test('bundle decoder names invalid magic, version, compression, and JSON errors', () => {
  const invalidMagic = encodeSwarmBundle(project, { compress: false });
  invalidMagic[0] = 0;
  assert.throws(() => decodeSwarmBundle(invalidMagic), (error) =>
    error instanceof SwarmBundleError && /magic/i.test(error.message));

  const invalidVersion = encodeSwarmBundle(project, { compress: false });
  invalidVersion[5] = 3;
  assert.throws(() => decodeSwarmBundle(invalidVersion), (error) =>
    error instanceof SwarmBundleError && /version/i.test(error.message));

  const invalidCompression = encodeSwarmBundle(project, { compress: false });
  invalidCompression[6] = 2;
  assert.throws(() => decodeSwarmBundle(invalidCompression), (error) =>
    error instanceof SwarmBundleError && /compression/i.test(error.message));

  const invalidJson = new Uint8Array([83, 87, 65, 82, 77, 2, 0, 123, 0]);
  assert.throws(() => decodeSwarmBundle(invalidJson), (error) =>
    error instanceof SwarmBundleError && /json/i.test(error.message));
});

test('device flags omit false keys and locked devices never retain editable programs', () => {
  const locked = setDeviceFlags(project, 'alice', { locked: true, positionPinned: false });
  assert.deepEqual(locked.devices[0], {
    id: 'alice',
    name: 'Alice',
    locked: true,
    privateExtension: { enabled: true },
  });
  assert.deepEqual(locked.nested, project.nested);
  assert.deepEqual(locked.devices[1], project.devices[1]);

  const unlocked = setDeviceFlags(locked, 'alice', {
    locked: false,
    positionPinned: true,
    editableProgram: project.devices[0].editableProgram,
  });
  assert.deepEqual(unlocked.devices[0], {
    id: 'alice',
    name: 'Alice',
    positionPinned: true,
    privateExtension: { enabled: true },
    editableProgram: project.devices[0].editableProgram,
  });
});

test('node flags omit false keys and missing ids do not change the project', () => {
  const updated = setNodeFlags(project, 'lamp', { locked: true, positionPinned: false });
  assert.deepEqual(updated.environmentSources[0], {
    id: 'lamp',
    type: 'light',
    intensity: 0.6,
    locked: true,
  });
  assert.equal(setNodeFlags(project, 'missing', { locked: true }), project);
  assert.equal(setDeviceFlags(project, 'missing', { locked: true }), project);
});
