import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bytesToBase64, encodeSwarmBundle } from '../src/shared/swarm-bundle.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const now = '2026-10-13T00:00:00.000Z';
const aliceProgram = [
  'from microbit import *',
  'import radio',
  '',
  'radio.on()',
  'radio.config(group=42)',
  'print("hello 42")',
  '',
  'while True:',
  '    radio.send("ping")',
  '    sleep(2000)',
].join('\n');
const bobProgram = [
  'from microbit import sleep',
  'import radio',
  '',
  'radio.on()',
  'radio.config(group=42)',
  '',
  'while True:',
  '    sleep(1000)',
].join('\n');

function readOutputPath(args) {
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument.startsWith('--out=')) return argument.slice('--out='.length);
    if (argument === '--out' && args[index + 1]) return args[index + 1];
  }
  throw new Error('Usage: node scripts/make-demo-scene.js --out <path>');
}

function makeArtifact(id, filename, source) {
  const sourceBase64 = bytesToBase64(new TextEncoder().encode(source));
  return {
    id,
    name: filename,
    artifactKind: 'hex',
    runtimeSource: 'micropython',
    createdAt: now,
    program: {
      runtimeSource: 'micropython',
      filesystemBase64: { 'main.py': sourceBase64 },
    },
  };
}

function makeDevice(id, name, x, artifactId, source) {
  return {
    id,
    name,
    position: { x, y: 260 },
    programArtifactId: artifactId,
    editableProgram: {
      runtimeSource: 'micropython',
      baseArtifactId: artifactId,
      revision: 0,
      updatedAt: now,
      files: { 'main.py': source },
    },
  };
}

function main() {
  const outputPath = resolve(root, readOutputPath(process.argv.slice(2)));
  const project = {
    schemaVersion: 9,
    id: 'radio-relay-demo',
    name: 'Radio Relay Field Lab',
    createdAt: now,
    updatedAt: now,
    viewOptions: { showRadioRange: true },
    instructionsMarkdown: 'Observe how Alice sends a packet and Bob receives it.',
    devices: [
      makeDevice('bob', 'Bob', 500, 'artifact-bob', bobProgram),
      makeDevice('alice', 'Alice', 350, 'artifact-alice', aliceProgram),
    ],
    artifacts: [
      makeArtifact('artifact-bob', 'bob-main.py', bobProgram),
      makeArtifact('artifact-alice', 'alice-main.py', aliceProgram),
    ],
    environmentSources: [],
  };
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, encodeSwarmBundle(project));
  console.log(`Wrote ${outputPath}`);
}

try {
  main();
} catch (error) {
  console.error(`make-demo-scene: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
