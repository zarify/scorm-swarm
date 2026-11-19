import schema from './activity-config.schema.json' with { type: 'json' };

const CONDITION_SCHEMAS = {
  all: schema.$defs.composite,
  any: schema.$defs.composite,
  none: schema.$defs.composite,
  serial_output: schema.$defs.serialOutput,
  button_press: schema.$defs.buttonPress,
  radio_tx: schema.$defs.radioTx,
  radio_rx: schema.$defs.radioRx,
  sensor_reading: schema.$defs.sensorReading,
  led_display: schema.$defs.ledDisplay,
  node_distance: schema.$defs.nodeDistance,
};

const CHECK_ONLY_CONDITION_TYPES = ['node_distance'];

const ACTION_SCHEMAS = {
  radio_broadcast: schema.$defs.actionRadioBroadcast,
  press_button: schema.$defs.actionPressButton,
  set_node_level: schema.$defs.actionSetNodeLevel,
  add_node: schema.$defs.actionAddNode,
  move_node: schema.$defs.actionMoveNode,
};

const ALLOWED_FIELDS = {
  root: schema.properties,
  metadata: schema.properties.metadata.properties,
  capabilities: schema.properties.capabilities.properties,
  panel_visibility: schema.properties.panel_visibility.properties,
  evaluation: schema.properties.evaluation.properties,
  testCase: schema.$defs.testCase.properties,
  testStep: {
    action: schema.$defs.stepAction.properties,
    check: schema.$defs.stepCheck.properties,
  },
  hint: schema.$defs.hint.properties,
  hintTrigger: schema.$defs.hintTrigger.properties,
  condition: Object.fromEntries(
    Object.entries(CONDITION_SCHEMAS).map(([type, conditionSchema]) => [
      type,
      conditionSchema.properties,
    ]),
  ),
  action: Object.fromEntries(
    Object.entries(ACTION_SCHEMAS).map(([type, actionSchema]) => [
      type,
      actionSchema.properties,
    ]),
  ),
  payload: schema.$defs.payloadMatch.properties,
  nodeRef: schema.$defs.nodeRef.properties,
};

export const VALID_CONDITION_TYPES = Object.keys(CONDITION_SCHEMAS);
export const VALID_CHECK_ONLY_CONDITION_TYPES = CHECK_ONLY_CONDITION_TYPES;
export const VALID_ACTION_TYPES = Object.keys(ACTION_SCHEMAS);
export const VALID_NODE_TYPES = schema.$defs.actionAddNode.properties.node_type.enum;
export const VALID_ACTION_BUTTONS = schema.$defs.actionPressButton.properties.button.enum;
export const VALID_LAYOUT_PATTERN = schema.$defs.ledDisplay.properties.layout.pattern;
export const VALID_HINT_EVENTS = schema.$defs.hintTrigger.properties.event.enum;
export const VALID_HINT_DISPLAY_MODES = schema.$defs.hint.properties.display_mode.enum;
export const VALID_HINT_STYLES = schema.$defs.hint.properties.style.enum;
export const VALID_SENSOR_TYPES = schema.$defs.sensorReading.properties.sensor.enum;

const STRING_MATCHES = schema.$defs.serialOutput.properties.match.enum;
const PAYLOAD_MATCHES = schema.$defs.payloadMatch.properties.match.enum;
const BUTTONS = schema.$defs.buttonPress.properties.button.enum;
const CANVAS_WIDTH = 860;
const CANVAS_HEIGHT = 520;

export function validateConfig(config) {
  const errors = [];
  if (!isObject(config)) {
    return result([{ path: '', message: 'must be an object' }]);
  }
  rejectUnknown(config, ALLOWED_FIELDS.root, '', errors);

  if (!isObject(config.metadata)) {
    errors.push({ path: 'metadata', message: 'is required and must be an object' });
  } else {
    validateMetadata(config.metadata, errors);
  }

  if (config.capabilities !== undefined) {
    if (!isObject(config.capabilities)) {
      errors.push({ path: 'capabilities', message: 'must be an object' });
    } else {
      rejectUnknown(config.capabilities, ALLOWED_FIELDS.capabilities, 'capabilities', errors);
      for (const field of Object.keys(ALLOWED_FIELDS.capabilities)) {
        if (config.capabilities[field] !== undefined && typeof config.capabilities[field] !== 'boolean') {
          errors.push({ path: `capabilities.${field}`, message: 'must be a boolean' });
        }
      }
    }
  }
  if (config.panel_visibility !== undefined) {
    if (!isObject(config.panel_visibility)) {
      errors.push({ path: 'panel_visibility', message: 'must be an object' });
    } else {
      rejectUnknown(config.panel_visibility, ALLOWED_FIELDS.panel_visibility, 'panel_visibility', errors);
      for (const field of Object.keys(ALLOWED_FIELDS.panel_visibility)) {
        if (config.panel_visibility[field] !== undefined && typeof config.panel_visibility[field] !== 'boolean') {
          errors.push({ path: `panel_visibility.${field}`, message: 'must be a boolean' });
        }
      }
    }
  }

  if (!isObject(config.evaluation)) {
    errors.push({ path: 'evaluation', message: 'is required and must be an object' });
  } else {
    validateEvaluation(config.evaluation, errors);
  }

  if (config.hints !== undefined && !Array.isArray(config.hints)) {
    errors.push({ path: 'hints', message: 'must be an array' });
  }
  const testCases = isObject(config.evaluation) && Array.isArray(config.evaluation.test_cases)
    ? config.evaluation.test_cases
    : [];
  const hints = Array.isArray(config.hints) ? config.hints : [];
  const ids = new Set();
  testCases.forEach((testCase, index) => {
    validateTestCaseInto(testCase, `evaluation.test_cases[${index}]`, errors);
    recordUniqueId(testCase, `evaluation.test_cases[${index}].id`, ids, errors);
  });
  hints.forEach((hint, index) => {
    validateHintInto(hint, `hints[${index}]`, errors);
    recordUniqueId(hint, `hints[${index}].id`, ids, errors);
  });

  return result(errors);
}

export function validateCondition(condition, path = 'conditions') {
  const errors = [];
  validateConditionInto(condition, path, errors);
  return result(errors);
}

export function validateTestCaseConfig(testCase, index = 0) {
  const errors = [];
  validateTestCaseInto(testCase, `evaluation.test_cases[${index}]`, errors);
  return result(errors);
}

export function validateHintConfig(hint, index = 0) {
  const errors = [];
  validateHintInto(hint, `hints[${index}]`, errors);
  return result(errors);
}

function validateMetadata(metadata, errors) {
  rejectUnknown(metadata, ALLOWED_FIELDS.metadata, 'metadata', errors);
  if (typeof metadata.activity_id !== 'string') {
    errors.push({ path: 'metadata.activity_id', message: 'is required and must be a string' });
  } else if (!/^[a-z0-9_-]+$/.test(metadata.activity_id)) {
    errors.push({ path: 'metadata.activity_id', message: 'must match ^[a-z0-9_-]+$' });
  }
  for (const field of [
    'title',
    'instructions_markdown',
    'learning_objectives_markdown',
    'teacher_notes_markdown',
  ]) {
    if (metadata[field] !== undefined && typeof metadata[field] !== 'string') {
      errors.push({ path: `metadata.${field}`, message: 'must be a string' });
    }
  }
}

function validateEvaluation(evaluation, errors) {
  rejectUnknown(evaluation, ALLOWED_FIELDS.evaluation, 'evaluation', errors);
  if (!Array.isArray(evaluation.test_cases)) {
    errors.push({ path: 'evaluation.test_cases', message: 'is required and must be an array' });
  } else if (evaluation.test_cases.length < 1) {
    errors.push({ path: 'evaluation.test_cases', message: 'must contain at least one test case' });
  }
}

function validateTestCaseInto(testCase, path, errors) {
  if (!isObject(testCase)) {
    errors.push({ path, message: 'must be an object' });
    return;
  }
  rejectUnknown(testCase, ALLOWED_FIELDS.testCase, path, errors);
  requireString(testCase, 'id', path, errors);
  if (testCase.points !== undefined && (!Number.isInteger(testCase.points) || testCase.points < 0)) {
    errors.push({ path: `${path}.points`, message: 'must be an integer greater than or equal to 0' });
  }
  for (const field of ['feedback_on_pass', 'feedback_on_fail']) {
    if (testCase[field] !== undefined && typeof testCase[field] !== 'string') {
      errors.push({ path: `${path}.${field}`, message: 'must be a string' });
    }
  }
  if (!Array.isArray(testCase.trigger)) {
    errors.push({ path: `${path}.trigger`, message: 'is required and must be an array' });
  } else {
    testCase.trigger.forEach((action, index) =>
      validateActionInto(action, `${path}.trigger[${index}]`, errors),
    );
  }
  if (!Array.isArray(testCase.steps)) {
    errors.push({ path: `${path}.steps`, message: 'is required and must be an array' });
  } else if (testCase.steps.length < 1) {
    errors.push({ path: `${path}.steps`, message: 'must contain at least one step' });
  } else {
    testCase.steps.forEach((step, index) =>
      validateStepInto(step, `${path}.steps[${index}]`, errors),
    );
  }
}

function validateActionInto(action, path, errors) {
  if (!isObject(action)) {
    errors.push({ path, message: 'must be an object' });
    return;
  }
  const type = action.type;
  if (!VALID_ACTION_TYPES.includes(type)) {
    errors.push({ path: `${path}.type`, message: `unknown action type: ${String(type)}` });
    return;
  }
  rejectUnknown(action, ALLOWED_FIELDS.action[type], path, errors);

  if (type === 'radio_broadcast' || type === 'press_button') {
    validateActionTarget(action.device_id, `${path}.device_id`, 'device', errors);
  }
  if (type === 'radio_broadcast') {
    validateNullableInteger(action.channel, `${path}.channel`, errors);
    validateNullableInteger(action.group, `${path}.group`, errors);
    if (action.payload !== undefined && typeof action.payload !== 'string') {
      errors.push({ path: `${path}.payload`, message: 'must be a string' });
    }
  }
  if (type === 'press_button') {
    if (action.button !== undefined && !VALID_ACTION_BUTTONS.includes(action.button)) {
      errors.push({ path: `${path}.button`, message: 'must be "A", "B", or "AB"' });
    }
  }
  if (type === 'radio_broadcast' || type === 'press_button') {
    validateMinCount(action.count, `${path}.count`, errors);
    if (action.interval_ms !== undefined && (!Number.isInteger(action.interval_ms) || action.interval_ms < 0)) {
      errors.push({ path: `${path}.interval_ms`, message: 'must be an integer greater than or equal to 0' });
    }
  }
  if (type === 'set_node_level') {
    validateActionTarget(action.node_id, `${path}.node_id`, 'node', errors);
    if (action.value === undefined || !isFiniteNumber(action.value)) {
      errors.push({ path: `${path}.value`, message: 'is required and must be a finite number' });
    }
  }
  if (type === 'move_node') {
    validateActionTarget(action.node_id, `${path}.node_id`, 'node', errors);
    for (const [field, maximum] of [['x', CANVAS_WIDTH], ['y', CANVAS_HEIGHT]]) {
      const value = action[field];
      if (!isFiniteNumber(value)) {
        errors.push({ path: `${path}.${field}`, message: 'is required and must be a finite number' });
      } else if (value < 0 || value > maximum) {
        errors.push({ path: `${path}.${field}`, message: `must be between 0 and ${maximum}` });
      }
    }
  }
  if (type === 'add_node') {
    if (!VALID_NODE_TYPES.includes(action.node_type)) {
      errors.push({ path: `${path}.node_type`, message: 'must be "light", "sound", "temperature", or "magnet"' });
    }
    for (const field of ['x', 'y']) {
      if (action[field] === undefined || !isFiniteNumber(action[field])) {
        errors.push({ path: `${path}.${field}`, message: 'is required and must be a finite number' });
      }
    }
    validateNullableNumber(action.level, `${path}.level`, errors);
    if (action.duration_seconds !== undefined && !isNonNegativeNumber(action.duration_seconds)) {
      errors.push({ path: `${path}.duration_seconds`, message: 'must be a non-negative number' });
    }
  }
}

function validateStepInto(step, path, errors) {
  if (!isObject(step)) {
    errors.push({ path, message: 'must be an object' });
    return;
  }
  const type = step.type;
  if (type !== 'action' && type !== 'check') {
    errors.push({ path: `${path}.type`, message: 'must be "action" or "check"' });
    return;
  }
  rejectUnknown(step, ALLOWED_FIELDS.testStep[type], path, errors);
  if (type === 'action') {
    if (step.action === undefined) {
      errors.push({ path: `${path}.action`, message: 'is required' });
    } else {
      validateActionInto(step.action, `${path}.action`, errors);
    }
    return;
  }
  if (step.condition === undefined) {
    errors.push({ path: `${path}.condition`, message: 'is required' });
  } else {
    validateConditionInto(step.condition, `${path}.condition`, errors, true);
  }
  if (step.timeout_ms !== undefined && !isNonNegativeNumber(step.timeout_ms)) {
    errors.push({ path: `${path}.timeout_ms`, message: 'must be a non-negative number' });
  }
}

function validateActionTarget(value, path, kind, errors) {
  if (value === undefined || value === null || (typeof value === 'string' && value.trim() === '')) {
    errors.push({
      path,
      message: kind === 'device' ? 'must reference a scene device' : 'must reference a scene node',
    });
    return;
  }
  if (typeof value !== 'string') {
    errors.push({ path, message: 'must be a string' });
  }
}

function validateHintInto(hint, path, errors) {
  if (!isObject(hint)) {
    errors.push({ path, message: 'must be an object' });
    return;
  }
  rejectUnknown(hint, ALLOWED_FIELDS.hint, path, errors);
  requireString(hint, 'id', path, errors);
  requireString(hint, 'message', path, errors);

  if (hint.priority !== undefined && (!Number.isInteger(hint.priority) || hint.priority < 1)) {
    errors.push({ path: `${path}.priority`, message: 'must be an integer greater than or equal to 1' });
  }
  if (hint.delay_seconds !== undefined && !isNonNegativeNumber(hint.delay_seconds)) {
    errors.push({ path: `${path}.delay_seconds`, message: 'must be a non-negative number' });
  }
  if (hint.show_once !== undefined && typeof hint.show_once !== 'boolean') {
    errors.push({ path: `${path}.show_once`, message: 'must be a boolean' });
  }
  if (hint.display_mode !== undefined && !VALID_HINT_DISPLAY_MODES.includes(hint.display_mode)) {
    errors.push({ path: `${path}.display_mode`, message: 'must be "triggered" or "checklist"' });
  }
  if (hint.style !== undefined && !VALID_HINT_STYLES.includes(hint.style)) {
    errors.push({ path: `${path}.style`, message: 'must be "info", "success", or "warning"' });
  }

  const triggerPath = `${path}.trigger`;
  if (!isObject(hint.trigger)) {
    errors.push({ path: triggerPath, message: 'is required and must be an object' });
    return;
  }
  const trigger = hint.trigger;
  rejectUnknown(trigger, ALLOWED_FIELDS.hintTrigger, triggerPath, errors);
  if (!VALID_HINT_EVENTS.includes(trigger.event)) {
    errors.push({ path: `${triggerPath}.event`, message: 'must be "sim_event", "test_fail", or "manual"' });
  }
  if (trigger.after_attempts !== undefined &&
      (!Number.isInteger(trigger.after_attempts) || trigger.after_attempts < 0)) {
    errors.push({ path: `${triggerPath}.after_attempts`, message: 'must be a non-negative integer' });
  }
  if (trigger.invalidate_on_condition_false !== undefined &&
      typeof trigger.invalidate_on_condition_false !== 'boolean') {
    errors.push({ path: `${triggerPath}.invalidate_on_condition_false`, message: 'must be a boolean' });
  }
  if (trigger.conditions === undefined) {
    errors.push({ path: `${triggerPath}.conditions`, message: 'is required' });
  } else {
    validateConditionInto(trigger.conditions, `${triggerPath}.conditions`, errors);
  }
}

function validateConditionInto(condition, path, errors, allowNodeDistance = false) {
  if (!isObject(condition)) {
    errors.push({ path, message: 'must be an object' });
    return;
  }
  const type = condition.type;
  if (!VALID_CONDITION_TYPES.includes(type)) {
    errors.push({ path: `${path}.type`, message: `unknown condition type: ${String(type)}` });
    return;
  }
  if (!allowNodeDistance && CHECK_ONLY_CONDITION_TYPES.includes(type)) {
    errors.push({
      path: `${path}.type`,
      message: `${type} can only be used in a test check step`,
    });
    return;
  }
  rejectUnknown(condition, ALLOWED_FIELDS.condition[type], path, errors);

  if (type === 'all' || type === 'any' || type === 'none') {
    if (!Array.isArray(condition.conditions)) {
      errors.push({ path: `${path}.conditions`, message: 'must be an array' });
      return;
    }
    if (condition.conditions.length < 1) {
      errors.push({ path: `${path}.conditions`, message: 'must contain at least one child condition' });
    }
    condition.conditions.forEach((child, index) =>
      validateConditionInto(child, `${path}.conditions[${index}]`, errors, allowNodeDistance),
    );
    return;
  }

  if (type === 'node_distance') {
    validateNodeDistance(condition, path, errors);
    return;
  }

  validateDeviceId(condition.device_id, `${path}.device_id`, errors);
  if (type === 'serial_output') {
    if (!STRING_MATCHES.includes(condition.match)) {
      errors.push({ path: `${path}.match`, message: 'must be "contains", "exact", or "regex"' });
    }
    requireString(condition, 'value', path, errors);
    validateCaseSensitive(condition.case_sensitive, `${path}.case_sensitive`, errors);
    validateMinCount(condition.min_count, `${path}.min_count`, errors);
    if (condition.match === 'regex' && typeof condition.value === 'string') {
      validateRegex(condition.value, `${path}.value`, errors);
    }
    return;
  }
  if (type === 'button_press') {
    if (condition.button !== undefined && !BUTTONS.includes(condition.button)) {
      errors.push({ path: `${path}.button`, message: 'must be "A", "B", "AB", or "any"' });
    }
    validateMinCount(condition.min_count, `${path}.min_count`, errors);
    return;
  }
  if (type === 'radio_tx' || type === 'radio_rx') {
    validateNullableInteger(condition.channel, `${path}.channel`, errors);
    validateNullableInteger(condition.group, `${path}.group`, errors);
    validatePayload(condition.payload, `${path}.payload`, errors);
    validateMinCount(condition.min_count, `${path}.min_count`, errors);
    if (type === 'radio_rx') {
      if (condition.from_device_id !== undefined && condition.from_device_id !== null &&
          typeof condition.from_device_id !== 'string') {
        errors.push({ path: `${path}.from_device_id`, message: 'must be a string or null' });
      }
      validateNullableNumber(condition.rssi_min, `${path}.rssi_min`, errors);
      validateNullableNumber(condition.rssi_max, `${path}.rssi_max`, errors);
      if (isFiniteNumber(condition.rssi_min) && isFiniteNumber(condition.rssi_max) &&
          condition.rssi_min > condition.rssi_max) {
        errors.push({ path, message: 'rssi_min must be less than or equal to rssi_max' });
      }
    }
    return;
  }

  if (type === 'led_display') {
    if (typeof condition.layout !== 'string' || !new RegExp(VALID_LAYOUT_PATTERN).test(condition.layout)) {
      errors.push({ path: `${path}.layout`, message: 'must be five rows of five characters (#/1 lit, ./0 unlit) separated by newlines' });
    }
    return;
  }

  if (!VALID_SENSOR_TYPES.includes(condition.sensor)) {
    errors.push({ path: `${path}.sensor`, message: 'must name a supported sensor' });
  }
  validateNullableNumber(condition.min, `${path}.min`, errors);
  validateNullableNumber(condition.max, `${path}.max`, errors);
  if (isFiniteNumber(condition.min) && isFiniteNumber(condition.max) && condition.min > condition.max) {
    errors.push({ path, message: 'min must be less than or equal to max' });
  }
  if (condition.min_duration_seconds !== undefined && !isNonNegativeNumber(condition.min_duration_seconds)) {
    errors.push({ path: `${path}.min_duration_seconds`, message: 'must be a non-negative number' });
  }
}

function validateNodeDistance(condition, path, errors) {
  const endpoints = [];
  for (const field of ['node_a', 'node_b']) {
    const ref = condition[field];
    const refPath = `${path}.${field}`;
    if (!isObject(ref)) {
      errors.push({ path: refPath, message: 'is required and must be an object' });
      endpoints.push(null);
      continue;
    }
    rejectUnknown(ref, ALLOWED_FIELDS.nodeRef, refPath, errors);
    if (ref.kind !== 'device' && ref.kind !== 'source') {
      errors.push({ path: `${refPath}.kind`, message: 'must be "device" or "source"' });
    }
    if (typeof ref.id !== 'string' || ref.id.trim() === '') {
      errors.push({ path: `${refPath}.id`, message: 'must be a non-blank scene object id' });
    }
    endpoints.push(ref);
  }
  if (endpoints[0] && endpoints[1] &&
      endpoints[0].kind === endpoints[1].kind && endpoints[0].id === endpoints[1].id) {
    errors.push({ path, message: 'node_a and node_b must be different objects' });
  }

  const hasMin = condition.min !== undefined && condition.min !== null;
  const hasMax = condition.max !== undefined && condition.max !== null;
  for (const field of ['min', 'max']) {
    if (condition[field] === undefined || condition[field] === null) continue;
    if (!isFiniteNumber(condition[field])) {
      errors.push({ path: `${path}.${field}`, message: 'must be a finite number or null' });
    } else if (condition[field] < 0) {
      errors.push({ path: `${path}.${field}`, message: 'must be greater than or equal to 0' });
    }
  }
  if (!hasMin && !hasMax) {
    errors.push({ path, message: 'needs a minimum or maximum distance' });
  }
  if (hasMin && hasMax && isFiniteNumber(condition.min) && isFiniteNumber(condition.max) &&
      condition.min > condition.max) {
    errors.push({ path, message: 'min must be less than or equal to max' });
  }
}

function validatePayload(payload, path, errors) {
  if (payload === undefined || payload === null) return;
  if (!isObject(payload)) {
    errors.push({ path, message: 'must be an object or null' });
    return;
  }
  rejectUnknown(payload, ALLOWED_FIELDS.payload, path, errors);
  if (!PAYLOAD_MATCHES.includes(payload.match)) {
    errors.push({ path: `${path}.match`, message: 'must be "contains", "exact", "regex", or "hex"' });
  }
  requireString(payload, 'value', path, errors);
  validateCaseSensitive(payload.case_sensitive, `${path}.case_sensitive`, errors);
  if (payload.match === 'regex' && typeof payload.value === 'string') {
    validateRegex(payload.value, `${path}.value`, errors);
  }
  if (payload.match === 'hex' && typeof payload.value === 'string' && !/^(?:[0-9a-fA-F]{2})*$/.test(payload.value)) {
    errors.push({ path: `${path}.value`, message: 'must contain an even number of hexadecimal digits' });
  }
}

function validateRegex(value, path, errors) {
  try {
    new RegExp(value);
  } catch (error) {
    errors.push({ path, message: `invalid regular expression: ${error.message}` });
  }
}

function validateDeviceId(value, path, errors) {
  if (value !== null && typeof value !== 'string') {
    errors.push({ path, message: 'must be a string or null' });
  }
}

function validateMinCount(value, path, errors) {
  if (value !== undefined && (!Number.isInteger(value) || value < 1)) {
    errors.push({ path, message: 'must be an integer greater than or equal to 1' });
  }
}

function validateCaseSensitive(value, path, errors) {
  if (value !== undefined && typeof value !== 'boolean') {
    errors.push({ path, message: 'must be a boolean' });
  }
}

function validateNullableInteger(value, path, errors) {
  if (value !== undefined && value !== null && !Number.isInteger(value)) {
    errors.push({ path, message: 'must be an integer or null' });
  }
}

function validateNullableNumber(value, path, errors) {
  if (value !== undefined && value !== null && !isFiniteNumber(value)) {
    errors.push({ path, message: 'must be a finite number or null' });
  }
}

function requireString(object, field, path, errors) {
  if (typeof object[field] !== 'string') {
    errors.push({ path: `${path}.${field}`, message: 'is required and must be a string' });
  }
}

function rejectUnknown(object, allowedFields, path, errors) {
  for (const key of Object.keys(object)) {
    if (!Object.prototype.hasOwnProperty.call(allowedFields, key)) {
      errors.push({ path: path ? `${path}.${key}` : key, message: 'is not allowed' });
    }
  }
}

function recordUniqueId(value, path, ids, errors) {
  if (!isObject(value) || typeof value.id !== 'string') return;
  if (ids.has(value.id)) {
    errors.push({ path, message: `duplicate id: ${value.id}` });
  } else {
    ids.add(value.id);
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeNumber(value) {
  return isFiniteNumber(value) && value >= 0;
}

function result(errors) {
  return { valid: errors.length === 0, errors };
}
