import {
  base64ToBytes,
  bytesToBase64,
  decodeSwarmBundle,
  encodeSwarmBundle,
} from './swarm-bundle.js';

const DEFAULT_LOAD_TIMEOUT_MS = 10_000;
const DEFAULT_RESTART_TIMEOUT_MS = 15_000;

/**
 * The authored scene is the geometry a graded test was written against:
 * everything a learner can drag, and everything a test action can add, move or
 * re-level, goes back to the values the activity shipped with. Only code
 * assignments come from the live simulator, so a learner's program is what runs.
 */
export function restoreAuthoredScene(authored, current) {
  const liveDevices = new Map(current.devices.map((device) => [device.id, device]));
  const devices = authored.devices.map((device) => {
    const live = liveDevices.get(device.id);
    if (!live) {
      return device;
    }
    return {
      ...device,
      ...(live.programArtifactId === undefined ? {} : { programArtifactId: live.programArtifactId }),
      ...(live.editableProgram === undefined ? {} : { editableProgram: live.editableProgram }),
    };
  });
  const referencedArtifactIds = new Set(
    devices
      .map((device) => device.programArtifactId)
      .filter((artifactId) => typeof artifactId === 'string'),
  );
  const artifacts = [];
  for (const artifact of [...current.artifacts, ...authored.artifacts]) {
    if (!referencedArtifactIds.has(artifact.id)) continue;
    if (artifacts.some((candidate) => candidate.id === artifact.id)) continue;
    artifacts.push(artifact);
  }
  return {
    ...current,
    devices,
    artifacts,
    environmentSources: authored.environmentSources,
  };
}

/**
 * Per-test isolation for a graded run: before every test case the simulator
 * reloads the baseline scene (authored geometry, the learner's code) and the
 * run waits until every programmed device has restarted its program.
 */
export function createSceneIsolation({
  bridge,
  authoredBundleBase64 = null,
  loadTimeoutMs = DEFAULT_LOAD_TIMEOUT_MS,
  restartTimeoutMs = DEFAULT_RESTART_TIMEOUT_MS,
  onWarning = (message) => console.warn(message),
} = {}) {
  if (!bridge || typeof bridge !== 'object') {
    throw new TypeError('createSceneIsolation requires a bridge');
  }

  let baseline = null;
  let programmedDeviceIds = [];

  function decodeAuthored() {
    if (typeof authoredBundleBase64 !== 'string' || authoredBundleBase64.length === 0) {
      return null;
    }
    try {
      return decodeSwarmBundle(base64ToBytes(authoredBundleBase64));
    } catch (error) {
      onWarning(
        `Authored scene could not be read, so positions stay at their current values: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return null;
    }
  }

  /**
   * Capture the scene every test case starts from: authored geometry plus the
   * code the learner has right now. Called once per Check, before the run.
   */
  async function prepare() {
    const bundle = await bridge.getBundle({ timeoutMs: loadTimeoutMs });
    if (typeof bundle !== 'string' || bundle.length === 0) {
      throw new Error('The simulator did not return its scene before the run.');
    }
    const current = decodeSwarmBundle(base64ToBytes(bundle));
    const authored = decodeAuthored();
    const baselineProject = authored ? restoreAuthoredScene(authored, current) : current;
    baseline = bytesToBase64(encodeSwarmBundle(baselineProject));
    programmedDeviceIds = baselineProject.devices
      .filter((device) => typeof device.programArtifactId === 'string')
      .map((device) => device.id);
    return { authored: Boolean(authored), deviceCount: programmedDeviceIds.length };
  }

  async function isolate({ signal } = {}) {
    if (signal?.aborted) throw abortReason(signal);
    if (baseline === null) await prepare();

    const remaining = new Set(programmedDeviceIds);
    let settle;
    let settled = false;
    const finished = new Promise((resolve) => {
      settle = resolve;
    });
    const completeIfReady = () => {
      if (settled || remaining.size > 0) return;
      settled = true;
      settle();
    };
    const unsubscribe = bridge.onEvent((payload) => {
      const event = payload && typeof payload === 'object' ? payload.event : undefined;
      if (!event || typeof event.device_id !== 'string') return;
      if (event.kind !== 'code-restart' && event.kind !== 'code-load') return;
      if (!remaining.delete(event.device_id)) return;
      completeIfReady();
    });
    const timer = setTimeout(() => {
      settled = true;
      settle();
    }, restartTimeoutMs);
    const onAbort = () => {
      settled = true;
      settle();
    };
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      await bridge.loadBundle(baseline, {
        timeoutMs: loadTimeoutMs,
        ...(signal ? { signal } : {}),
      });
      completeIfReady();
      await finished;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      unsubscribe?.();
    }

    if (signal?.aborted) throw abortReason(signal);
    if (remaining.size > 0) {
      throw new Error(
        `The simulator did not restart ${[...remaining].join(', ')} within ${restartTimeoutMs} ms.`,
      );
    }
  }

  return { prepare, isolate };
}

function abortReason(signal) {
  const reason = signal?.reason;
  return reason instanceof Error ? reason : new Error('Scene isolation cancelled.');
}
