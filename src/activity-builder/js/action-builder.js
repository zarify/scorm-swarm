import { VALID_ACTION_BUTTONS, VALID_ACTION_TYPES, VALID_NODE_TYPES } from '../../shared/config-validator.js';
import { appendNumber, appendSelect, appendText, makeField } from './form-fields.js';

const ACTION_LABELS = {
  radio_broadcast: 'Radio broadcast',
  press_button: 'Press button',
  set_node_level: 'Set node level',
  add_node: 'Add node',
};

const BUTTON_LABELS = { A: 'A', B: 'B', AB: 'A+B' };

const NODE_TYPE_LABELS = { light: 'Light', sound: 'Sound', temperature: 'Temperature', magnet: 'Magnet' };

const LEVEL_LABELS = {
  light: 'Light intensity',
  sound: 'Sound intensity',
  temperature: 'Temperature °C',
  magnet: 'Magnetic strength µT',
};

export function createDefaultAction(type = 'press_button') {
  switch (type) {
    case 'radio_broadcast':
      return { type, device_id: null, channel: null, group: null, payload: '', count: 1, interval_ms: 0 };
    case 'set_node_level':
      return { type, node_id: null, value: 0 };
    case 'add_node':
      return { type, node_type: 'light', x: 0, y: 0, level: null, duration_seconds: 10 };
    case 'press_button':
    default:
      return { type: 'press_button', device_id: null, button: 'A', count: 1, interval_ms: 0 };
  }
}

export function actionSummary(action) {
  if (!action || typeof action !== 'object') return '';
  if (action.type === 'radio_broadcast') return action.payload ? `Radio "${action.payload}"` : 'Radio broadcast';
  if (action.type === 'press_button') return `Button ${BUTTON_LABELS[action.button] ?? action.button ?? 'A'}`;
  if (action.type === 'set_node_level') return `Level ${action.value ?? 0}`;
  if (action.type === 'add_node') return `Add ${action.node_type ?? 'light'} node`;
  return 'Action';
}

export function renderActionEditor({ container, action, scene, onChange, onRemove }) {
  if (!container) return;
  const current = action && typeof action === 'object' ? action : createDefaultAction();
  const update = (key, value) => onChange({ ...current, [key]: value });
  container.replaceChildren();

  const card = document.createElement('article');
  card.className = 'action-card';

  const header = document.createElement('div');
  header.className = 'action-card-header';
  const title = document.createElement('strong');
  title.className = 'action-card-title';
  title.textContent = ACTION_LABELS[current.type] ?? 'Action';
  const summary = document.createElement('span');
  summary.className = 'action-card-summary';
  summary.textContent = actionSummary(current);
  header.append(title, summary);
  if (onRemove) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'condition-remove';
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove ${ACTION_LABELS[current.type] ?? 'action'}`);
    remove.addEventListener('click', onRemove);
    header.append(remove);
  }
  card.append(header);

  const typeRow = document.createElement('div');
  typeRow.className = 'action-type-row';
  const typeField = makeField('Action type');
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Action type');
  for (const type of VALID_ACTION_TYPES) {
    const option = document.createElement('option');
    option.value = type;
    option.textContent = ACTION_LABELS[type] ?? type;
    option.selected = current.type === type;
    select.append(option);
  }
  select.addEventListener('change', () => onChange(createDefaultAction(select.value)));
  typeField.append(select);
  typeRow.append(typeField);
  card.append(typeRow);

  const fields = document.createElement('div');
  fields.className = 'action-fields';
  switch (current.type) {
    case 'radio_broadcast':
      appendDeviceField(fields, current.device_id, scene, (value) => update('device_id', value));
      appendNumber(fields, 'Radio channel · device default', current.channel,
        (value) => update('channel', value), { integer: true, nullable: true, placeholder: 'Device default' });
      appendNumber(fields, 'Radio group · device default', current.group,
        (value) => update('group', value), { integer: true, nullable: true, placeholder: 'Device default' });
      appendText(fields, 'Payload text', current.payload, (value) => update('payload', value), true);
      appendNumber(fields, 'Repeat count', current.count,
        (value) => update('count', value), { integer: true, minimum: 1 });
      appendNumber(fields, 'Interval ms', current.interval_ms,
        (value) => update('interval_ms', value), { integer: true, minimum: 0 });
      break;
    case 'press_button':
      appendDeviceField(fields, current.device_id, scene, (value) => update('device_id', value));
      appendSelect(fields, 'Button', current.button ?? 'A',
        VALID_ACTION_BUTTONS.map((button) => [button, BUTTON_LABELS[button] ?? button]),
        (value) => update('button', value));
      appendNumber(fields, 'Repeat count', current.count,
        (value) => update('count', value), { integer: true, minimum: 1 });
      appendNumber(fields, 'Interval ms', current.interval_ms,
        (value) => update('interval_ms', value), { integer: true, minimum: 0 });
      break;
    case 'set_node_level':
      appendNodeField(fields, current.node_id, scene, (value) => update('node_id', value));
      appendNumber(fields, LEVEL_LABELS[sceneNodes(scene).find((node) => node.id === current.node_id)?.type] ?? 'Level',
        current.value, (value) => update('value', value));
      break;
    case 'add_node': {
      appendSelect(fields, 'Node type', current.node_type ?? 'light',
        VALID_NODE_TYPES.map((type) => [type, NODE_TYPE_LABELS[type] ?? type]),
        (value) => update('node_type', value));
      appendNumber(fields, 'X', current.x, (value) => update('x', value));
      appendNumber(fields, 'Y', current.y, (value) => update('y', value));
      appendNumber(fields, 'Level · type default', current.level,
        (value) => update('level', value), { nullable: true, placeholder: 'Type default' });
      const durationField = makeField('Duration seconds');
      const durationInput = document.createElement('input');
      durationInput.type = 'number';
      durationInput.step = 'any';
      durationInput.min = '0';
      durationInput.value = current.duration_seconds == null ? '' : String(current.duration_seconds);
      durationInput.addEventListener('change', () => {
        update('duration_seconds', durationInput.value === '' ? 10 : Number(durationInput.value));
      });
      const help = document.createElement('small');
      help.className = 'field-help';
      help.textContent = '0 keeps the node permanently';
      durationField.append(durationInput, help);
      fields.append(durationField);
      break;
    }
  }
  card.append(fields);
  container.append(card);
}

function appendDeviceField(fields, selected, scene, onChange) {
  const devices = Array.isArray(scene?.devices) ? scene.devices : [];
  appendSelect(fields, 'Device', selected ?? '', [
    ['', 'Select device'],
    ...devices.map((device) => [device.id, `${device.name} · ${device.id}`]),
  ], (value) => onChange(value === '' ? null : value));
}

function appendNodeField(fields, selected, scene, onChange) {
  const nodes = sceneNodes(scene);
  appendSelect(fields, 'Node', selected ?? '', [
    ['', 'Select node'],
    ...nodes.map((node) => [node.id, `${node.name} · ${node.type}`]),
  ], (value) => onChange(value === '' ? null : value));
}

function sceneNodes(scene) {
  return Array.isArray(scene?.environmentSources) ? scene.environmentSources : [];
}
