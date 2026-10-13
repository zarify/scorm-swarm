import { getConfig, notifyConfigChange, onConfigChange } from './app.js';

const FIELDS = {
  'cfg-title': ['metadata', 'title'],
  'cfg-activity-id': ['metadata', 'activity_id'],
  'cfg-instructions': ['metadata', 'instructions_markdown'],
  'cfg-objectives': ['metadata', 'learning_objectives_markdown'],
  'cfg-teacher-notes': ['metadata', 'teacher_notes_markdown'],
};

const CAPABILITIES = {
  'cap-move-devices': 'move_devices',
  'cap-move-nodes': 'move_nodes',
  'cap-use-buttons': 'use_buttons',
  'cap-load-code': 'load_code',
  'cap-edit-code': 'edit_code',
};

export function initConfigTab() {
  for (const [id, [section, key]] of Object.entries(FIELDS)) {
    const input = document.getElementById(id);
    input.addEventListener('input', () => {
      getConfig()[section][key] = input.value;
      notifyConfigChange('config');
    });
  }

  for (const [id, key] of Object.entries(CAPABILITIES)) {
    const input = document.getElementById(id);
    input.addEventListener('change', () => {
      getConfig().capabilities[key] = input.checked;
      notifyConfigChange('config');
    });
  }

  const threshold = document.getElementById('cfg-pass-threshold');
  threshold.addEventListener('input', () => {
    const value = threshold.value;
    getConfig().evaluation.pass_threshold = value === '' ? Number.NaN : Number(value);
    notifyConfigChange('config');
  });

  onConfigChange((config, source) => {
    if (source !== 'config') populate(config);
  });
  populate(getConfig());
}

function populate(config) {
  for (const [id, [section, key]] of Object.entries(FIELDS)) {
    document.getElementById(id).value = config[section]?.[key] ?? '';
  }
  for (const [id, key] of Object.entries(CAPABILITIES)) {
    document.getElementById(id).checked = config.capabilities?.[key] !== false;
  }
  document.getElementById('cfg-pass-threshold').value =
    Number.isInteger(config.evaluation?.pass_threshold) ? config.evaluation.pass_threshold : '';
}
