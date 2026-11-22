import { getConfig, getSceneProject, notifyConfigChange, onConfigChange, onSceneChange } from './app.js';
import { createDefaultCondition, renderConditionEditor } from './condition-builder.js';
import { enableListReordering, getSelectionIndexAfterMove, moveListItem } from './list-reorder.js';

let selectedHintIndex = -1;

const LED_FENCE_HELP =
  'For a micro:bit display, put five rows of five digits between standalone ```led and ``` lines. 0 is off; # is 9.';

/**
 * Section open state, one entry per edited hint object. Never serialized and
 * never written into the config: it only controls the local disclosure UI.
 */
const sectionOpenState = new WeakMap();

export function initHintsTab() {
  document.getElementById('btn-add-hint').addEventListener('click', addHint);
  onConfigChange((config, source) => {
    if (source === 'hints') {
      renderHintList();
      return;
    }
    clampSelection(config.hints);
    renderHintsTab();
  });
  if (selectedHintIndex < 0 && getConfig().hints.length > 0) selectedHintIndex = 0;
  onSceneChange(() => renderHintEditor());
  renderHintsTab();
}

function addHint() {
  const config = getConfig();
  const id = makeUniqueId('hint', config.hints);
  config.hints.push({
    id,
    trigger: {
      event: 'sim_event',
      conditions: createDefaultCondition('serial_output'),
      after_attempts: 0,
      invalidate_on_condition_false: false,
    },
    message: 'Look for a change in the simulation.',
    priority: 1,
    delay_seconds: 0,
    show_once: false,
    display_mode: 'triggered',
    style: 'info',
  });
  selectedHintIndex = config.hints.length - 1;
  notifyConfigChange('hints');
  renderHintsTab();
}

function removeHint(index) {
  const config = getConfig();
  config.hints.splice(index, 1);
  if (selectedHintIndex === index) selectedHintIndex = Math.min(index, config.hints.length - 1);
  else if (selectedHintIndex > index) selectedHintIndex -= 1;
  notifyConfigChange('hints');
  renderHintsTab();
}

function renderHintsTab() {
  renderHintList();
  renderHintEditor();
}

function renderHintList() {
  const hints = getConfig().hints;
  const list = document.getElementById('hint-list');
  list.replaceChildren();
  document.getElementById('hint-count').textContent = String(hints.length);
  if (hints.length === 0) {
    list.append(emptyRow('No hints yet. Add one when learners need a timely nudge.'));
    return;
  }
  hints.forEach((hint, index) => {
    const item = document.createElement('div');
    item.className = `list-item list-item-reorderable${index === selectedHintIndex ? ' selected' : ''}`;
    item.draggable = true;
    item.dataset.index = String(index);
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'list-item-select';
    select.setAttribute('aria-pressed', String(index === selectedHintIndex));
    select.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
    select.title = 'Drag to reorder. Alt+Arrow moves this row.';
    const text = document.createElement('span');
    text.className = 'list-item-title';
    text.textContent = hint.message?.trim() || hint.id || `Hint ${index + 1}`;
    const meta = document.createElement('small');
    meta.className = 'list-item-meta';
    meta.textContent = `${hint.trigger?.event ?? 'unconfigured'} · priority ${hint.priority ?? 1}`;
    select.append(text, meta);
    select.addEventListener('click', () => selectHint(index));
    select.addEventListener('keydown', (event) => {
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      const target = index + (event.key === 'ArrowUp' ? -1 : 1);
      if (target < 0 || target >= getConfig().hints.length) return;
      event.preventDefault();
      moveHint(index, target, event.key === 'ArrowUp' ? 'before' : 'after', true);
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'list-item-remove';
    remove.setAttribute('aria-label', `Remove hint ${hint.id}`);
    remove.textContent = '×';
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      removeHint(index);
    });
    item.append(select, remove);
    list.append(item);
  });
  enableListReordering(list, {
    itemSelector: '.list-item',
    onMove: moveHint,
  });
}

function moveHint(fromIndex, targetIndex, position, restoreFocus = false) {
  const hints = getConfig().hints;
  const moved = moveListItem(hints, fromIndex, targetIndex, position);
  if (!moved || !moved.changed) return;
  selectedHintIndex = getSelectionIndexAfterMove(selectedHintIndex, moved.fromIndex, moved.insertIndex);
  notifyConfigChange('hints');
  renderHintList();
  renderHintEditor();
  if (restoreFocus) {
    const button = document.getElementById('hint-list')
      ?.querySelector(`.list-item[data-index="${moved.insertIndex}"] .list-item-select`);
    if (button) button.focus();
  }
}

function renderHintEditor() {
  const container = document.getElementById('hint-editor-content');
  const hint = getConfig().hints[selectedHintIndex];
  container.replaceChildren();
  if (!hint) {
    container.className = 'empty-state';
    const title = document.createElement('strong');
    title.textContent = 'Select a hint to edit';
    const note = document.createElement('p');
    note.textContent = 'Add a hint to define its trigger, message, and display style.';
    container.append(title, note);
    return;
  }
  container.className = '';

  const heading = document.createElement('div');
  heading.className = 'detail-heading';
  heading.innerHTML = '<div><p class="eyebrow">Scaffold settings</p><h3>Hint definition</h3></div>';
  container.append(heading);

  const grid = document.createElement('div');
  grid.className = 'field-grid';
  appendTextField(grid, 'Hint ID', hint.id, (value) => updateHint({ id: value }));
  appendSelectField(grid, 'Trigger event', hint.trigger.event, [
    ['sim_event', 'Simulation event'],
    ['test_fail', 'Failed Check'],
    ['manual', 'Manual request'],
  ], (value) => updateTrigger({ event: value }));
  appendTextField(grid, 'Message', hint.message, (value) => updateHint({ message: value }), true, true, LED_FENCE_HELP);
  appendNumberField(grid, 'Priority', hint.priority, (value) => updateHint({ priority: value }), { minimum: 1, integer: true });
  appendNumberField(grid, 'Delay · seconds', hint.delay_seconds, (value) => updateHint({ delay_seconds: value }), { minimum: 0 });
  appendNumberField(grid, 'After Check attempts', hint.trigger.after_attempts,
    (value) => updateTrigger({ after_attempts: value }), { minimum: 0, integer: true });
  appendSelectField(grid, 'Display mode', hint.display_mode, [
    ['triggered', 'Show when triggered'], ['checklist', 'Always show in checklist'],
  ], (value) => updateHint({ display_mode: value }));
  appendSelectField(grid, 'Hint style', hint.style, [
    ['info', 'Information'], ['success', 'Success'], ['warning', 'Warning'],
  ], (value) => updateHint({ style: value }));
  appendCheckboxField(grid, 'Show once', hint.show_once, (value) => updateHint({ show_once: value }));
  appendCheckboxField(grid, 'Hide again if condition becomes false', hint.trigger.invalidate_on_condition_false,
    (value) => updateTrigger({ invalidate_on_condition_false: value }), true);
  container.append(grid);

  const conditionShell = document.createElement('details');
  conditionShell.className = 'condition-editor-shell';
  conditionShell.open = readSectionState(hint);
  const conditionHeading = document.createElement('summary');
  conditionHeading.className = 'condition-editor-title';
  conditionHeading.innerHTML = '<strong>Effect condition</strong><small>Evaluated against simulator events</small>';
  const conditionHost = document.createElement('div');
  conditionHost.className = 'condition-editor-body';
  conditionShell.append(conditionHeading, conditionHost);
  conditionShell.addEventListener('toggle', () => {
    sectionOpenState.set(hint, { condition: conditionShell.open });
  });
  container.append(conditionShell);
  renderConditionEditor({
    container: conditionHost,
    condition: hint.trigger.conditions,
    scene: getSceneProject(),
    onChange: (conditions) => updateTrigger({ conditions }),
  });

  function updateHint(patch) {
    const config = getConfig();
    const previous = config.hints[selectedHintIndex];
    const next = { ...previous, ...patch };
    config.hints[selectedHintIndex] = next;
    transferSectionState(previous, next);
    notifyConfigChange('hints');
    renderHintList();
  }

  function updateTrigger(patch) {
    const config = getConfig();
    const current = config.hints[selectedHintIndex];
    const next = { ...current, trigger: { ...current.trigger, ...patch } };
    config.hints[selectedHintIndex] = next;
    transferSectionState(current, next);
    notifyConfigChange('hints');
    renderHintList();
  }
}

function readSectionState(hint) {
  const state = sectionOpenState.get(hint);
  if (!state || typeof state.condition !== 'boolean') return true;
  return state.condition;
}

function transferSectionState(previous, next) {
  if (!previous || !next) return;
  const state = sectionOpenState.get(previous);
  if (state) sectionOpenState.set(next, state);
}

function selectHint(index) {
  // Re-rendering replaces the button that was just activated, so put focus
  // back on the selected row's button for keyboard users.
  const restoreFocus = document.activeElement?.classList.contains('list-item-select') === true;
  selectedHintIndex = index;
  renderHintList();
  renderHintEditor();
  if (restoreFocus) {
    const button = document.getElementById('hint-list')
      ?.querySelector(`.list-item[data-index="${index}"] .list-item-select`);
    if (button) button.focus();
  }
}

function clampSelection(hints) {
  if (hints.length === 0) selectedHintIndex = -1;
  else if (selectedHintIndex < 0 || selectedHintIndex >= hints.length) selectedHintIndex = 0;
}

function makeUniqueId(prefix, items) {
  let serial = items.length + 1;
  const existing = new Set(items.map((item) => item.id));
  while (existing.has(`${prefix}-${serial}`)) serial += 1;
  return `${prefix}-${serial}`;
}

function emptyRow(message) {
  const note = document.createElement('p');
  note.className = 'empty-note';
  note.textContent = message;
  return note;
}

function appendTextField(parent, labelText, value, onChange, wide = false, textarea = false, help = '') {
  const field = makeField(labelText, wide);
  const input = document.createElement(textarea ? 'textarea' : 'input');
  if (!textarea) input.type = 'text';
  input.value = value ?? '';
  input.addEventListener('change', () => onChange(input.value));
  field.append(input);
  if (help) {
    const note = document.createElement('small');
    note.className = 'field-help';
    note.textContent = help;
    field.append(note);
  }
  parent.append(field);
}

function appendNumberField(parent, labelText, value, onChange, { minimum, integer = false } = {}) {
  const field = makeField(labelText);
  const input = document.createElement('input');
  input.type = 'number';
  input.min = String(minimum);
  input.step = integer ? '1' : 'any';
  input.value = value ?? '';
  input.addEventListener('change', () => onChange(input.value === '' ? Number.NaN : Number(input.value)));
  field.append(input);
  parent.append(field);
}

function appendSelectField(parent, labelText, value, options, onChange) {
  const field = makeField(labelText);
  const select = document.createElement('select');
  for (const [optionValue, label] of options) {
    const option = document.createElement('option');
    option.value = optionValue;
    option.textContent = label;
    option.selected = value === optionValue;
    select.append(option);
  }
  select.addEventListener('change', () => onChange(select.value));
  field.append(select);
  parent.append(field);
}

function appendCheckboxField(parent, labelText, checked, onChange, wide = false) {
  const field = makeField('', wide);
  const label = document.createElement('label');
  label.className = 'inline-toggle';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked === true;
  input.addEventListener('change', () => onChange(input.checked));
  const text = document.createElement('span');
  text.textContent = labelText;
  label.append(input, text);
  field.append(label);
  parent.append(field);
}

function makeField(labelText, wide = false) {
  const field = document.createElement('div');
  field.className = wide ? 'field field--wide' : 'field';
  if (labelText) {
    const label = document.createElement('label');
    label.textContent = labelText;
    field.append(label);
  }
  return field;
}
