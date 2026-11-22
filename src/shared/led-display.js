/**
 * Parse the authored five-row LED layout used by both grading and rendering.
 *
 * `0`–`9` are actual brightness values, `#` is exactly 9, and `.` is accepted
 * as legacy `0`. The input must be five trimmed lines of five characters
 * separated by LF. Returns a row-major array of 25 integers, or `null`.
 */
export function parseLedLayout(layout) {
  if (typeof layout !== 'string') return null;
  const rows = layout.split('\n');
  if (rows.length !== 5) return null;
  const pixels = [];
  for (const rawRow of rows) {
    const row = rawRow.trim();
    if (row.length !== 5) return null;
    for (const character of row) {
      if (character === '.' || character === '0') {
        pixels.push(0);
      } else if (character === '#') {
        pixels.push(9);
      } else if (character >= '1' && character <= '9') {
        pixels.push(character.charCodeAt(0) - 48);
      } else {
        return null;
      }
    }
  }
  return pixels;
}
