import { base64ToBytes, bytesToBase64, decodeSwarmBundle } from '../../shared/swarm-bundle.js';
import { connectSimBridge } from '../../shared/sim-bridge.js';
import { getSceneBundle, getSceneProject, onSceneChange, setSceneBundle, showToast } from './app.js';

const REQUEST_TIMEOUT_MS = 10_000;
const UNLOCK_FOR_EDIT_TOOLTIP = 'Unlock this device to change whether its code is editable.';
const NO_EDITABLE_CODE_TOOLTIP = 'Load or edit code on this device in the simulator first.';

let bridge;
let bridgeReady = false;
let currentBundle;
let currentProject;
let bundleLoadChain = Promise.resolve();
/**
 * Authoring imports (activity JSON, `.swarm` files) supersede anything already
 * in flight; operations remember the generation they were queued under and
 * never publish a snapshot that a newer import has replaced.
 */
let sceneImportGeneration = 0;

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
    if (source === 'import' || source === 'scene-import') {
      sceneImportGeneration += 1;
    }
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
      void loadBundleIntoSimulator(currentBundle).catch((error) => {
        setConnectionStatus(
          error instanceof Error ? error.message : 'Simulator could not load the imported scene.',
          'error',
        );
      });
    }
  });
  renderSceneTable();
  updateSceneButtons();
}

/**
 * Serialize simulator work: loads and flag changes must not interleave, or an
 * older reply could publish a snapshot over a newer one. The chain itself never
 * stays rejected; each caller still sees its own failure.
 */
function queueScenarioRequest(run) {
  const activeBridge = bridge;
  const generation = sceneImportGeneration;
  const task = bundleLoadChain.then(() => {
    if (!bridgeReady || activeBridge !== bridge) return undefined;
    return run({ activeBridge, generation });
  });
  bundleLoadChain = task.then(
    () => {},
    () => {},
  );
  return task;
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
  iframe.src = 'sim/index.html?mode=scenario';
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
    await queueScenarioRequest(async ({ activeBridge, generation }) => {
      const base64 = await activeBridge.getBundle({ timeoutMs: REQUEST_TIMEOUT_MS });
      if (generation !== sceneImportGeneration) return;
      currentBundle = base64;
      currentProject = decodeSwarmBundle(base64ToBytes(base64));
      setSceneBundle(base64, currentProject, 'scenario');
      setConnectionStatus('Scene captured.');
    });
  } catch (error) {
    showToast(`Could not capture scene: ${error instanceof Error ? error.message : String(error)}`, 'error');
  }
}

async function loadSceneFile(fileInput) {
  const file = fileInput.files?.[0];
  if (!file) return;
  // A newly selected file supersedes in-flight captures and flag replies.
  sceneImportGeneration += 1;
  const generation = sceneImportGeneration;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const project = decodeSwarmBundle(bytes);
    if (generation !== sceneImportGeneration) return;
    const base64 = bytesToBase64(bytes);
    await loadBundleIntoSimulator(base64);
    if (generation !== sceneImportGeneration) return;
    currentBundle = base64;
    currentProject = project;
    setSceneBundle(base64, project, 'scenario-file');
    setConnectionStatus(`Loaded ${file.name}.`);
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
  return queueScenarioRequest(({ activeBridge }) =>
    activeBridge.loadBundle(base64, { timeoutMs: REQUEST_TIMEOUT_MS }),
  );
}

/**
 * Send one starting-rule change and adopt the simulator's returned snapshot.
 * The reply is authoritative: the simulator applied the change to its live
 * project, so nothing is reloaded into the frame and no captured copy is sent.
 */
async function updateFlags(kind, id, flag, value) {
  if (!bridgeReady || !bridge) return;
  try {
    await queueScenarioRequest(async ({ activeBridge, generation }) => {
      const base64 = await activeBridge.setSceneFlag(
        { kind, id, flag, value },
        { timeoutMs: REQUEST_TIMEOUT_MS },
      );
      if (generation !== sceneImportGeneration) return;
      const project = decodeSwarmBundle(base64ToBytes(base64));
      currentBundle = base64;
      currentProject = project;
      setSceneBundle(base64, project, 'scenario');
      setConnectionStatus('Scene rules saved to the simulator.');
    });
  } catch (error) {
    // Nothing was applied; put the table back to the captured state.
    renderSceneTable();
    showToast(
      `Could not save scene rules: ${error instanceof Error ? error.message : String(error)}`,
      'error',
    );
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
      editableProgram: describeDeviceEditableCode(device),
      onFlagChange: (flag, value) => updateFlags('device', device.id, flag, value),
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
      editableProgram: {
        checked: false,
        disabled: true,
        title: NO_EDITABLE_CODE_TOOLTIP,
      },
      onFlagChange: (flag, value) => updateFlags('node', node.id, flag, value),
    }));
  }
  table.append(head, body);
  host.append(table);
}

/**
 * The checkbox reflects the *active* editable snapshot on an unlocked device.
 * Whether it can be checked at all depends on the assigned artifact carrying a
 * recoverable program: a locked device must first be unlocked, and an
 * artifact-free device has nothing to reconstruct source from.
 */
function describeDeviceEditableCode(device) {
  const artifact = device.programArtifactId
    ? (currentProject?.artifacts ?? []).find((candidate) => candidate.id === device.programArtifactId)
    : undefined;
  const checked = Boolean(
    !device.locked &&
      device.editableProgram &&
      device.editableProgram.baseArtifactId === device.programArtifactId,
  );
  if (device.locked) {
    return { checked: false, disabled: true, title: UNLOCK_FOR_EDIT_TOOLTIP };
  }
  if (!artifact || !('program' in artifact)) {
    return { checked: false, disabled: true, title: NO_EDITABLE_CODE_TOOLTIP };
  }
  return { checked, disabled: false, title: undefined };
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
  const editable = flagCell('editableProgram', editableProgram.checked, (value) =>
    onFlagChange('editableProgram', value),
  );
  const checkbox = editable.querySelector('input');
  checkbox.disabled = editableProgram.disabled;
  if (editableProgram.title) checkbox.title = editableProgram.title;
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
