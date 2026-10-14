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

function makeConfig() {
  return {
    metadata: { activity_id: 'test-activity' },
    evaluation: {
      test_cases: [
        {
          id: 'case-1',
          points: 1,
          trigger: [
            { type: 'press_button', device_id: 'alice', button: 'A', count: 1, interval_ms: 0 },
          ],
          steps: [
            {
              type: 'check',
              condition: {
                type: 'serial_output',
                device_id: 'alice',
                match: 'contains',
                value: 'ok',
                case_sensitive: true,
                min_count: 1,
              },
              timeout_seconds: 5,
            },
          ],
        },
      ],
    },
  };
}

function invalidConfig(change) {
  const config = normalizeConfig(makeConfig());
  change(config);
  return validateConfig(config);
}

test('demo activity validates after documented defaults are normalized', () => {
  const config = normalizeConfig(demo);
  const result = validateConfig(config);
  assert.deepEqual(result, { valid: true, errors: [] });
  assert.equal(config.capabilities.move_devices, false);
  assert.deepEqual(config.panel_visibility, {
    debug_panel: false,
    radio_inspector: true,
    runtime_log: false,
    environment_values: true,
    panel_header: false,
  });
  assert.equal(Object.hasOwn(config.evaluation, 'pass_threshold'), false);
  assert.equal(config.evaluation.test_cases[0].points, 1);
  assert.ok(Array.isArray(config.evaluation.test_cases[0].trigger));
  assert.ok(Array.isArray(config.evaluation.test_cases[0].steps));
  assert.equal(config.hints[0].display_mode, 'triggered');
});

test('normalizer fills scripted test defaults', () => {
  const config = normalizeConfig({
    metadata: { activity_id: 'sparse' },
    evaluation: {
      test_cases: [
        {
          id: 'sparse',
          trigger: [{ type: 'radio_broadcast', device_id: 'alice' }],
          steps: [
            {
              type: 'check',
              condition: {
                type: 'led_display',
                layout: '.....\n.....\n.....\n.....\n.....',
              },
            },
          ],
        },
      ],
    },
  });
  const [testCase] = config.evaluation.test_cases;
  assert.equal(testCase.points, 1);
  assert.deepEqual(testCase.trigger[0], {
    type: 'radio_broadcast',
    device_id: 'alice',
    channel: null,
    group: null,
    payload: '',
    count: 1,
    interval_ms: 0,
  });
  assert.equal(testCase.steps[0].timeout_seconds, 5);
  assert.equal(testCase.steps[0].condition.device_id, null);
});

test('validator rejects unknown keys, including the removed pass threshold', () => {
  const unknownType = invalidConfig((config) => {
    config.evaluation.test_cases[0].steps[0].condition.type = 'source_code_contains';
  });
  assert.equal(unknownType.valid, false);
  assert.ok(unknownType.errors.some((error) => error.path.endsWith('.type') && /unknown condition type/.test(error.message)));

  const unknownKey = invalidConfig((config) => {
    config.evaluation.test_cases[0].trigger[0].matches_source = true;
  });
  assert.equal(unknownKey.valid, false);
  assert.ok(unknownKey.errors.some((error) => error.path.endsWith('.matches_source')));

  const threshold = invalidAfter((config) => {
    config.evaluation.pass_threshold = 80;
  });
  assert.ok(threshold.errors.some((error) => error.path === 'evaluation.pass_threshold' && /not allowed/.test(error.message)));
});

test('validator rejects legacy effect-type test cases', () => {
  const legacy = invalidConfig((config) => {
    const testCase = config.evaluation.test_cases[0];
    delete testCase.trigger;
    delete testCase.steps;
    testCase.type = 'effect';
    testCase.conditions = {
      type: 'serial_output',
      device_id: 'alice',
      match: 'contains',
      value: 'x',
      case_sensitive: true,
      min_count: 1,
    };
  });
  assert.equal(legacy.valid, false);
  assert.ok(legacy.errors.some((error) => error.path.endsWith('.type') && /not allowed/.test(error.message)));
  assert.ok(legacy.errors.some((error) => error.path.endsWith('.conditions') && /not allowed/.test(error.message)));
  assert.ok(legacy.errors.some((error) => error.path.endsWith('.trigger') && /required/.test(error.message)));
  assert.ok(legacy.errors.some((error) => error.path.endsWith('.steps') && /required/.test(error.message)));
});

test('trigger and steps must be non-empty arrays', () => {
  const emptyTrigger = invalidConfig((config) => {
    config.evaluation.test_cases[0].trigger = [];
  });
  assert.ok(emptyTrigger.errors.some((error) => error.path.endsWith('.trigger') && /at least one action/.test(error.message)));

  const emptySteps = invalidConfig((config) => {
    config.evaluation.test_cases[0].steps = [];
  });
  assert.ok(emptySteps.errors.some((error) => error.path.endsWith('.steps') && /at least one step/.test(error.message)));

  const missingTrigger = invalidConfig((config) => {
    delete config.evaluation.test_cases[0].trigger;
  });
  assert.ok(missingTrigger.errors.some((error) => error.path.endsWith('.trigger') && /required/.test(error.message)));
});

test('action validation enforces targets, enums, and bounds', () => {
  const nullDevice = invalidConfig((config) => {
    config.evaluation.test_cases[0].trigger[0].device_id = null;
  });
  assert.ok(nullDevice.errors.some((error) => error.path.endsWith('.device_id') && /must reference a scene device/.test(error.message)));

  const emptyDevice = invalidConfig((config) => {
    config.evaluation.test_cases[0].trigger[0].device_id = '';
  });
  assert.ok(emptyDevice.errors.some((error) => error.path.endsWith('.device_id') && /must reference a scene device/.test(error.message)));

  const nullNode = invalidConfig((config) => {
    config.evaluation.test_cases[0].trigger[0] = { type: 'set_node_level', node_id: null, value: 5 };
  });
  assert.ok(nullNode.errors.some((error) => error.path.endsWith('.node_id') && /must reference a scene node/.test(error.message)));

  const missingDevice = invalidConfig((config) => {
    delete config.evaluation.test_cases[0].trigger[0].device_id;
  });
  assert.ok(missingDevice.errors.some((error) => error.path.endsWith('.device_id') && /must reference a scene device/.test(error.message)));

  const missingNode = invalidConfig((config) => {
    config.evaluation.test_cases[0].trigger[0] = { type: 'set_node_level', value: 5 };
  });
  assert.ok(missingNode.errors.some((error) => error.path.endsWith('.node_id') && /must reference a scene node/.test(error.message)));

  const badButton = invalidConfig((config) => {
    config.evaluation.test_cases[0].trigger[0].button = 'C';
  });
  assert.ok(badButton.errors.some((error) => error.path.endsWith('.button')));

  const badCount = invalidConfig((config) => {
    config.evaluation.test_cases[0].trigger[0].count = 0;
  });
  assert.ok(badCount.errors.some((error) => error.path.endsWith('.count')));

  const badInterval = invalidConfig((config) => {
    config.evaluation.test_cases[0].trigger[0].interval_ms = -1;
  });
  assert.ok(badInterval.errors.some((error) => error.path.endsWith('.interval_ms')));

  const badNodeType = invalidConfig((config) => {
    config.evaluation.test_cases[0].trigger.push({
      type: 'add_node', node_type: 'robot', x: 1, y: 2, level: null, duration_seconds: 10,
    });
  });
  assert.ok(badNodeType.errors.some((error) => error.path.endsWith('.node_type')));

  const badDuration = invalidConfig((config) => {
    config.evaluation.test_cases[0].trigger.push({
      type: 'add_node', node_type: 'light', x: 1, y: 2, level: null, duration_seconds: -1,
    });
  });
  assert.ok(badDuration.errors.some((error) => error.path.endsWith('.duration_seconds')));

  const unknownAction = invalidConfig((config) => {
    config.evaluation.test_cases[0].trigger[0].type = 'teleport';
  });
  assert.ok(unknownAction.errors.some((error) => error.path.endsWith('.type') && /unknown action type/.test(error.message)));
});

test('check steps validate conditions and timeouts; action steps validate actions', () => {
  const badTimeout = invalidConfig((config) => {
    config.evaluation.test_cases[0].steps[0].timeout_seconds = -1;
  });
  assert.ok(badTimeout.errors.some((error) => error.path.endsWith('.timeout_seconds')));

  const unknownStepKey = invalidConfig((config) => {
    config.evaluation.test_cases[0].steps[0].conditions = {};
  });
  assert.ok(unknownStepKey.errors.some((error) => error.path.endsWith('.conditions') && /not allowed/.test(error.message)));

  const badStepType = invalidConfig((config) => {
    config.evaluation.test_cases[0].steps[0].type = 'effect';
  });
  assert.ok(badStepType.errors.some((error) => error.path.endsWith('.type') && /must be "action" or "check"/.test(error.message)));

  const actionStep = invalidConfig((config) => {
    config.evaluation.test_cases[0].steps.push({
      type: 'action',
      action: { type: 'radio_broadcast', device_id: null, channel: null, group: null, payload: '', count: 1, interval_ms: 0 },
    });
  });
  assert.ok(actionStep.errors.some((error) =>
    error.path.includes('.steps[1].action.device_id') && /must reference a scene device/.test(error.message)));
});

test('led_display conditions validate layout and characters', () => {
  const valid = invalidConfig((config) => {
    config.evaluation.test_cases[0].steps[0].condition = {
      type: 'led_display',
      device_id: 'alice',
      layout: '.....\n..#..\n#####\n..#..\n..#..',
    };
  });
  assert.deepEqual(valid, { valid: true, errors: [] });

  const badLayout = invalidConfig((config) => {
    config.evaluation.test_cases[0].steps[0].condition = {
      type: 'led_display',
      device_id: 'alice',
      layout: '..#..\n.....',
    };
  });
  assert.equal(badLayout.valid, false);
  assert.ok(badLayout.errors.some((error) => error.path.endsWith('.layout')));

  const badChars = invalidConfig((config) => {
    config.evaluation.test_cases[0].steps[0].condition = {
      type: 'led_display',
      device_id: 'alice',
      layout: '..x..\n.....\n.....\n.....\n.....',
    };
  });
  assert.ok(badChars.errors.some((error) => error.path.endsWith('.layout')));
});

test('panel visibility options require booleans and reject unknown fields', () => {
  const nonBoolean = invalidAfter((config) => {
    config.panel_visibility.runtime_log = 'enabled';
  });
  assert.ok(nonBoolean.errors.some((error) => error.path === 'panel_visibility.runtime_log' && /must be a boolean/.test(error.message)));

  const unknown = invalidAfter((config) => {
    config.panel_visibility.sidebar = true;
  });
  assert.ok(unknown.errors.some((error) => error.path === 'panel_visibility.sidebar' && /not allowed/.test(error.message)));
});

test('validator enforces positive event counts and numeric ordering in check conditions', () => {
  const minCount = invalidConfig((config) => {
    config.evaluation.test_cases[0].steps[0].condition.min_count = 0;
  });
  assert.equal(minCount.valid, false);
  assert.ok(minCount.errors.some((error) => error.path.endsWith('.min_count')));

  const rssi = invalidConfig((config) => {
    config.evaluation.test_cases[0].steps[0].condition = {
      type: 'radio_rx',
      device_id: 'bob',
      from_device_id: 'alice',
      channel: null,
      group: 42,
      payload: null,
      rssi_min: -20,
      rssi_max: -50,
      min_count: 1,
    };
  });
  assert.ok(rssi.errors.some((error) => /rssi_min/.test(error.message)));

  const sensor = invalidConfig((config) => {
    config.evaluation.test_cases[0].steps[0].condition = {
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
  const empty = invalidConfig((config) => {
    config.evaluation.test_cases[0].steps[0].condition = { type: 'none', conditions: [] };
  });
  assert.ok(empty.errors.some((error) => /at least one child/.test(error.message)));

  const duplicate = invalidAfter((config) => {
    config.hints[0].id = config.evaluation.test_cases[0].id;
  });
  assert.ok(duplicate.errors.some((error) => /duplicate id/.test(error.message)));

  const noTests = invalidConfig((config) => {
    config.evaluation.test_cases = [];
  });
  assert.ok(noTests.errors.some((error) => /at least one test case/.test(error.message)));
});
