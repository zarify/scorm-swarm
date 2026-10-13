import { base64ToBytes, decodeSwarmBundle } from '../../shared/swarm-bundle.js';
import { validateConfig } from '../../shared/config-validator.js';
import { normalizeConfig } from '../../shared/config-normalizer.js';
import { initConfigTab } from './config-tab.js';
import { initScenarioTab } from './scenario-tab.js';
import { initHintsTab } from './hints-tab.js';
import { initTestsTab } from './tests-tab.js';
import { initPreviewTab } from './preview-tab.js';
import { exportJSON, exportSCORM } from './export.js';

const configListeners = new Set();
const sceneListeners = new Set();
const state = {
  config: normalizeConfig({
    metadata: {
      activity_id: 'new-swarm-activity',
      title: 'Untitled swarm activity',
      instructions_markdown: '',
      learning_objectives_markdown: '',
      teacher_notes_markdown: '',
    },
    evaluation: {
      pass_threshold: 50,
      test_cases: [
        {
          id: 'test-1',
          type: 'effect',
          points: 1,
          conditions: {
            type: 'serial_output',
            device_id: null,
            match: 'contains',
            value: 'hello',
            case_sensitive: true,
            min_count: 1,
          },
        },
      ],
    },
    hints: [],
  }),
  sceneBundleBase64: null,
  sceneProject: null,
};

export function getConfig() {
  return state.config;
}

export function setConfig(config, sceneBundleBase64 = null) {
  const normalized = normalizeConfig(config);
  const validation = validateConfig(normalized);
  if (!validation.valid) {
    throw new Error(validation.errors.map((error) => `${error.path || 'config'}: ${error.message}`).join('\n'));
  }
  const loadedScene = typeof sceneBundleBase64 === 'string'
    ? decodeSwarmBundle(base64ToBytes(sceneBundleBase64))
    : null;
  state.config = normalized;
  state.sceneBundleBase64 = typeof sceneBundleBase64 === 'string' ? sceneBundleBase64 : null;
  state.sceneProject = loadedScene;
  notifyConfigChange('import');
  notifySceneChange('import');
}

export function getSceneBundle() {
  return state.sceneBundleBase64;
}

export function getSceneProject() {
  return state.sceneProject;
}

export function setSceneBundle(base64, project, source = 'scenario') {
  state.sceneBundleBase64 = base64;
  state.sceneProject = project;
  notifySceneChange(source);
}

export function notifyConfigChange(source = 'editor') {
  for (const listener of configListeners) listener(state.config, source);
}

export function notifySceneChange(source = 'scene') {
  for (const listener of sceneListeners) listener(state.sceneBundleBase64, state.sceneProject, source);
}

export function onConfigChange(listener) {
  configListeners.add(listener);
  return () => configListeners.delete(listener);
}

export function onSceneChange(listener) {
  sceneListeners.add(listener);
  return () => sceneListeners.delete(listener);
}

export function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = String(message);
  toast.className = `toast toast-${type}`;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.add('hidden'), 4500);
}

function setupTabs() {
  const buttons = [...document.querySelectorAll('.tab-btn')];
  const panels = [...document.querySelectorAll('.tab-panel')];
  for (const button of buttons) {
    button.addEventListener('click', () => {
      const tab = button.dataset.tab;
      for (const candidate of buttons) {
        const active = candidate === button;
        candidate.classList.toggle('active', active);
        candidate.setAttribute('aria-selected', String(active));
      }
      for (const panel of panels) panel.classList.toggle('active', panel.id === `tab-${tab}`);
      window.dispatchEvent(new CustomEvent('tab-activated', { detail: { tab } }));
    });
  }
}

function setupHeaderActions() {
  const fileInput = document.getElementById('file-import');
  document.getElementById('btn-import').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      const sceneBundle = imported.scene_bundle_base64;
      delete imported.scene_bundle_base64;
      setConfig(imported, sceneBundle);
      showToast('Activity JSON imported.', 'success');
    } catch (error) {
      showToast(`Import failed: ${error instanceof Error ? error.message : String(error)}`, 'error');
    } finally {
      fileInput.value = '';
    }
  });

  document.getElementById('btn-export-json').addEventListener('click', () => {
    const validation = validateConfig(state.config);
    if (!validation.valid) {
      showToast(formatValidationErrors(validation.errors), 'error');
      return;
    }
    exportJSON(state.config, state.sceneBundleBase64);
    showToast('Activity JSON downloaded.', 'success');
  });
  document.getElementById('btn-export-scorm').addEventListener('click', async () => {
    try {
      const validation = validateConfig(state.config);
      if (!validation.valid) throw new Error(formatValidationErrors(validation.errors));
      await exportSCORM(state.config, state.sceneBundleBase64);
      showToast('SCORM package downloaded.', 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
  });
}

function formatValidationErrors(errors) {
  const first = errors.slice(0, 4).map((error) => `${error.path || 'config'}: ${error.message}`);
  const more = errors.length > first.length ? `\n…and ${errors.length - first.length} more` : '';
  return `Fix ${errors.length} config error(s) before export. ${first.join('; ')}${more}`;
}

function init() {
  setupTabs();
  setupHeaderActions();
  initConfigTab();
  initScenarioTab();
  initHintsTab();
  initTestsTab();
  initPreviewTab();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
