export function appendSelect(fields, labelText, selected, options, onChange) {
  const field = makeField(labelText);
  const select = document.createElement('select');
  for (const [value, text] of options) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = text;
    option.selected = selected === value;
    select.append(option);
  }
  select.addEventListener('change', () => onChange(select.value));
  field.append(select);
  fields.append(field);
}

export function appendText(fields, labelText, value, onChange, wide = false) {
  const field = makeField(labelText, wide);
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value ?? '';
  input.addEventListener('change', () => onChange(input.value));
  field.append(input);
  fields.append(field);
}

export function appendNumber(fields, labelText, value, onChange, { integer = false, nullable = false, minimum, step, placeholder } = {}) {
  const field = makeField(labelText);
  const input = document.createElement('input');
  input.type = 'number';
  input.step = step ?? (integer ? '1' : 'any');
  if (minimum !== undefined) input.min = String(minimum);
  input.value = value == null ? '' : String(value);
  input.placeholder = placeholder ?? (nullable ? 'Any' : '');
  input.addEventListener('change', () => {
    if (input.value === '') onChange(nullable ? null : Number.NaN);
    else onChange(Number(input.value));
  });
  field.append(input);
  fields.append(field);
}

export function appendCheckbox(fields, labelText, checked, onChange) {
  const field = makeField(labelText);
  field.classList.add('condition-checkbox-field');
  const label = document.createElement('label');
  label.className = 'inline-toggle';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  const text = document.createElement('span');
  text.textContent = labelText;
  label.append(input, text);
  field.replaceChildren(label);
  fields.append(field);
}

export function makeField(labelText, wide = false) {
  const field = document.createElement('div');
  field.className = wide ? 'condition-field condition-field--wide' : 'condition-field';
  const label = document.createElement('label');
  label.textContent = labelText;
  field.append(label);
  return field;
}

export function makeButton(text, label, disabled, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'condition-order-button';
  button.textContent = text;
  button.setAttribute('aria-label', label);
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}
