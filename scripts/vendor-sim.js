import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceOverride = process.env.SWARM_SIM_SRC;
const simulatorRepo = 'https://github.com/zarify/swarm_sim.git';
const simulatorTag = 'v0.16.1';
const simulatorRevision = 'a81cc97e167545a4f6aa9d75288ffd9104cf2eb6';
const vendorRoot = join(packageRoot, 'vendor/swarm-sim');
const patchPath = 'sim-patch/edits.patch';
/**
 * MakeCode runner files duplicated byte-for-byte under `makecode-local/` and
 * the content-addressed `cdn.makecode.com/blob/...` mirror. The package ships
 * the mirror copy only; embed.js and makecode-patched-simulator.html load it.
 */
const deduplicatedSimFiles = new Set([
  'makecode-local/highlight.pack.js',
  'makecode-local/marked.min.js',
  'makecode-local/jquery.js',
  'makecode-local/semantic.js',
  'makecode-local/target.js',
  'makecode-local/pxtembed.js',
  'makecode-local/pxtsim.js',
]);
const remedy =
  'Check access to the simulator GitHub repository or set SWARM_SIM_SRC to a committed swarm_sim checkout.';

function fail(message) {
  console.error(`vendor:sim: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function run(command, args, cwd, label) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: 'inherit' });
  if (result.error) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} failed with exit code ${result.status ?? 'unknown'}`);
}

function archiveCommittedHead(source, destination) {
  return new Promise((resolvePromise, rejectPromise) => {
    const git = spawn('git', ['-C', source, 'archive', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const tar = spawn('tar', ['-x', '-C', destination], {
      stdio: ['pipe', 'ignore', 'pipe'],
    });
    const errors = { git: '', tar: '' };
    let gitStatus;
    let tarStatus;
    let settled = false;

    git.stderr.setEncoding('utf8').on('data', (chunk) => (errors.git += chunk));
    tar.stderr.setEncoding('utf8').on('data', (chunk) => (errors.tar += chunk));
    git.stdout.pipe(tar.stdin);

    const finish = () => {
      if (settled || gitStatus === undefined || tarStatus === undefined) return;
      settled = true;
      if (gitStatus !== 0 || tarStatus !== 0) {
        rejectPromise(
          new Error(
            [errors.git.trim(), errors.tar.trim()].filter(Boolean).join('\n') ||
              `git archive exited ${gitStatus}; tar exited ${tarStatus}`,
          ),
        );
      } else {
        resolvePromise();
      }
    };

    git.on('error', (error) => {
      errors.git += error.message;
      tar.kill();
    });
    tar.on('error', (error) => {
      errors.tar += error.message;
      git.kill();
    });
    git.on('close', (status) => {
      gitStatus = status;
      finish();
    });
    tar.on('close', (status) => {
      tarStatus = status;
      finish();
    });
  });
}

function collectFiles(root, current = root, files = []) {
  for (const entry of readdirSync(current, { withFileTypes: true })) {
    const absolute = join(current, entry.name);
    if (entry.isDirectory()) collectFiles(root, absolute, files);
    else if (entry.isFile()) files.push(relative(root, absolute).split('\\').join('/'));
  }
  return files;
}

async function main() {
  const temporaryRoot = sourceOverride ? null : mkdtempSync(join(tmpdir(), 'scorm-swarm-sim-'));
  try {
    const sourceRoot = sourceOverride
      ? resolve(sourceOverride)
      : join(temporaryRoot, 'swarm_sim');
    if (!sourceOverride) {
      run(
        'git',
        ['clone', '--depth', '1', '--branch', simulatorTag, simulatorRepo, sourceRoot],
        packageRoot,
        'Cloning upstream simulator',
      );
    }

    if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
      fail(`Source directory not found: ${sourceRoot}. ${remedy}`);
    }

    const revisionResult = spawnSync('git', ['-C', sourceRoot, 'rev-parse', '--verify', 'HEAD'], {
      encoding: 'utf8',
    });
    if (revisionResult.status !== 0) {
      fail(`Source has no readable HEAD commit: ${sourceRoot}. ${remedy}`);
    }
    const revision = revisionResult.stdout.trim();
    if (!sourceOverride && revision !== simulatorRevision) {
      fail(`Expected ${simulatorTag} at ${simulatorRevision}, got ${revision}.`);
    }

    rmSync(vendorRoot, { recursive: true, force: true });
    mkdirSync(vendorRoot, { recursive: true });
    await archiveCommittedHead(sourceRoot, vendorRoot);
    writeFileSync(join(vendorRoot, '.source-revision'), `${revision}\n`);

    const patchSource = join(packageRoot, 'sim-patch/src');
    if (existsSync(patchSource)) cpSync(patchSource, join(vendorRoot, 'src'), { recursive: true });

    const patchCheck = spawnSync('git', ['apply', '--check', patchPath], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    if (patchCheck.status !== 0) {
      fail(
        `git apply --check failed; rebase ${patchPath} against ${revision} before building.\n${[
          patchCheck.stdout.trim(),
          patchCheck.stderr.trim(),
        ]
          .filter(Boolean)
          .join('\n')}`,
      );
    }
    run('git', ['apply', patchPath], packageRoot, 'Applying simulator patch');
    run('npm', ['ci'], vendorRoot, 'Installing vendored simulator dependencies');
    run('npm', ['run', 'build'], vendorRoot, 'Building vendored simulator');

    const simDist = join(packageRoot, 'dist/sim');
    rmSync(simDist, { recursive: true, force: true });
    mkdirSync(simDist, { recursive: true });
    const builtSimDist = join(vendorRoot, 'dist');
    cpSync(builtSimDist, simDist, {
      recursive: true,
      filter: (source) => !deduplicatedSimFiles.has(
        relative(builtSimDist, source).split('\\').join('/'),
      ),
    });
    const files = collectFiles(simDist).sort((left, right) => left.localeCompare(right));
    writeFileSync(join(packageRoot, 'dist/sim-files.json'), `${JSON.stringify(files, null, 2)}\n`);
    console.log(`Vendored swarm_sim ${revision}; copied ${files.length} files to dist/sim/`);
  } finally {
    if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  if (process.exitCode !== 1) {
    console.error(`vendor:sim: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
});
