const DEFAULT_METADATA = {
  activity_id: '',
  title: 'Untitled activity',
  instructions_markdown: '',
  learning_objectives_markdown: '',
  teacher_notes_markdown: '',
};

const DEFAULT_CAPABILITIES = {
  move_devices: true,
  move_nodes: true,
  use_buttons: true,
  load_code: true,
  edit_code: true,
};

export function normalizeConfig(rawConfig) {
  if (!isObject(rawConfig)) return rawConfig;
  const config = { ...rawConfig };
  config.metadata = rawConfig.metadata === undefined
    ? { ...DEFAULT_METADATA }
    : isObject(rawConfig.metadata)
      ? addDefaults(rawConfig.metadata, DEFAULT_METADATA)
      : rawConfig.metadata;
  config.capabilities = rawConfig.capabilities === undefined
    ? { ...DEFAULT_CAPABILITIES }
    : isObject(rawConfig.capabilities)
      ? addDefaults(rawConfig.capabilities, DEFAULT_CAPABILITIES)
      : rawConfig.capabilities;
  config.evaluation = normalizeEvaluation(rawConfig.evaluation);
  config.hints = Array.isArray(rawConfig.hints)
    ? rawConfig.hints.map(normalizeHint)
    : rawConfig.hints === undefined
      ? []
      : rawConfig.hints;
  return config;
}

export function normalizeCondition(condition) {
  if (!isObject(condition)) return condition;
  const normalized = { ...condition };
  if (Array.isArray(condition.conditions)) {
    normalized.conditions = condition.conditions.map(normalizeCondition);
  }

  switch (condition.type) {
    case 'serial_output':
      return addDefaults(normalized, { case_sensitive: true, min_count: 1 });
    case 'button_press':
      return addDefaults(normalized, { button: 'any', min_count: 1 });
    case 'radio_tx':
      if (Object.prototype.hasOwnProperty.call(condition, 'payload')) {
        normalized.payload = normalizePayload(condition.payload);
      }
      return addDefaults(normalized, { channel: null, group: null, payload: null, min_count: 1 });
    case 'radio_rx':
      if (Object.prototype.hasOwnProperty.call(condition, 'payload')) {
        normalized.payload = normalizePayload(condition.payload);
      }
      return addDefaults(normalized, {
        from_device_id: null,
        channel: null,
        group: null,
        payload: null,
        rssi_min: null,
        rssi_max: null,
        min_count: 1,
      });
    case 'sensor_reading':
      return addDefaults(normalized, { min: null, max: null, min_duration_seconds: 0 });
    default:
      return normalized;
  }
}

function normalizeEvaluation(evaluation) {
  if (!isObject(evaluation)) {
    return evaluation === undefined
      ? { pass_threshold: 50, test_cases: [] }
      : evaluation;
  }
  const normalized = addDefaults(evaluation, { pass_threshold: 50, test_cases: [] });
  if (Array.isArray(evaluation.test_cases)) {
    normalized.test_cases = evaluation.test_cases.map(normalizeTestCase);
  }
  return normalized;
}

function normalizeTestCase(testCase) {
  if (!isObject(testCase)) return testCase;
  const normalized = addDefaults(testCase, { points: 1 });
  if (isObject(testCase.conditions)) {
    normalized.conditions = normalizeCondition(testCase.conditions);
  }
  return normalized;
}

function normalizeHint(hint) {
  if (!isObject(hint)) return hint;
  const normalized = addDefaults(hint, {
    priority: 1,
    delay_seconds: 0,
    show_once: false,
    display_mode: 'triggered',
    style: 'info',
  });
  if (!isObject(hint.trigger)) return normalized;
  normalized.trigger = addDefaults(hint.trigger, {
    after_attempts: 0,
    invalidate_on_condition_false: false,
  });
  if (isObject(hint.trigger.conditions)) {
    normalized.trigger.conditions = normalizeCondition(hint.trigger.conditions);
  }
  return normalized;
}

function normalizePayload(payload) {
  return isObject(payload) ? addDefaults(payload, { case_sensitive: true }) : payload;
}

function addDefaults(value, defaults) {
  const object = isObject(value) ? value : {};
  const normalized = { ...defaults, ...object };
  for (const key of Object.keys(defaults)) {
    if (Object.prototype.hasOwnProperty.call(object, key)) normalized[key] = object[key];
  }
  return normalized;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
