/**
 * Render a safe, limited subset of inline Markdown for student-facing strings.
 *
 * Supported syntax:
 * - `code`
 * - **bold**
 * - *italic*
 * - newline breaks
 * - standalone ```led fences holding five rows of five brightness digits
 */

import { parseLedLayout } from './led-display.js';

const LED_TOKEN_PREFIX = '\uE000LED';
const LED_TOKEN_SUFFIX = '\uE001';
const LED_SIZE = 80;
const LED_GRID_START = 12;
const LED_GRID_STEP = 14;
const LED_RADIUS = 4;

export function renderInlineMarkdown(value) {
  const text = (value == null ? '' : String(value)).replace(/\r\n/g, '\n');
  const { text: tokenized, blocks } = extractLedBlocks(text);
  let html = renderSegment(tokenized);
  blocks.forEach((pixels, index) => {
    html = html.replace(ledToken(index), renderLedScreen(pixels));
  });
  return html;
}

/**
 * Replace every valid standalone ```led block with an inert token so the
 * inline renderer never sees SVG markup as authored text. Malformed or
 * unclosed fences stay in the text and render as escaped literals.
 */
function extractLedBlocks(text) {
  const lines = text.split('\n');
  const blocks = [];
  const output = [];
  let index = 0;
  while (index < lines.length) {
    if (!isLedFence(lines[index])) {
      output.push(lines[index]);
      index += 1;
      continue;
    }
    let cursor = index + 1;
    while (cursor < lines.length && !isClosingFence(lines[cursor])) {
      if (isLedFence(lines[cursor])) break;
      cursor += 1;
    }
    // A new opener ends the malformed block here; restart at that opener so a
    // later valid fence still renders.
    if (cursor < lines.length && isLedFence(lines[cursor])) {
      output.push(...lines.slice(index, cursor));
      index = cursor;
      continue;
    }
    if (cursor >= lines.length) {
      output.push(...lines.slice(index));
      break;
    }
    const rows = lines.slice(index + 1, cursor).map((row) => row.trim());
    const pixels = parseLedLayout(rows.join('\n'));
    if (!pixels) {
      output.push(...lines.slice(index, cursor + 1));
      index = cursor + 1;
      continue;
    }
    output.push(ledToken(blocks.length));
    blocks.push(pixels);
    index = cursor + 1;
  }
  return { text: output.join('\n'), blocks };
}

function isLedFence(line) {
  return line.trim() === '```led';
}

function isClosingFence(line) {
  return line.trim() === '```';
}

function ledToken(index) {
  return `${LED_TOKEN_PREFIX}${index}${LED_TOKEN_SUFFIX}`;
}

function renderLedScreen(pixels) {
  const values = [];
  for (let index = 0; index < 25; index += 1) {
    const brightness = pixels[index];
    values.push(Number.isInteger(brightness) && brightness >= 0 && brightness <= 9 ? brightness : 0);
  }
  const rows = [];
  for (let row = 0; row < 5; row += 1) {
    rows.push(values.slice(row * 5, row * 5 + 5).join(''));
  }
  let cells = '';
  for (let row = 0; row < 5; row += 1) {
    for (let column = 0; column < 5; column += 1) {
      const brightness = values[row * 5 + column];
      const cx = LED_GRID_START + column * LED_GRID_STEP;
      const cy = LED_GRID_START + row * LED_GRID_STEP;
      cells +=
        `<circle cx="${cx}" cy="${cy}" r="${LED_RADIUS}" fill="#3a2a2a" data-brightness="${brightness}"/>` +
        (brightness > 0
          ? `<circle cx="${cx}" cy="${cy}" r="${LED_RADIUS}" fill="#ff2d2d" opacity="${(brightness / 9).toFixed(3)}"/>`
          : '');
    }
  }
  return (
    `<svg class="led-screen" width="${LED_SIZE}" height="${LED_SIZE}" viewBox="0 0 ${LED_SIZE} ${LED_SIZE}" role="img" aria-label="LED display rows: ${rows.join(' / ')}">` +
    `<rect width="${LED_SIZE}" height="${LED_SIZE}" rx="10" fill="#1b1b20"/>` +
    `${cells}</svg>`
  );
}

function renderSegment(text) {
  let html = '';

  for (let index = 0; index < text.length; index += 1) {
    if (text[index] === '\n') {
      html += '<br>';
      continue;
    }

    if (text[index] === '`') {
      const closingIndex = text.indexOf('`', index + 1);
      if (closingIndex > index + 1) {
        const codeContent = text.slice(index + 1, closingIndex);
        if (!codeContent.includes('\n')) {
          html += `<code>${escapeHtml(codeContent)}</code>`;
          index = closingIndex;
          continue;
        }
      }
    }

    if (text.startsWith('**', index)) {
      const closingIndex = findClosingDelimiter(text, index, '**');
      if (closingIndex !== -1) {
        html += `<strong>${renderSegment(text.slice(index + 2, closingIndex))}</strong>`;
        index = closingIndex + 1;
        continue;
      }
    }

    if (text[index] === '*') {
      const closingIndex = findClosingDelimiter(text, index, '*');
      if (closingIndex !== -1) {
        html += `<em>${renderSegment(text.slice(index + 1, closingIndex))}</em>`;
        index = closingIndex;
        continue;
      }
    }

    html += escapeHtml(text[index]);
  }

  return html;
}

function findClosingDelimiter(text, startIndex, delimiter) {
  let searchIndex = startIndex + delimiter.length;

  while (searchIndex < text.length) {
    const closingIndex = text.indexOf(delimiter, searchIndex);
    if (closingIndex === -1) {
      return -1;
    }

    const content = text.slice(startIndex + delimiter.length, closingIndex);
    if (content.trim()) {
      return closingIndex;
    }

    searchIndex = closingIndex + delimiter.length;
  }

  return -1;
}

function escapeHtml(text) {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
