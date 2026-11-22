import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderInlineMarkdown } from '../src/shared/inline-markdown.js';

function brightnesses(html) {
  return [...html.matchAll(/data-brightness="(\d+)"/g)].map((match) => Number(match[1]));
}

function ledBlock(rows) {
  return ['```led', ...rows, '```'].join('\n');
}

const MIXED_ROWS = ['01#59', '00000', '00000', '00000', '00000'];

test('an LED fence renders row-major brightness in authored order', () => {
  const html = renderInlineMarkdown(`Watch **Alice**\n${ledBlock(MIXED_ROWS)}\nDone.`);
  assert.ok(html.includes('class="led-screen"'));
  assert.ok(html.includes('<strong>Alice</strong>'));
  assert.ok(html.includes('Done.'));
  assert.deepEqual(brightnesses(html), [0, 1, 9, 5, 9, ...new Array(20).fill(0)]);
  assert.ok(html.includes('aria-label="LED display rows: 01959 / 00000 / 00000 / 00000 / 00000"'));
});

test('multiple LED fences keep their own grids and surrounding text', () => {
  const rowsA = ['90000', '00000', '00000', '00000', '00000'];
  const rowsB = ['00000', '00000', '00000', '00000', '00009'];
  const html = renderInlineMarkdown(`First\n${ledBlock(rowsA)}\n*Middle*\n${ledBlock(rowsB)}\nLast`);
  assert.equal((html.match(/class="led-screen"/g) ?? []).length, 2);
  assert.equal(brightnesses(html).length, 50);
  assert.equal(brightnesses(html)[0], 9);
  assert.equal(brightnesses(html)[49], 9);
  assert.ok(html.includes('<em>Middle</em>'));
});

test('CRLF input and padded markers render the same block', () => {
  const padded = [
    '  ```led\t',
    ' 00000 ',
    '\t09090\t',
    ' 00000 ',
    ' 90009 ',
    ' 09990 ',
    '   ```   ',
  ].join('\r\n');
  const html = renderInlineMarkdown(padded);
  assert.equal((html.match(/class="led-screen"/g) ?? []).length, 1);
  assert.deepEqual(brightnesses(html), [
    0, 0, 0, 0, 0,
    0, 9, 0, 9, 0,
    0, 0, 0, 0, 0,
    9, 0, 0, 0, 9,
    0, 9, 9, 9, 0,
  ]);
});

test('malformed or unclosed fences stay escaped literal text', () => {
  const shortRow = renderInlineMarkdown(ledBlock(['000', '00000', '00000', '00000', '00000']));
  assert.ok(!shortRow.includes('<svg'));
  assert.ok(shortRow.includes('```led'));
  assert.ok(shortRow.includes('000'));

  const missingClosing = renderInlineMarkdown(['```led', '00000', '00000', '00000', '00000', '00000'].join('\n'));
  assert.ok(!missingClosing.includes('<svg'));
  assert.ok(missingClosing.includes('```led'));

  const fourRows = renderInlineMarkdown(ledBlock(['00000', '00000', '00000', '00000']));
  assert.ok(!fourRows.includes('<svg'));
});

test('a later LED opener still starts a block after a malformed one', () => {
  const html = renderInlineMarkdown(
    ['```led', '00000', ledBlock(['00000', '09090', '00000', '90009', '09990'])].join('\n'),
  );
  assert.equal((html.match(/class="led-screen"/g) ?? []).length, 1);
  assert.ok(html.includes('```led'));
  assert.deepEqual(brightnesses(html).slice(0, 5), [0, 0, 0, 0, 0]);
  assert.equal(brightnesses(html).length, 25);
});

test('hostile content is never emitted as SVG or raw markup', () => {
  const hostileBlock = renderInlineMarkdown(
    ledBlock(['<svg>', 'onloa', 'd=ale', 'rt(1)', '00000']),
  );
  assert.ok(!hostileBlock.includes('<svg class="led-screen"'));
  assert.ok(!hostileBlock.includes('<script'));
  assert.ok(hostileBlock.includes('&lt;svg&gt;'));

  const hostileProse = renderInlineMarkdown('<script>alert(1)</script> <svg onload="x()">');
  assert.equal(hostileProse, '&lt;script&gt;alert(1)&lt;/script&gt; &lt;svg onload=&quot;x()&quot;&gt;');

  const otherFence = renderInlineMarkdown(['```js', '00000', '```'].join('\n'));
  assert.ok(!otherFence.includes('<svg'));
  assert.ok(otherFence.includes('```js'));
});
