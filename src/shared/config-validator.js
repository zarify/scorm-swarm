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
};

const ALLOWED_FIELDS = {
  root: schema.properties,
  metadata: schema.properties.metadata.properties,
  capabilities: schema.properties.capabilities.properties,
  evaluation: schema.properties.evaluation.properties,
  testCase: schema.$defs.testCase.properties,
  hint: schema.$defs.hint.properties,
  hintTrigger: schema.$defs.hintTrigger.properties,
  condition: Object.fromEntries(
    Object.entries(CONDITION_SCHEMAS).map(([type, conditionSchema]) => [
      type,
      conditionSchema.properties,
    ]),
  ),
  payload: schema.$defs.payloadMatch.properties,
};

export const VALID_CONDITION_TYPES = Object.keys(CONDITION_SCHEMAS);
export const VALID_HINT_EVENTS = schema.$defs.hintTrigger.properties.event.enum;
export const VALID_HINT_DISPLAY_MODES = schema.$defs.hint.properties.display_mode.enum;
export const VALID_HINT_STYLES = schema.$defs.hint.properties.style.enum;
export const VALID_SENSOR_TYPES = schema.$defs.sensorReading.properties.sensor.enum;

const STRING_MATCHES = schema.$defs.serialOutput.properties.match.enum;
const PAYLOAD_MATCHES = schema.$defs.payloadMatch.properties.match.enum;
const BUTTONS = schema.$defs.buttonPress.properties.button.enum;

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
  if (evaluation.pass_threshold !== undefined &&
      (!Number.isInteger(evaluation.pass_threshold) || evaluation.pass_threshold < 0 || evaluation.pass_threshold > 100)) {
    errors.push({ path: 'evaluation.pass_threshold', message: 'must be an integer from 0 to 100' });
  }
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
  if (testCase.type !== 'effect') errors.push({ path: `${path}.type`, message: 'must be "effect"' });
  if (testCase.points !== undefined && (!Number.isInteger(testCase.points) || testCase.points < 0)) {
    errors.push({ path: `${path}.points`, message: 'must be an integer greater than or equal to 0' });
  }
  for (const field of ['feedback_on_pass', 'feedback_on_fail']) {
    if (testCase[field] !== undefined && typeof testCase[field] !== 'string') {
      errors.push({ path: `${path}.${field}`, message: 'must be a string' });
    }
  }
  if (testCase.conditions === undefined) {
    errors.push({ path: `${path}.conditions`, message: 'is required' });
  } else {
    validateConditionInto(testCase.conditions, `${path}.conditions`, errors);
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

function validateConditionInto(condition, path, errors) {
  if (!isObject(condition)) {
    errors.push({ path, message: 'must be an object' });
    return;
  }
  const type = condition.type;
  if (!VALID_CONDITION_TYPES.includes(type)) {
    errors.push({ path: `${path}.type`, message: `unknown condition type: ${String(type)}` });
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
      validateConditionInto(child, `${path}.conditions[${index}]`, errors),
    );
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
