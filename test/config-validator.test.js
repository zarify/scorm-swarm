import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { normalizeConfig } from '../src/shared/config-normalizer.js';
import { validateConfig } from '../src/shared/config-validator.js';

const demo = JSON.parse(readFileSync(fileURLToPath(new URL('../examples/demo-activity.json', import.meta.url)), 'utf8'));

function invalidAfter(change) {
  const config = normalizeConfig(structuredClone(demo));
  change(config);
  return validateConfig(config);
}

test('demo activity validates after documented defaults are normalized', () => {
  const config = normalizeConfig(demo);
  const result = validateConfig(config);
  assert.deepEqual(result, { valid: true, errors: [] });
  assert.equal(config.capabilities.move_devices, false);
  assert.equal(config.evaluation.pass_threshold, 80);
  assert.equal(config.evaluation.test_cases[0].points, 1);
  assert.equal(config.hints[0].display_mode, 'triggered');
});

test('validator rejects unknown keys and condition types', () => {
  const unknownType = invalidAfter((config) => {
    config.evaluation.test_cases[0].conditions.type = 'source_code_contains';
  });
  assert.equal(unknownType.valid, false);
  assert.ok(unknownType.errors.some((error) => error.path.endsWith('.type') && /unknown condition type/.test(error.message)));

  const unknownKey = invalidAfter((config) => {
    config.evaluation.test_cases[0].conditions.matches_source = true;
  });
  assert.equal(unknownKey.valid, false);
  assert.ok(unknownKey.errors.some((error) => error.path.endsWith('.matches_source')));
});

test('validator enforces positive event counts and numeric interval ordering', () => {
  const count = invalidAfter((config) => {
    config.evaluation.test_cases[0].conditions.min_count = 0;
  });
  assert.equal(count.valid, false);
  assert.ok(count.errors.some((error) => error.path.endsWith('.min_count')));

  const rssi = invalidAfter((config) => {
    config.evaluation.test_cases[1].conditions.rssi_min = -20;
    config.evaluation.test_cases[1].conditions.rssi_max = -50;
  });
  assert.ok(rssi.errors.some((error) => /rssi_min/.test(error.message)));

  const sensor = invalidAfter((config) => {
    config.evaluation.test_cases[0].conditions = {
      type: 'sensor_reading',
      device_id: null,
      sensor: 'lightLevel',
      min: 80,
      max: 10,
    };
  });
  assert.ok(sensor.errors.some((error) => /min must be less than or equal to max/.test(error.message)));
});

test('validator rejects empty composites, duplicate ids, and activities without tests', () => {
  const empty = invalidAfter((config) => {
    config.evaluation.test_cases[0].conditions = { type: 'none', conditions: [] };
  });
  assert.ok(empty.errors.some((error) => /at least one child/.test(error.message)));

  const duplicate = invalidAfter((config) => {
    config.hints[0].id = config.evaluation.test_cases[0].id;
  });
  assert.ok(duplicate.errors.some((error) => /duplicate id/.test(error.message)));

  const noTests = invalidAfter((config) => {
    config.evaluation.test_cases = [];
  });
  assert.ok(noTests.errors.some((error) => /at least one test case/.test(error.message)));
});
