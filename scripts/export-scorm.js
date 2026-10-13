import JSZip from 'jszip';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = join(root, 'dist/scorm-template');
const configPath = join(packageDir, 'config/activity_config.json');

function addDirectory(zip, source, current = source) {
  const entries = readdirSync(current, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    const absolute = join(current, entry.name);
    const packagePath = relative(source, absolute).split('\\').join('/');
    if (entry.isDirectory()) addDirectory(zip, source, absolute);
    else if (entry.isFile()) zip.file(packagePath, readFileSync(absolute));
  }
}

async function main() {
  if (!existsSync(join(packageDir, 'index.html')) || !existsSync(configPath)) {
    throw new Error('SCORM build missing — run `npm run build -- --target=scorm` first');
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (typeof config.metadata?.activity_id !== 'string' || config.metadata.activity_id.length === 0) {
    throw new Error('Built activity config has no metadata.activity_id');
  }
  const zip = new JSZip();
  addDirectory(zip, packageDir);
  const archive = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
  });
  const output = join(root, 'dist', `${config.metadata.activity_id}.zip`);
  mkdirSync(dirname(output), { recursive: true });
  await writeFile(output, archive);
  console.log(`Exported ${output} (${statSync(output).size} bytes)`);
}

main().catch((error) => {
  console.error(`export: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
