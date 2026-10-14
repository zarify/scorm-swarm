import { base64ToBytes, bytesToBase64, decodeSwarmBundle, encodeSwarmBundle, setDeviceFlags, setNodeFlags } from '../../shared/swarm-bundle.js';
import { connectSimBridge } from '../../shared/sim-bridge.js';
import { getSceneBundle, getSceneProject, onSceneChange, setSceneBundle, showToast } from './app.js';

let bridge;
let bridgeReady = false;
let currentBundle;
let currentProject;
let bundleLoadChain = Promise.resolve();

export function initScenarioTab() {
  currentBundle = getSceneBundle();
  currentProject = getSceneProject();
  const iframe = document.getElementById('scenario-iframe');
  const captureButton = document.getElementById('btn-capture-scene');
  const reloadButton = document.getElementById('btn-reload-scene');
  const fileInput = document.getElementById('file-scene');

  void connectFrame(iframe);
  captureButton.addEventListener('click', () => void captureScene());
  reloadButton.addEventListener('click', () => void reloadScene());
  document.getElementById('btn-load-scene').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => void loadSceneFile(fileInput));
  onSceneChange((bundle, project, source) => {
    currentBundle = bundle;
    currentProject = project;
    if (bundle && !project) {
      try {
        currentProject = decodeSwarmBundle(base64ToBytes(bundle));
        if (source === 'import') {
          setSceneBundle(bundle, currentProject, 'scene-import');
          return;
        }
      } catch (error) {
        showToast(`Scene bundle could not be read: ${error.message}`, 'error');
      }
    }
    renderSceneTable();
    updateSceneButtons();
    if ((source === 'import' || source === 'scene-import') && currentBundle && bridgeReady) {
      void loadBundleIntoSimulator(currentBundle);
    }
  });
  renderSceneTable();
  updateSceneButtons();
}

async function connectFrame(iframe) {
  bridge?.close();
  bridgeReady = false;
  setConnectionStatus('Connecting to simulator…');
  const frameWindow = iframe.contentWindow;
  if (!frameWindow) {
    setConnectionStatus('Simulator frame is unavailable.', 'error');
    return;
  }
  const targetOrigin = new URL('sim/index.html', window.location.href).origin;
  bridge = connectSimBridge(frameWindow, targetOrigin);
  const connectingBridge = bridge;
  iframe.src = 'sim/index.html';
  try {
    const ready = await connectingBridge.ready;
    if (!ready || connectingBridge !== bridge) return;
    bridgeReady = true;
    setConnectionStatus('Simulator connected.');
    updateSceneButtons();
    if (currentBundle) await loadBundleIntoSimulator(currentBundle);
  } catch (error) {
    setConnectionStatus(error instanceof Error ? error.message : 'Simulator connection failed.', 'error');
  }
}

async function captureScene() {
  if (!bridgeReady || !bridge) return;
  try {
    const base64 = await bridge.getBundle();
    currentBundle = base64;
    currentProject = decodeSwarmBundle(base64ToBytes(base64));
    setSceneBundle(base64, currentProject, 'scenario');
    setConnectionStatus('Scene captured.');
    renderSceneTable();
    updateSceneButtons();
  } catch (error) {
    showToast(`Could not capture scene: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

async function loadSceneFile(fileInput) {
  const file = fileInput.files?.[0];
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const project = decodeSwarmBundle(bytes);
    const base64 = bytesToBase64(bytes);
    currentBundle = base64;
    currentProject = project;
    if (bridgeReady) await loadBundleIntoSimulator(base64);
    setSceneBundle(base64, project, 'scenario-file');
    setConnectionStatus(`Loaded ${file.name}.`);
    renderSceneTable();
    updateSceneButtons();
  } catch (error) {
    showToast(`Could not load .swarm file: ${error instanceof Error ? error.message : String(error)}`, 'error');
  } finally {
    fileInput.value = '';
  }
}

async function reloadScene() {
  if (!currentBundle || !bridgeReady) return;
  try {
    await loadBundleIntoSimulator(currentBundle);
    setConnectionStatus('Scene restored in the simulator.');
  } catch (error) {
    showToast(`Could not reload scene: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

function loadBundleIntoSimulator(base64) {
  const activeBridge = bridge;
  if (!bridgeReady || !activeBridge) return Promise.resolve();
  bundleLoadChain = bundleLoadChain
    .catch(() => {})
    .then(() => {
      if (activeBridge !== bridge || !bridgeReady) return;
      return activeBridge.loadBundle(base64);
    });
  return bundleLoadChain;
}

async function updateFlags(kind, nodeId, flags) {
  if (!currentProject) return;
  const nextProject = kind === 'device'
    ? setDeviceFlags(currentProject, nodeId, flags)
    : setNodeFlags(currentProject, nodeId, flags);
  if (nextProject === currentProject) return;
  currentProject = nextProject;
  currentBundle = bytesToBase64(encodeSwarmBundle(nextProject));
  setSceneBundle(currentBundle, currentProject, 'scenario');
  renderSceneTable();
  updateSceneButtons();
  if (bridgeReady) {
    try {
      await loadBundleIntoSimulator(currentBundle);
      setConnectionStatus('Scene rules saved to the simulator.');
    } catch (error) {
      showToast(`Scene saved, but simulator reload failed: ${error.message}`, 'error');
    }
  }
}

function renderSceneTable() {
  const emptyState = document.getElementById('scene-empty');
  const tableWrap = document.getElementById('scene-table-wrap');
  const host = document.getElementById('scene-table');
  host.replaceChildren();
  const devices = currentProject?.devices ?? [];
  const nodes = currentProject?.environmentSources ?? [];
  if (!currentProject || (devices.length === 0 && nodes.length === 0)) {
    emptyState.hidden = false;
    tableWrap.hidden = true;
    return;
  }
  emptyState.hidden = true;
  tableWrap.hidden = false;
  const table = document.createElement('table');
  table.className = 'scene-table';
  const head = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['Scene object', 'Position', 'Locked', 'Pinned', 'Editable code']) {
    const cell = document.createElement('th');
    cell.textContent = label;
    headRow.append(cell);
  }
  head.append(headRow);
  const body = document.createElement('tbody');
  for (const device of devices) {
    body.append(renderSceneRow({
      name: device.name,
      id: device.id,
      kind: 'device',
      position: device.position,
      locked: device.locked,
      positionPinned: device.positionPinned,
      editableProgram: device.editableProgram,
      onFlagChange: (flag, value) => updateFlags(
        'device',
        device.id,
        flag === 'editableProgram' ? { editableProgram: value } : { [flag]: value },
      ),
    }));
  }
  for (const node of nodes) {
    body.append(renderSceneRow({
      name: node.name,
      id: node.id,
      kind: node.type,
      position: node.position,
      locked: node.locked,
      positionPinned: node.positionPinned,
      editableProgram: undefined,
      onFlagChange: (flag, value) => updateFlags('node', node.id, { [flag]: value }),
    }));
  }
  table.append(head, body);
  host.append(table);
}

function renderSceneRow({ name, id, kind, position, locked, positionPinned, editableProgram, onFlagChange }) {
  const row = document.createElement('tr');
  const identity = document.createElement('td');
  identity.className = 'scenario-row-name';
  const title = document.createElement('span');
  title.className = 'node-name';
  title.textContent = name || kind;
  const identifier = document.createElement('span');
  identifier.className = 'node-id';
  identifier.textContent = `${kind} · ${id}`;
  identity.append(title, identifier);
  const coords = document.createElement('td');
  coords.className = 'node-position';
  coords.textContent = `${Math.round(position?.x ?? 0)}, ${Math.round(position?.y ?? 0)}`;
  row.append(identity, coords);
  row.append(
    flagCell('locked', locked, (value) => onFlagChange('locked', value)),
    flagCell('positionPinned', positionPinned, (value) => onFlagChange('positionPinned', value)),
  );
  const editable = flagCell('editableProgram', Boolean(editableProgram), (value) =>
    onFlagChange('editableProgram', value ? editableProgram : null),
  );
  const checkbox = editable.querySelector('input');
  if (kind !== 'device' || !editableProgram) {
    checkbox.disabled = true;
    checkbox.title = 'Load or edit code on this device in the simulator first.';
  }
  row.append(editable);
  return row;
}

function flagCell(flag, checked, onChange) {
  const cell = document.createElement('td');
  const label = document.createElement('label');
  label.className = 'scene-flag';
  label.setAttribute('aria-label', flag);
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked === true;
  input.addEventListener('change', () => onChange(input.checked));
  label.append(input);
  cell.append(label);
  return cell;
}

function setConnectionStatus(message, status = 'ready') {
  document.getElementById('scenario-status').textContent = message;
  const dot = document.getElementById('scenario-status-dot');
  dot.classList.toggle('is-ready', status === 'ready');
  dot.classList.toggle('is-error', status === 'error');
}

function updateSceneButtons() {
  document.getElementById('btn-capture-scene').disabled = !bridgeReady;
  document.getElementById('btn-reload-scene').disabled = !bridgeReady || !currentBundle;
}
