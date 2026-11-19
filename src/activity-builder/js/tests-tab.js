import { getConfig, getSceneProject, notifyConfigChange, onConfigChange, onSceneChange } from './app.js';
import { actionSummary, actionTitle, createDefaultAction, renderActionEditor } from './action-builder.js';
import { conditionSummary, createDefaultCondition, renderConditionEditor } from './condition-builder.js';
import { makeButton } from './form-fields.js';
import { enableListReordering, getSelectionIndexAfterMove, moveListItem } from './list-reorder.js';

const DEFAULT_TIMEOUT_MS = 5000;

let selectedTestIndex = -1;

/**
 * Section open state, one entry per edited test object. Never serialized and
 * never written into the config: it only controls the local disclosure UI.
 */
const sectionOpenState = new WeakMap();
/** Collapsed trigger actions and flow steps, keyed by the edited object. */
const collapsedCards = new WeakSet();

export function initTestsTab() {
  document.getElementById('btn-add-test').addEventListener('click', addTest);
  onConfigChange((config, source) => {
    if (source === 'tests') {
      renderTestList();
      updatePointsIndicator();
      return;
    }
    clampSelection(config.evaluation.test_cases);
    renderTestsTab();
  });
  clampSelection(getConfig().evaluation.test_cases);
  onSceneChange(() => renderTestEditor());
  renderTestsTab();
}

function currentTest() {
  return getConfig().evaluation.test_cases[selectedTestIndex];
}

function addTest() {
  const config = getConfig();
  const tests = config.evaluation.test_cases;
  tests.push({
    id: makeUniqueId(tests),
    points: 1,
    trigger: [createDefaultAction('press_button')],
    steps: [{ type: 'check', condition: createDefaultCondition('serial_output'), timeout_ms: DEFAULT_TIMEOUT_MS }],
  });
  selectedTestIndex = tests.length - 1;
  notifyConfigChange('tests');
  renderTestsTab();
}

function removeTest(index) {
  const tests = getConfig().evaluation.test_cases;
  tests.splice(index, 1);
  if (selectedTestIndex === index) selectedTestIndex = Math.min(index, tests.length - 1);
  else if (selectedTestIndex > index) selectedTestIndex -= 1;
  notifyConfigChange('tests');
  renderTestsTab();
}

function renderTestsTab() {
  renderTestList();
  renderTestEditor();
  updatePointsIndicator();
}

function renderTestList() {
  const tests = getConfig().evaluation.test_cases;
  const list = document.getElementById('test-list');
  list.replaceChildren();
  document.getElementById('test-count').textContent = String(tests.length);
  if (tests.length === 0) {
    const note = document.createElement('p');
    note.className = 'empty-note';
    note.textContent = 'At least one graded test is required for a score.';
    list.append(note);
    return;
  }
  tests.forEach((testCase, index) => {
    const item = document.createElement('div');
    item.className = `list-item list-item-reorderable${index === selectedTestIndex ? ' selected' : ''}`;
    item.draggable = true;
    item.dataset.index = String(index);
    const select = document.createElement('button');
    select.type = 'button';
    select.className = 'list-item-select';
    select.setAttribute('aria-pressed', String(index === selectedTestIndex));
    select.setAttribute('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
    select.title = 'Drag to reorder. Alt+Arrow moves this row.';
    const title = document.createElement('span');
    title.className = 'list-item-title';
    title.textContent = testCase.id || `Test ${index + 1}`;
    const meta = document.createElement('small');
    meta.className = 'list-item-meta';
    meta.textContent = `${testCase.points ?? 1} pt(s) · ${testCase.trigger?.length ?? 0} action(s) · ${testCase.steps?.length ?? 0} step(s)`;
    select.append(title, meta);
    select.addEventListener('click', () => selectTest(index));
    select.addEventListener('keydown', (event) => {
      if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      const target = index + (event.key === 'ArrowUp' ? -1 : 1);
      if (target < 0 || target >= getConfig().evaluation.test_cases.length) return;
      event.preventDefault();
      moveTest(index, target, event.key === 'ArrowUp' ? 'before' : 'after', true);
    });
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'list-item-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove test ${testCase.id}`);
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      removeTest(index);
    });
    item.append(select, remove);
    list.append(item);
  });
  enableListReordering(list, {
    itemSelector: '.list-item',
    onMove: moveTest,
  });
}

function renderTestEditor() {
  const container = document.getElementById('test-editor-content');
  const testCase = currentTest();
  container.replaceChildren();
  if (!testCase) {
    container.className = 'empty-state';
    const title = document.createElement('strong');
    title.textContent = 'Select a test to edit';
    const note = document.createElement('p');
    note.textContent = 'Each test injects a trigger of actions, then runs ordered checks against the simulator.';
    container.append(title, note);
    return;
  }
  container.className = '';
  const heading = document.createElement('div');
  heading.className = 'detail-heading';
  heading.innerHTML = '<div><h3>Scripted test</h3></div>';
  container.append(heading);

  const grid = document.createElement('div');
  grid.className = 'field-grid';
  appendTextField(grid, 'Test ID', testCase.id, (value) => updateTest({ id: value }));
  appendNumberField(grid, 'Points', testCase.points ?? 1, (value) => updateTest({ points: value }), { minimum: 0, integer: true });
  container.append(grid);

  container.append(renderTriggerShell(testCase));
  container.append(renderFlowShell(testCase));
  container.append(renderFeedbackShell(testCase));
}

function renderTriggerShell(testCase) {
  const trigger = Array.isArray(testCase.trigger) ? testCase.trigger : [];
  const body = document.createElement('div');
  body.className = 'condition-editor-body';
  const list = document.createElement('div');
  list.className = 'action-list';
  trigger.forEach((action, index) => {
    list.append(renderTriggerRow(action, index, trigger.length));
  });
  body.append(list);
  const add = makeButton('+ Add action', 'Add trigger action', false, addTriggerAction);
  add.classList.add('btn', 'btn-small', 'btn-secondary', 'add-sub-condition');
  body.append(add);
  return renderDisclosureSection({
    testCase,
    section: 'trigger',
    title: 'Trigger',
    help: 'Injected actions run first, in order',
    countLabel: `${trigger.length} action${trigger.length === 1 ? '' : 's'}`,
    body,
  });
}

function renderTriggerRow(action, index, count) {
  const row = document.createElement('div');
  row.className = 'action-row';
  const collapsed = collapsedCards.has(action);
  const header = document.createElement('div');
  header.className = 'action-card-header';
  const toggle = makeRowToggle(!collapsed, `action ${index + 1}`);
  const title = document.createElement('strong');
  title.className = 'action-card-title';
  title.textContent = actionTitle(action);
  const summary = document.createElement('span');
  summary.className = 'action-card-summary';
  summary.textContent = actionSummary(action);
  const controls = document.createElement('div');
  controls.className = 'condition-order-controls';
  controls.append(
    makeButton('↑', 'Move action up', index === 0, () => moveTriggerAction(index, -1)),
    makeButton('↓', 'Move action down', index === count - 1, () => moveTriggerAction(index, 1)),
    makeButton('×', `Remove action ${index + 1}`, false, () => removeTriggerAction(index)),
  );
  header.append(toggle, title, summary, controls);

  const body = document.createElement('div');
  body.className = 'action-row-body';
  body.hidden = collapsed;
  const host = document.createElement('div');
  renderActionEditor({
    container: host,
    action,
    scene: getSceneProject(),
    onChange: (nextAction) => replaceTriggerAction(index, nextAction),
  });
  body.append(host);
  bindRowToggle(toggle, body, action, `action ${index + 1}`);
  row.append(header, body);
  return row;
}

function renderFlowShell(testCase) {
  const steps = Array.isArray(testCase.steps) ? testCase.steps : [];
  const body = document.createElement('div');
  body.className = 'condition-editor-body';
  const list = document.createElement('div');
  list.className = 'step-list';
  steps.forEach((step, index) => {
    list.append(renderStepCard(step, index, steps.length));
  });
  body.append(list);
  const addRow = document.createElement('div');
  addRow.className = 'step-add-row';
  const addAction = makeButton('+ Add action step', 'Add action step', false, () => addStep('action'));
  addAction.classList.add('btn', 'btn-small', 'btn-secondary');
  const addCheck = makeButton('+ Add check step', 'Add check step', false, () => addStep('check'));
  addCheck.classList.add('btn', 'btn-small', 'btn-secondary');
  addRow.append(addAction, addCheck);
  body.append(addRow);
  return renderDisclosureSection({
    testCase,
    section: 'flow',
    title: 'Test flow',
    help: 'Steps run in order and stop at the first failing step',
    countLabel: `${steps.length} step${steps.length === 1 ? '' : 's'}`,
    body,
  });
}

function renderStepCard(step, index, count) {
  const isAction = step.type === 'action';
  const collapsed = collapsedCards.has(step);
  const card = document.createElement('div');
  card.className = 'step-card';
  const header = document.createElement('div');
  header.className = 'step-header';
  const toggle = makeRowToggle(!collapsed, `step ${index + 1}`);
  const number = document.createElement('span');
  number.className = 'step-index';
  number.textContent = String(index + 1);
  const badge = document.createElement('span');
  badge.className = 'step-kind-badge';
  badge.dataset.kind = isAction ? 'action' : 'check';
  badge.textContent = isAction ? 'Do' : 'Check';
  const summary = document.createElement('span');
  summary.className = 'action-card-summary';
  summary.textContent = isAction ? actionSummary(step.action) : conditionSummary(step.condition);
  const controls = document.createElement('div');
  controls.className = 'condition-order-controls';
  controls.append(
    makeButton('↑', 'Move step up', index === 0, () => moveStep(index, -1)),
    makeButton('↓', 'Move step down', index === count - 1, () => moveStep(index, 1)),
    makeButton('×', `Remove step ${index + 1}`, false, () => removeStep(index)),
  );
  header.append(toggle, number, badge, summary, controls);
  card.append(header);

  const body = document.createElement('div');
  body.className = 'step-body';
  body.hidden = collapsed;
  renderStepBody(body, step, index);
  bindRowToggle(toggle, body, step, `step ${index + 1}`);
  card.append(body);
  return card;
}

function renderStepBody(body, step, index) {
  body.replaceChildren();
  const host = document.createElement('div');
  if (step.type === 'action') {
    renderActionEditor({
      container: host,
      action: step.action,
      scene: getSceneProject(),
      onChange: (nextAction) => updateStep(index, { action: nextAction }),
    });
    body.append(host);
    return;
  }
  renderConditionEditor({
    container: host,
    condition: step.condition,
    scene: getSceneProject(),
    allowNodeDistance: true,
    onChange: (nextCondition) => updateStep(index, { condition: nextCondition }),
  });
  body.append(host, renderTimeoutField(step, index));
}

function renderTimeoutField(step, index) {
  const timeout = document.createElement('div');
  timeout.className = 'step-timeout';
  const field = makeField('Timeout (ms)');
  const input = document.createElement('input');
  input.type = 'number';
  input.min = '0';
  input.step = 'any';
  input.value = String(Number.isFinite(step.timeout_ms) ? step.timeout_ms : DEFAULT_TIMEOUT_MS);
  input.addEventListener('change', () => {
    if (input.value === '') {
      input.value = String(DEFAULT_TIMEOUT_MS);
      updateStep(index, { timeout_ms: DEFAULT_TIMEOUT_MS });
      return;
    }
    // Negative values are stored as typed so config validation can reject them.
    updateStep(index, { timeout_ms: Number(input.value) });
  });
  const help = document.createElement('small');
  help.className = 'field-help';
  help.textContent = '0 checks the current evidence once.';
  field.append(input, help);
  timeout.append(field);
  return timeout;
}

function renderFeedbackShell(testCase) {
  const shell = document.createElement('section');
  shell.className = 'condition-editor-shell';
  const title = document.createElement('div');
  title.className = 'condition-editor-title';
  title.innerHTML = '<strong>Feedback</strong><small>Shown to the learner with the graded result</small>';
  const grid = document.createElement('div');
  grid.className = 'field-grid';
  appendTextField(grid, 'Feedback on pass', testCase.feedback_on_pass ?? '',
    (value) => updateTest({ feedback_on_pass: value }), true, true);
  appendTextField(grid, 'Feedback on fail', testCase.feedback_on_fail ?? '',
    (value) => updateTest({ feedback_on_fail: value }), true, true);
  shell.append(title, grid);
  return shell;
}

function renderDisclosureSection({ testCase, section, title, help, countLabel, body }) {
  const shell = document.createElement('details');
  shell.className = 'condition-editor-shell';
  shell.open = readSectionState(sectionOpenState, testCase, section);
  const summary = document.createElement('summary');
  summary.className = 'condition-editor-title';
  const heading = document.createElement('strong');
  heading.textContent = title;
  const note = document.createElement('small');
  note.textContent = help;
  const count = document.createElement('span');
  count.className = 'condition-editor-count';
  count.textContent = countLabel;
  summary.append(heading, note, count);
  shell.append(summary, body);
  shell.addEventListener('toggle', () => {
    writeSectionState(sectionOpenState, testCase, section, shell.open);
  });
  return shell;
}

function readSectionState(map, key, section) {
  const state = map.get(key);
  if (!state || typeof state[section] !== 'boolean') return true;
  return state[section];
}

function writeSectionState(map, key, section, open) {
  let state = map.get(key);
  if (!state) {
    state = {};
    map.set(key, state);
  }
  state[section] = open;
}

function transferSectionState(map, previous, next) {
  if (!previous || !next) return;
  const state = map.get(previous);
  if (state) map.set(next, state);
}

function makeRowToggle(expanded, noun) {
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'row-toggle';
  toggle.textContent = '▸';
  toggle.setAttribute('aria-expanded', String(expanded));
  toggle.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} ${noun}`);
  return toggle;
}

function bindRowToggle(toggle, body, key, noun) {
  toggle.addEventListener('click', () => {
    const collapsed = !collapsedCards.has(key);
    if (collapsed) collapsedCards.add(key);
    else collapsedCards.delete(key);
    body.hidden = collapsed;
    toggle.setAttribute('aria-expanded', String(!collapsed));
    toggle.setAttribute('aria-label', `${collapsed ? 'Expand' : 'Collapse'} ${noun}`);
  });
}

function transferCollapsed(previous, next) {
  if (collapsedCards.has(previous)) collapsedCards.add(next);
}

function moveTest(fromIndex, targetIndex, position, restoreFocus = false) {
  const tests = getConfig().evaluation.test_cases;
  const moved = moveListItem(tests, fromIndex, targetIndex, position);
  if (!moved || !moved.changed) return;
  selectedTestIndex = getSelectionIndexAfterMove(selectedTestIndex, moved.fromIndex, moved.insertIndex);
  notifyConfigChange('tests');
  renderTestList();
  renderTestEditor();
  if (restoreFocus) focusListRow('test-list', moved.insertIndex);
}

function focusListRow(listId, index) {
  const button = document.getElementById(listId)
    ?.querySelector(`.list-item[data-index="${index}"] .list-item-select`);
  if (button) button.focus();
}

function replaceTriggerAction(index, action) {
  const trigger = [...(currentTest().trigger ?? [])];
  transferCollapsed(trigger[index], action);
  trigger[index] = action;
  updateTest({ trigger });
  renderTestEditor();
}

function removeTriggerAction(index) {
  const testCase = currentTest();
  updateTest({ trigger: (testCase.trigger ?? []).filter((_, actionIndex) => actionIndex !== index) });
  renderTestEditor();
}

function moveTriggerAction(index, delta) {
  const trigger = [...(currentTest().trigger ?? [])];
  const target = index + delta;
  if (target < 0 || target >= trigger.length) return;
  [trigger[index], trigger[target]] = [trigger[target], trigger[index]];
  updateTest({ trigger });
  renderTestEditor();
}

function addTriggerAction() {
  const trigger = [...(currentTest().trigger ?? []), createDefaultAction()];
  updateTest({ trigger });
  renderTestEditor();
}

function updateStep(index, patch) {
  const steps = [...(currentTest().steps ?? [])];
  const previous = steps[index];
  const next = { ...previous, ...patch };
  transferCollapsed(previous, next);
  steps[index] = next;
  updateTest({ steps });
  refreshStepCard(index, previous, next);
}

/**
 * Keep the rendered card in sync without replacing the whole editor: the
 * header controls stay mounted while a field's blur-triggered change is
 * still being dispatched. The body is rebuilt only when the step kind of the
 * authored object changes (a condition editor refreshes its own subtree).
 */
function refreshStepCard(index, previous, next) {
  const card = document.querySelectorAll('#test-editor-content .step-card')[index];
  if (!card) return;
  const summary = card.querySelector('.action-card-summary');
  if (summary) summary.textContent = stepSummary(next);
  const kindChanged = previous?.type !== next.type;
  const actionTypeChanged = previous?.action?.type !== next.action?.type;
  if (!kindChanged && !actionTypeChanged) return;
  const body = card.querySelector('.step-body');
  if (body) renderStepBody(body, next, index);
}

function stepSummary(step) {
  return step.type === 'action' ? actionSummary(step.action) : conditionSummary(step.condition);
}

function removeStep(index) {
  const testCase = currentTest();
  updateTest({ steps: (testCase.steps ?? []).filter((_, stepIndex) => stepIndex !== index) });
  renderTestEditor();
}

function moveStep(index, delta) {
  const steps = [...(currentTest().steps ?? [])];
  const target = index + delta;
  if (target < 0 || target >= steps.length) return;
  [steps[index], steps[target]] = [steps[target], steps[index]];
  updateTest({ steps });
  renderTestEditor();
}

function addStep(kind) {
  const step = kind === 'action'
    ? { type: 'action', action: createDefaultAction() }
    : { type: 'check', condition: createDefaultCondition('serial_output'), timeout_ms: DEFAULT_TIMEOUT_MS };
  const steps = [...(currentTest().steps ?? []), step];
  updateTest({ steps });
  renderTestEditor();
}

function updateTest(patch) {
  const tests = getConfig().evaluation.test_cases;
  const previous = tests[selectedTestIndex];
  const next = { ...previous, ...patch };
  tests[selectedTestIndex] = next;
  transferSectionState(sectionOpenState, previous, next);
  notifyConfigChange('tests');
  renderTestList();
  updatePointsIndicator();
}

function updatePointsIndicator() {
  const tests = getConfig().evaluation.test_cases;
  const total = tests.reduce((sum, testCase) =>
    sum + (Number.isInteger(testCase.points) && testCase.points >= 0 ? testCase.points : 0), 0);
  const indicator = document.getElementById('points-indicator');
  indicator.replaceChildren();
  const strong = document.createElement('strong');
  strong.textContent = `${total} point${total === 1 ? '' : 's'}`;
  const text = document.createElement('span');
  text.textContent = ' available across this activity';
  indicator.append(strong, text);
}

function selectTest(index) {
  // Re-rendering replaces the button that was just activated, so put focus
  // back on the moved row's button for keyboard users.
  const restoreFocus = document.activeElement?.classList.contains('list-item-select') === true;
  selectedTestIndex = index;
  renderTestList();
  renderTestEditor();
  if (restoreFocus) focusListRow('test-list', index);
}

function clampSelection(tests) {
  if (tests.length === 0) selectedTestIndex = -1;
  else if (selectedTestIndex < 0 || selectedTestIndex >= tests.length) selectedTestIndex = 0;
}

function makeUniqueId(tests) {
  const existing = new Set(tests.map((testCase) => testCase.id));
  let serial = tests.length + 1;
  while (existing.has(`test-${serial}`)) serial += 1;
  return `test-${serial}`;
}

function appendTextField(parent, labelText, value, onChange, wide = false, textarea = false) {
  const field = makeField(labelText, wide);
  const input = document.createElement(textarea ? 'textarea' : 'input');
  if (!textarea) input.type = 'text';
  input.value = value ?? '';
  input.addEventListener('change', () => onChange(input.value));
  field.append(input);
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

function makeField(labelText, wide = false) {
  const field = document.createElement('div');
  field.className = wide ? 'field field--wide' : 'field';
  const label = document.createElement('label');
  label.textContent = labelText;
  field.append(label);
  return field;
}
