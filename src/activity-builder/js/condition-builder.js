import { VALID_CONDITION_TYPES } from '../../shared/config-validator.js';
import { appendCheckbox, appendNumber, appendSelect, appendText, makeButton, makeField } from './form-fields.js';

const CONDITION_LABELS = {
  all: 'All conditions',
  any: 'Any condition',
  none: 'No child condition',
  serial_output: 'Serial output',
  button_press: 'Button press',
  radio_tx: 'Radio transmission',
  radio_rx: 'Radio reception',
  sensor_reading: 'Sensor reading',
  led_display: 'LED display',
};

const SENSOR_LABELS = {
  lightLevel: 'Light level',
  soundLevel: 'Sound level',
  temperatureC: 'Temperature',
  magneticForceX: 'Magnetic force X',
  magneticForceY: 'Magnetic force Y',
  magneticForceZ: 'Magnetic force Z',
};

export function createDefaultCondition(type = 'serial_output') {
  switch (type) {
    case 'all':
    case 'any':
    case 'none':
      return { type, conditions: [createDefaultCondition('serial_output')] };
    case 'button_press':
      return { type, device_id: null, button: 'any', min_count: 1 };
    case 'radio_tx':
    case 'radio_rx':
      return {
        type,
        device_id: null,
        ...(type === 'radio_rx' ? { from_device_id: null } : {}),
        channel: null,
        group: null,
        payload: null,
        ...(type === 'radio_rx' ? { rssi_min: null, rssi_max: null } : {}),
        min_count: 1,
      };
    case 'sensor_reading':
      return { type, device_id: null, sensor: 'lightLevel', min: null, max: null, min_duration_seconds: 0 };
    case 'led_display':
      return { type, device_id: null, layout: '.....\n.....\n.....\n.....\n.....' };
    case 'serial_output':
    default:
      return {
        type: 'serial_output',
        device_id: null,
        match: 'contains',
        value: '',
        case_sensitive: true,
        min_count: 1,
      };
  }
}

export function renderConditionEditor({
  container,
  condition,
  onChange,
  scene,
  depth = 0,
  onRemove,
}) {
  if (!container) return;
  const current = condition && typeof condition === 'object'
    ? condition
    : createDefaultCondition();
  const updateCondition = (nextCondition) => {
    onChange(nextCondition);
    renderConditionEditor({ container, condition: nextCondition, onChange, scene, depth, onRemove });
  };
  container.replaceChildren();

  const wrapper = document.createElement('article');
  const composite = ['all', 'any', 'none'].includes(current.type);
  wrapper.className = `condition-node condition-node--${current.type}${composite ? ' condition-node--composite' : ''}`;
  wrapper.dataset.depth = String(depth);

  const header = document.createElement('div');
  header.className = 'condition-node-header';
  const title = document.createElement('strong');
  title.className = 'condition-node-title';
  title.textContent = CONDITION_LABELS[current.type] ?? 'Condition';
  const summary = document.createElement('span');
  summary.className = 'condition-node-summary';
  summary.textContent = conditionSummary(current);
  header.append(title, summary);
  if (onRemove) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'condition-remove';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${CONDITION_LABELS[current.type] ?? 'condition'}`);
    remove.addEventListener('click', onRemove);
    header.append(remove);
  }

  const body = document.createElement('div');
  body.className = 'condition-node-body';
  body.append(renderTypeSelector(current, updateCondition));
  if (composite) {
    body.append(renderComposite(current, updateCondition, scene, depth));
  } else {
    body.append(renderLeafFields(current, updateCondition, scene));
  }
  wrapper.append(header, body);
  container.append(wrapper);
}

function renderTypeSelector(condition, onChange) {
  const row = document.createElement('div');
  row.className = 'condition-type-row';
  const label = document.createElement('label');
  label.textContent = 'Condition type';
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Condition type');
  for (const type of VALID_CONDITION_TYPES) {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = CONDITION_LABELS[type] ?? type;
    option.selected = condition.type === type;
    select.append(option);
  }
  select.addEventListener('change', () => {
    const nextCondition = createDefaultCondition(select.value);
    if (Array.isArray(condition.conditions) && Array.isArray(nextCondition.conditions)) {
      nextCondition.conditions = condition.conditions;
    }
    onChange(nextCondition);
  });
  label.append(select);
  row.append(label);
  return row;
}

function renderComposite(condition, onChange, scene, depth) {
  const fragment = document.createDocumentFragment();
  const help = document.createElement('p');
  help.className = 'field-help';
  help.textContent = condition.type === 'all'
    ? 'Every child must match.'
    : condition.type === 'any'
      ? 'At least one child must match.'
      : 'Passes only when no child condition matches.';
  fragment.append(help);

  const children = Array.isArray(condition.conditions) ? condition.conditions : [];
  const list = document.createElement('div');
  list.className = 'condition-children';
  children.forEach((child, index) => {
    const card = document.createElement('div');
    card.className = 'condition-card';
    const controls = document.createElement('div');
    controls.className = 'condition-order-controls';
    controls.append(
      makeButton('↑', 'Move condition up', index === 0, () => {
        const next = [...children];
        [next[index - 1], next[index]] = [next[index], next[index - 1]];
        onChange({ ...condition, conditions: next });
      }),
      makeButton('↓', 'Move condition down', index === children.length - 1, () => {
        const next = [...children];
        [next[index], next[index + 1]] = [next[index + 1], next[index]];
        onChange({ ...condition, conditions: next });
      }),
    );
    const host = document.createElement('div');
    host.className = 'condition-child-editor';
    renderConditionEditor({
      container: host,
      condition: child,
      scene,
      depth: depth + 1,
      onChange: (nextChild) => {
        const next = [...children];
        next[index] = nextChild;
        onChange({ ...condition, conditions: next });
      },
      onRemove: () => onChange({
        ...condition,
        conditions: children.filter((_, childIndex) => childIndex !== index),
      }),
    });
    card.append(controls, host);
    list.append(card);
  });
  fragment.append(list);
  const add = makeButton('+ Add condition', 'Add child condition', false, () => {
    onChange({ ...condition, conditions: [...children, createDefaultCondition()] });
  });
  add.classList.add('btn', 'btn-small', 'btn-secondary', 'add-sub-condition');
  fragment.append(add);
  return fragment;
}

function renderLeafFields(condition, onChange, scene) {
  const fields = document.createElement('div');
  fields.className = 'condition-fields';
  appendDeviceSelect(fields, 'Device', condition.device_id, scene, (value) => update(condition, 'device_id', value, onChange));

  switch (condition.type) {
    case 'serial_output':
      appendSelect(fields, 'Match', condition.match, [
        ['contains', 'Contains'], ['exact', 'Exact text'], ['regex', 'Regular expression'],
      ], (value) => update(condition, 'match', value, onChange));
      appendText(fields, 'Text', condition.value, (value) => update(condition, 'value', value, onChange), true);
      appendCheckbox(fields, 'Case sensitive', condition.case_sensitive !== false,
        (value) => update(condition, 'case_sensitive', value, onChange));
      appendNumber(fields, 'Minimum matches', condition.min_count ?? 1,
        (value) => update(condition, 'min_count', value, onChange), { integer: true, minimum: 1 });
      break;
    case 'button_press':
      appendSelect(fields, 'Button', condition.button ?? 'any', [
        ['any', 'Any button'], ['A', 'A'], ['B', 'B'], ['AB', 'A+B'],
      ], (value) => update(condition, 'button', value, onChange));
      appendNumber(fields, 'Minimum presses', condition.min_count ?? 1,
        (value) => update(condition, 'min_count', value, onChange), { integer: true, minimum: 1 });
      break;
    case 'radio_tx':
      appendNumber(fields, 'Radio channel · any', condition.channel,
        (value) => update(condition, 'channel', value, onChange), { integer: true, nullable: true });
      appendNumber(fields, 'Radio group · any', condition.group,
        (value) => update(condition, 'group', value, onChange), { integer: true, nullable: true });
      appendPayloadFields(fields, condition.payload, (value) => update(condition, 'payload', value, onChange));
      appendNumber(fields, 'Minimum transmissions', condition.min_count ?? 1,
        (value) => update(condition, 'min_count', value, onChange), { integer: true, minimum: 1 });
      break;
    case 'radio_rx':
      appendDeviceSelect(fields, 'Sender · any', condition.from_device_id, scene,
        (value) => update(condition, 'from_device_id', value, onChange));
      appendNumber(fields, 'Radio channel · any', condition.channel,
        (value) => update(condition, 'channel', value, onChange), { integer: true, nullable: true });
      appendNumber(fields, 'Radio group · any', condition.group,
        (value) => update(condition, 'group', value, onChange), { integer: true, nullable: true });
      appendPayloadFields(fields, condition.payload, (value) => update(condition, 'payload', value, onChange));
      appendNumber(fields, 'RSSI minimum · any', condition.rssi_min,
        (value) => update(condition, 'rssi_min', value, onChange), { nullable: true });
      appendNumber(fields, 'RSSI maximum · any', condition.rssi_max,
        (value) => update(condition, 'rssi_max', value, onChange), { nullable: true });
      appendNumber(fields, 'Minimum receptions', condition.min_count ?? 1,
        (value) => update(condition, 'min_count', value, onChange), { integer: true, minimum: 1 });
      break;
    case 'sensor_reading':
      appendSelect(fields, 'Sensor', condition.sensor ?? 'lightLevel', Object.entries(SENSOR_LABELS),
        (value) => update(condition, 'sensor', value, onChange));
      appendNumber(fields, 'Minimum value · any', condition.min,
        (value) => update(condition, 'min', value, onChange), { nullable: true });
      appendNumber(fields, 'Maximum value · any', condition.max,
        (value) => update(condition, 'max', value, onChange), { nullable: true });
      appendNumber(fields, 'Held for seconds', condition.min_duration_seconds ?? 0,
        (value) => update(condition, 'min_duration_seconds', value, onChange), { minimum: 0, step: 'any' });
      break;
    case 'led_display': {
      const layoutField = makeField('Layout', true);
      const textarea = document.createElement('textarea');
      textarea.className = 'mono';
      textarea.rows = 5;
      textarea.spellcheck = false;
      textarea.value = condition.layout ?? '';
      textarea.addEventListener('change', () => update(condition, 'layout', textarea.value, onChange));
      const help = document.createElement('small');
      help.className = 'field-help';
      help.textContent = 'Five rows of five characters: # or 1 = lit, . or 0 = unlit.';
      layoutField.append(textarea, help);
      fields.append(layoutField);
      break;
    }
  }
  return fields;
}

function appendPayloadFields(fields, payload, onChange) {
  const enabled = payload !== null && payload !== undefined;
  appendCheckbox(fields, 'Match packet payload', enabled, (checked) => {
    onChange(checked ? { match: 'contains', value: '', case_sensitive: true } : null);
  });
  if (!enabled) return;
  appendSelect(fields, 'Payload match', payload.match ?? 'contains', [
    ['contains', 'Contains text'], ['exact', 'Exact text'], ['regex', 'Regular expression'], ['hex', 'Hex bytes'],
  ], (value) => onChange({ ...payload, match: value }));
  appendText(fields, payload.match === 'hex' ? 'Hex bytes' : 'Payload text', payload.value ?? '',
    (value) => onChange({ ...payload, value }), true);
  if (payload.match !== 'hex') {
    appendCheckbox(fields, 'Payload case sensitive', payload.case_sensitive !== false,
      (value) => onChange({ ...payload, case_sensitive: value }));
  }
}

function appendDeviceSelect(fields, label, selected, scene, onChange) {
  const devices = Array.isArray(scene?.devices) ? scene.devices : [];
  appendSelect(fields, label, selected ?? '', [
    ['', 'Any device'],
    ...devices.map((device) => [device.id, `${device.name} · ${device.id}`]),
  ], (value) => onChange(value === '' ? null : value));
}

function update(condition, key, value, onChange) {
  onChange({ ...condition, [key]: value });
}


function conditionSummary(condition) {
  if (['all', 'any', 'none'].includes(condition.type)) {
    return `${condition.conditions?.length ?? 0} sub-condition(s)`;
  }
  if (condition.type === 'serial_output') return condition.value || 'Serial text';
  if (condition.type === 'button_press') return condition.button ?? 'any button';
  if (condition.type === 'sensor_reading') return SENSOR_LABELS[condition.sensor] ?? 'Sensor';
  if (condition.type === 'led_display') return 'LED layout';
  return condition.type === 'radio_rx' ? 'Received packet' : 'Transmitted packet';
}
