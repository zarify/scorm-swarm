import { getConfig, getSceneProject, notifyConfigChange, onConfigChange, onSceneChange } from './app.js';
import { createDefaultCondition, renderConditionEditor } from './condition-builder.js';

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

function addTest() {
  const config = getConfig();
  const tests = config.evaluation.test_cases;
  tests.push({
    id: makeUniqueId(tests),
    type: 'effect',
    points: 1,
    conditions: createDefaultCondition('serial_output'),
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
    meta.textContent = `${testCase.points ?? 1} point${testCase.points === 1 ? '' : 's'} · effect`;
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
  const testCase = getConfig().evaluation.test_cases[selectedTestIndex];
  container.replaceChildren();
  if (!testCase) {
    container.className = 'empty-state';
    const title = document.createElement('strong');
    title.textContent = 'Select a test to edit';
    const note = document.createElement('p');
    note.textContent = 'Each test checks effects visible through the simulator bridge.';
    container.append(title, note);
    return;
  }
  container.className = '';
  const heading = document.createElement('div');
  heading.className = 'detail-heading';
  heading.innerHTML = '<div><p class="eyebrow">Points-based check</p><h3>Test definition</h3></div><span class="count-badge">EFFECT</span>';
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

  const conditionShell = document.createElement('div');
  conditionShell.className = 'condition-editor-shell';
  const conditionHeading = document.createElement('div');
  conditionHeading.className = 'condition-editor-title';
  conditionHeading.innerHTML = '<strong>Pass conditions</strong><small>All configured conditions define this test</small>';
  const conditionHost = document.createElement('div');
  conditionShell.append(conditionHeading, conditionHost);
  container.append(conditionShell);
  renderConditionEditor({
    container: conditionHost,
    condition: testCase.conditions,
    scene: getSceneProject(),
    onChange: (conditions) => updateTest({ conditions }),
  });
}

function updateTest(patch) {
  const tests = getConfig().evaluation.test_cases;
  tests[selectedTestIndex] = { ...tests[selectedTestIndex], ...patch, type: 'effect' };
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
