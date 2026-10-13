const textDecoder = new TextDecoder('utf-8');

export function createGrader({ testCases = [] } = {}) {
  let eventLog = [];
  let latestSensors = new Map();
  let recentButtons = new Map();
  let latchedTestCounts = new Map();

  function reset() {
    eventLog = [];
    latestSensors = new Map();
    recentButtons = new Map();
    latchedTestCounts = new Map();
  }

  function record(message) {
    const entry = normalizeEvent(message);
    if (!entry) return false;

    if (entry.event.kind === 'code-load') reset();
    if (entry.event.kind === 'button') {
      const key = `${entry.event.device_id}\u0000${entry.event.button}\u0000${entry.event.pressed}`;
      const previous = recentButtons.get(key);
      const elapsed = previous === undefined ? Infinity : entry.ts - previous;
      if (elapsed >= 0 && elapsed < 150) return false;
      recentButtons.set(key, entry.ts);
    }

    eventLog.push(entry);
    if (entry.event.kind === 'sensor') {
      const key = `${entry.event.device_id}\u0000${entry.event.sensor}`;
      latestSensors.set(key, {
        device_id: entry.event.device_id,
        sensor: entry.event.sensor,
        value: entry.event.value,
        ts: entry.ts,
      });
    }
    return true;
  }

  function evaluate(condition, now = Date.now()) {
    return evaluateConditionState(condition, eventLog, latestSensors, now);
  }

  function grade() {
    const now = Date.now();
    return testCases.map((testCase) => {
      const current = evaluateConditionState(testCase.conditions, eventLog, latestSensors, now);
      if (current.passed && !latchedTestCounts.has(testCase.id)) {
        latchedTestCounts.set(testCase.id, current.matchCount);
      }
      const latchedCount = latchedTestCounts.get(testCase.id);
      return {
        id: testCase.id,
        passed: latchedCount !== undefined,
        matchCount: latchedCount ?? current.matchCount,
      };
    });
  }

  return { record, grade, reset, evaluate };
}

export function evaluateCondition(condition, events, now = Date.now()) {
  const eventLog = [];
  const latestSensors = new Map();
  for (const message of events ?? []) {
    const entry = normalizeEvent(message);
    if (!entry) continue;
    eventLog.push(entry);
    if (entry.event.kind === 'sensor') {
      latestSensors.set(`${entry.event.device_id}\u0000${entry.event.sensor}`, {
        device_id: entry.event.device_id,
        sensor: entry.event.sensor,
        value: entry.event.value,
        ts: entry.ts,
      });
    }
  }
  return evaluateConditionState(condition, eventLog, latestSensors, now);
}

function evaluateConditionState(condition, eventLog, latestSensors, now) {
  if (!condition || typeof condition !== 'object') return { passed: false, matchCount: 0 };
  if (condition.type === 'all' || condition.type === 'any' || condition.type === 'none') {
    const children = Array.isArray(condition.conditions) ? condition.conditions : [];
    const results = children.map((child) =>
      evaluateConditionState(child, eventLog, latestSensors, now),
    );
    if (condition.type === 'all') {
      const passed = results.length > 0 && results.every((result) => result.passed);
      return { passed, matchCount: passed ? Math.min(...results.map((result) => result.matchCount)) : 0 };
    }
    if (condition.type === 'any') {
      const passing = results.filter((result) => result.passed);
      return {
        passed: passing.length > 0,
        matchCount: passing.reduce((total, result) => total + result.matchCount, 0),
      };
    }
    const passed = results.every((result) => !result.passed);
    return {
      passed,
      matchCount: passed ? 0 : results.reduce((total, result) => total + result.matchCount, 0),
    };
  }

  if (condition.type === 'sensor_reading') {
    return evaluateSensorCondition(condition, latestSensors, now);
  }

  let matchCount = 0;
  for (const entry of eventLog) {
    if (matchesEventCondition(condition, entry.event)) matchCount += 1;
  }
  return {
    passed: matchCount >= (condition.min_count ?? 1),
    matchCount,
  };
}

function matchesEventCondition(condition, event) {
  if (!matchesDevice(condition.device_id, event.device_id)) return false;
  switch (condition.type) {
    case 'serial_output':
      return event.kind === 'serial' && matchText(
        event.text,
        condition.match,
        condition.value,
        condition.case_sensitive ?? true,
      );
    case 'button_press':
      return event.kind === 'button' && event.pressed === true &&
        (condition.button == null || condition.button === 'any' || condition.button === event.button);
    case 'radio_tx':
      return event.kind === 'radio-tx' && matchesRadioPacket(condition, event.packet);
    case 'radio_rx':
      return event.kind === 'radio-rx' &&
        (condition.from_device_id == null || event.from_device_id === condition.from_device_id) &&
        matchesRadioPacket(condition, event.packet) &&
        (condition.rssi_min == null || (Number.isFinite(event.rssi) && event.rssi >= condition.rssi_min)) &&
        (condition.rssi_max == null || (Number.isFinite(event.rssi) && event.rssi <= condition.rssi_max));
    default:
      return false;
  }
}

function matchesRadioPacket(condition, packet) {
  if (!packet) return false;
  if (condition.channel != null && packet.channel !== condition.channel) return false;
  if (condition.group != null && packet.group !== condition.group) return false;
  return condition.payload == null || matchesPayload(packet.data_b64, condition.payload);
}

function matchesPayload(dataBase64, payloadCondition) {
  const bytes = decodeBase64(dataBase64);
  if (!bytes) return false;
  if (payloadCondition.match === 'hex') {
    return bytesToHex(bytes) === payloadCondition.value.toLowerCase();
  }
  let text;
  try {
    text = textDecoder.decode(bytes);
  } catch {
    return false;
  }
  return matchText(
    text,
    payloadCondition.match,
    payloadCondition.value,
    payloadCondition.case_sensitive ?? true,
  );
}

function matchText(actual, mode, expected, caseSensitive) {
  if (typeof actual !== 'string' || typeof expected !== 'string') return false;
  const left = caseSensitive ? actual : actual.toLowerCase();
  const right = caseSensitive ? expected : expected.toLowerCase();
  if (mode === 'contains') return left.includes(right);
  if (mode === 'exact') return left === right;
  if (mode === 'regex') {
    try {
      return new RegExp(expected, caseSensitive ? '' : 'i').test(actual);
    } catch {
      return false;
    }
  }
  return false;
}

function evaluateSensorCondition(condition, latestSensors, now) {
  const durationMs = (condition.min_duration_seconds ?? 0) * 1000;
  let matchCount = 0;
  for (const latest of latestSensors.values()) {
    if (latest.sensor !== condition.sensor || !matchesDevice(condition.device_id, latest.device_id)) continue;
    if (!Number.isFinite(latest.value)) continue;
    if (condition.min != null && latest.value < condition.min) continue;
    if (condition.max != null && latest.value > condition.max) continue;
    if (Math.max(0, now - latest.ts) < durationMs) continue;
    matchCount += 1;
  }
  return { passed: matchCount > 0, matchCount };
}

function matchesDevice(conditionDeviceId, eventDeviceId) {
  return conditionDeviceId == null
    ? typeof eventDeviceId === 'string'
    : conditionDeviceId === eventDeviceId;
}

function normalizeEvent(message) {
  if (!message || typeof message !== 'object') return undefined;
  const event = message.event && typeof message.event === 'object' ? message.event : message;
  if (typeof event.kind !== 'string') return undefined;
  const timestamp = Number.isFinite(message.ts)
    ? message.ts
    : Number.isFinite(event.ts)
      ? event.ts
      : Date.now();
  return {
    event,
    ts: timestamp,
    ...(Number.isFinite(message.seq) ? { seq: message.seq } : {}),
  };
}

function decodeBase64(value) {
  if (typeof value !== 'string') return undefined;
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index);
    }
    return bytes;
  } catch {
    return undefined;
  }
}

function bytesToHex(bytes) {
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}
