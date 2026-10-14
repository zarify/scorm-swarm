import { getConfig, getSceneProject, notifyConfigChange, onConfigChange, onSceneChange } from './app.js';
import { createDefaultAction, renderActionEditor } from './action-builder.js';
import { createDefaultCondition, renderConditionEditor } from './condition-builder.js';
import { makeButton } from './form-fields.js';

let selectedTestIndex = -1;

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
    steps: [{ type: 'check', condition: createDefaultCondition('serial_output'), timeout_seconds: 5 }],
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
    item.className = `list-item${index === selectedTestIndex ? ' selected' : ''}`;
    item.tabIndex = 0;
    item.setAttribute('role', 'button');
    item.setAttribute('aria-pressed', String(index === selectedTestIndex));
    const title = document.createElement('span');
    title.className = 'list-item-title';
    title.textContent = testCase.id || `Test ${index + 1}`;
    const meta = document.createElement('small');
    meta.className = 'list-item-meta';
    meta.textContent = `${testCase.points ?? 1} pt(s) · ${testCase.trigger?.length ?? 0} action(s) · ${testCase.steps?.length ?? 0} step(s)`;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'list-item-remove';
    remove.textContent = '×';
    remove.setAttribute('aria-label', `Remove test ${testCase.id}`);
    remove.addEventListener('click', (event) => {
      event.stopPropagation();
      removeTest(index);
    });
    item.append(title, meta, remove);
    item.addEventListener('click', () => selectTest(index));
    item.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectTest(index);
      }
    });
    list.append(item);
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
  appendTextField(grid, 'Feedback on pass', testCase.feedback_on_pass ?? '',
    (value) => updateTest({ feedback_on_pass: value }), true, true);
  appendTextField(grid, 'Feedback on fail', testCase.feedback_on_fail ?? '',
    (value) => updateTest({ feedback_on_fail: value }), true, true);
  container.append(grid);

  container.append(renderTriggerShell(testCase));
  container.append(renderFlowShell(testCase));
}

function renderTriggerShell(testCase) {
  const shell = document.createElement('div');
  shell.className = 'condition-editor-shell';
  const title = document.createElement('div');
  title.className = 'condition-editor-title';
  title.innerHTML = '<strong>Trigger</strong><small>Injected actions run first, in order</small>';
  const list = document.createElement('div');
  list.className = 'action-list';
  const trigger = Array.isArray(testCase.trigger) ? testCase.trigger : [];
  trigger.forEach((action, index) => {
    const row = document.createElement('div');
    row.className = 'action-row';
    const controls = document.createElement('div');
    controls.className = 'condition-order-controls';
    controls.append(
      makeButton('↑', 'Move action up', index === 0, () => moveTriggerAction(index, -1)),
      makeButton('↓', 'Move action down', index === trigger.length - 1, () => moveTriggerAction(index, 1)),
    );
    const host = document.createElement('div');
    renderActionEditor({
      container: host,
      action,
      scene: getSceneProject(),
      onChange: (nextAction) => replaceTriggerAction(index, nextAction),
      onRemove: () => removeTriggerAction(index),
    });
    row.append(controls, host);
    list.append(row);
  });
  const add = makeButton('+ Add action', 'Add trigger action', false, addTriggerAction);
  add.classList.add('btn', 'btn-small', 'btn-secondary', 'add-sub-condition');
  shell.append(title, list, add);
  return shell;
}

function renderFlowShell(testCase) {
  const shell = document.createElement('div');
  shell.className = 'condition-editor-shell';
  const title = document.createElement('div');
  title.className = 'condition-editor-title';
  title.innerHTML = '<strong>Test flow</strong><small>Steps run in order and stop at the first failing step</small>';
  const list = document.createElement('div');
  list.className = 'step-list';
  const steps = Array.isArray(testCase.steps) ? testCase.steps : [];
  steps.forEach((step, index) => {
    list.append(renderStepCard(step, index, steps.length));
  });
  const addRow = document.createElement('div');
  addRow.className = 'step-add-row';
  const addAction = makeButton('+ Add action step', 'Add action step', false, () => addStep('action'));
  addAction.classList.add('btn', 'btn-small', 'btn-secondary');
  const addCheck = makeButton('+ Add check step', 'Add check step', false, () => addStep('check'));
  addCheck.classList.add('btn', 'btn-small', 'btn-secondary');
  addRow.append(addAction, addCheck);
  shell.append(title, list, addRow);
  return shell;
}

function renderStepCard(step, index, count) {
  const isAction = step.type === 'action';
  const card = document.createElement('div');
  card.className = 'step-card';
  const header = document.createElement('div');
  header.className = 'step-header';
  const badge = document.createElement('span');
  badge.className = 'step-kind-badge';
  badge.dataset.kind = isAction ? 'action' : 'check';
  badge.textContent = isAction ? 'Do' : 'Check';
  const controls = document.createElement('div');
  controls.className = 'condition-order-controls';
  controls.append(
    makeButton('↑', 'Move step up', index === 0, () => moveStep(index, -1)),
    makeButton('↓', 'Move step down', index === count - 1, () => moveStep(index, 1)),
    makeButton('×', `Remove step ${index + 1}`, false, () => removeStep(index)),
  );
  header.append(badge, controls);
  card.append(header);

  const host = document.createElement('div');
  if (isAction) {
    renderActionEditor({
      container: host,
      action: step.action,
      scene: getSceneProject(),
      onChange: (nextAction) => updateStep(index, { action: nextAction }),
    });
    card.append(host);
  } else {
    renderConditionEditor({
      container: host,
      condition: step.condition,
      scene: getSceneProject(),
      onChange: (nextCondition) => updateStep(index, { condition: nextCondition }),
    });
    const timeout = document.createElement('div');
    timeout.className = 'step-timeout';
    appendNumberField(timeout, 'Timeout seconds', step.timeout_seconds ?? 5,
      (value) => updateStep(index, { timeout_seconds: value }), { minimum: 0 });
    card.append(host, timeout);
  }
  return card;
}

function replaceTriggerAction(index, action) {
  const trigger = [...(currentTest().trigger ?? [])];
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
  steps[index] = { ...steps[index], ...patch };
  updateTest({ steps });
  renderTestEditor();
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
    : { type: 'check', condition: createDefaultCondition('serial_output'), timeout_seconds: 5 };
  const steps = [...(currentTest().steps ?? []), step];
  updateTest({ steps });
  renderTestEditor();
}

function updateTest(patch) {
  const tests = getConfig().evaluation.test_cases;
  tests[selectedTestIndex] = { ...tests[selectedTestIndex], ...patch };
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
  selectedTestIndex = index;
  renderTestList();
  renderTestEditor();
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
