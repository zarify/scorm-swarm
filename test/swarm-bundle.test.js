import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  decodeSwarmBundle,
  encodeSwarmBundle,
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
