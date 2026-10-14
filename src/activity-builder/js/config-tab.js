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
const PANEL_VISIBILITY = {
  'panel-debug': 'debug_panel',
  'panel-radio-inspector': 'radio_inspector',
  'panel-runtime-log': 'runtime_log',
  'panel-env-values': 'environment_values',
  'panel-header': 'panel_header',
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
  for (const [id, key] of Object.entries(PANEL_VISIBILITY)) {
    const input = document.getElementById(id);
    input.addEventListener('change', () => {
      getConfig().panel_visibility[key] = input.checked;
      notifyConfigChange('config');
    });
  }



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
  for (const [id, key] of Object.entries(PANEL_VISIBILITY)) {
    document.getElementById(id).checked = config.panel_visibility[key] === true;
  }
}
