import esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeConfig } from '../src/shared/config-normalizer.js';
import { validateConfig } from '../src/shared/config-validator.js';
import { decodeSwarmBundle } from '../src/shared/swarm-bundle.js';
import { generateManifest } from '../src/activity-builder/js/export.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'src');
const dist = join(root, 'dist');
const simDist = join(dist, 'sim');
const DEFAULT_CONFIG = 'examples/demo-activity.json';
const DEFAULT_SCENE = 'examples/two-device-demo.swarm';

function parseArguments(args) {
  const options = { target: 'all', config: DEFAULT_CONFIG, scene: DEFAULT_SCENE };
  for (const argument of args) {
    if (argument.startsWith('--target=')) options.target = argument.slice('--target='.length);
    else if (argument.startsWith('--config=')) options.config = argument.slice('--config='.length);
    else if (argument.startsWith('--scene=')) options.scene = argument.slice('--scene='.length);
    else throw new Error(`Unknown build option: ${argument}`);
  }
  if (!['all', 'builder', 'scorm'].includes(options.target)) {
    throw new Error(`Unknown build target: ${options.target}. Use builder or scorm.`);
  }
  return options;
}

function resolveInput(path) {
  return isAbsolute(path) ? path : resolve(root, path);
}

function readActivityConfig(path) {
  const configPath = resolveInput(path);
  if (!existsSync(configPath)) throw new Error(`Activity config not found: ${configPath}`);
  const config = normalizeConfig(JSON.parse(readFileSync(configPath, 'utf8')));
  const validation = validateConfig(config);
  if (!validation.valid) {
    throw new Error(validation.errors.map((error) => `${error.path || 'config'}: ${error.message}`).join('\n'));
  }
  return config;
}

function readScene(path) {
  const scenePath = resolveInput(path);
  if (!existsSync(scenePath)) throw new Error(`Scene bundle not found: ${scenePath}`);
  const bytes = new Uint8Array(readFileSync(scenePath));
  decodeSwarmBundle(bytes);
  return bytes;
}

async function bundle(entry, outfile) {
  await esbuild.build({
    absWorkingDir: root,
    entryPoints: [entry],
    bundle: true,
    format: 'iife',
    target: ['es2022'],
    outfile,
    sourcemap: false,
    legalComments: 'none',
  });
}

function copyIfPresent(from, to) {
  if (existsSync(from)) cpSync(from, to, { recursive: true });
}

function copySimulator(destination) {
  if (!existsSync(join(simDist, 'index.html'))) return false;
  const simTarget = join(destination, 'sim');
  rmSync(simTarget, { recursive: true, force: true });
  cpSync(simDist, simTarget, { recursive: true });
  const filesSource = join(dist, 'sim-files.json');
  if (existsSync(filesSource)) cpSync(filesSource, join(destination, 'sim-files.json'));
  return true;
}

async function buildBuilder() {
  const output = join(dist, 'builder');
  rmSync(output, { recursive: true, force: true });
  mkdirSync(join(output, 'js'), { recursive: true });
  mkdirSync(join(output, 'css'), { recursive: true });
  copyIfPresent(join(source, 'activity-builder/index.html'), join(output, 'index.html'));
  copyIfPresent(join(source, 'activity-builder/css/builder.css'), join(output, 'css/builder.css'));
  await bundle('src/activity-builder/js/app.js', join(output, 'js/app.bundle.js'));
  copySimulator(output);
  console.log(`Built authoring builder at ${output}`);
}

async function buildScorm(configPath, scenePath) {
  if (!existsSync(join(simDist, 'index.html'))) {
    throw new Error('Simulator build missing — run `npm run vendor:sim` first');
  }
  const config = readActivityConfig(configPath);
  const scene = readScene(scenePath);
  const output = join(dist, 'scorm-template');
  rmSync(output, { recursive: true, force: true });
  mkdirSync(join(output, 'css'), { recursive: true });
  mkdirSync(join(output, 'js'), { recursive: true });
  mkdirSync(join(output, 'config'), { recursive: true });
  copyIfPresent(join(source, 'scorm-template/index.html'), join(output, 'index.html'));
  copyIfPresent(join(source, 'scorm-template/css/style.css'), join(output, 'css/style.css'));
  copyIfPresent(join(source, 'scorm-template/imsmanifest.xml'), join(output, 'imsmanifest.xml'));
  await bundle('src/scorm-template/js/app.js', join(output, 'js/app.bundle.js'));
  writeFileSync(join(output, 'config/activity_config.json'), `${JSON.stringify(config, null, 2)}\n`);
  writeFileSync(join(output, 'config/scene.swarm'), scene);
  cpSync(simDist, join(output, 'sim'), { recursive: true });
  writeFileSync(join(output, 'imsmanifest.xml'), generateManifest(config));
  console.log(`Built SCORM activity ${config.metadata.activity_id} at ${output}`);
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.target === 'builder' || options.target === 'all') await buildBuilder();
  if (options.target === 'scorm' || options.target === 'all') {
    await buildScorm(options.config, options.scene);
  }
}

main().catch((error) => {
  console.error(`build: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
