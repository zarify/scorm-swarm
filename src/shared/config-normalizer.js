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

const DEFAULT_PANEL_VISIBILITY = {
  debug_panel: false,
  radio_inspector: true,
  runtime_log: false,
  environment_values: true,
  node_coordinates: false,
  panel_header: false,
};

const DEFAULT_CHECK_TIMEOUT_MS = 5000;

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
  config.panel_visibility = rawConfig.panel_visibility === undefined
    ? { ...DEFAULT_PANEL_VISIBILITY }
    : isObject(rawConfig.panel_visibility)
      ? addDefaults(rawConfig.panel_visibility, DEFAULT_PANEL_VISIBILITY)
      : rawConfig.panel_visibility;
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
    case 'led_display':
      return addDefaults(normalized, { device_id: null });
    case 'node_distance':
      return addDefaults(normalized, { min: null, max: null });
    default:
      return normalized;
  }
}

function normalizeEvaluation(evaluation) {
  if (!isObject(evaluation)) {
    return evaluation === undefined
      ? { test_cases: [] }
      : evaluation;
  }
  const normalized = addDefaults(evaluation, { test_cases: [] });
  if (Array.isArray(evaluation.test_cases)) {
    normalized.test_cases = evaluation.test_cases.map(normalizeTestCase);
  }
  return normalized;
}

function normalizeTestCase(testCase) {
  if (!isObject(testCase)) return testCase;
  const normalized = addDefaults(testCase, { points: 1 });
  if (Array.isArray(testCase.trigger)) {
    normalized.trigger = testCase.trigger.map(normalizeTestAction);
  }
  if (Array.isArray(testCase.steps)) {
    normalized.steps = testCase.steps.map(normalizeTestStep);
  }
  return normalized;
}

function normalizeTestAction(action) {
  if (!isObject(action)) return action;
  switch (action.type) {
    case 'radio_broadcast':
      return addDefaults(action, {
        channel: null,
        group: null,
        payload: '',
        count: 1,
        interval_ms: 0,
      });
    case 'press_button':
      return addDefaults(action, { button: 'A', count: 1, interval_ms: 0 });
    case 'set_node_level':
      return addDefaults(action, {});
    case 'add_node':
      return addDefaults(action, { level: null, duration_seconds: 10 });
    default:
      return action;
  }
}

function normalizeTestStep(step) {
  if (!isObject(step)) return step;
  if (step.type === 'action') {
    return isObject(step.action)
      ? { ...step, action: normalizeTestAction(step.action) }
      : step;
  }
  if (step.type === 'check') {
    const normalized = normalizeCheckTimeout(step);
    if (isObject(normalized.condition)) {
      normalized.condition = normalizeCondition(normalized.condition);
    }
    return normalized;
  }
  return step;
}

/**
 * Migrate a saved `timeout_seconds` to canonical `timeout_ms` exactly once.
 * A malformed or duplicated legacy key is left untouched so strict validation
 * rejects it instead of silently falling back to the default.
 */
function normalizeCheckTimeout(step) {
  const normalized = { ...step };
  const hasSeconds = Object.prototype.hasOwnProperty.call(step, 'timeout_seconds');
  const hasMilliseconds = Object.prototype.hasOwnProperty.call(step, 'timeout_ms');
  if (!hasSeconds && !hasMilliseconds) {
    normalized.timeout_ms = DEFAULT_CHECK_TIMEOUT_MS;
    return normalized;
  }
  if (hasSeconds && !hasMilliseconds && typeof step.timeout_seconds === 'number' &&
      Number.isFinite(step.timeout_seconds)) {
    normalized.timeout_ms = step.timeout_seconds * 1000;
    delete normalized.timeout_seconds;
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
