import { describe, expect, it } from 'vitest';
import { createBlankProject, type SwarmProject } from './project';
import { parseSceneFlagChange, setSceneFlag, type SceneFlagChange } from './sceneFlags';
import { prepareDeviceRuntimeProgram } from '../runtime/programLoader';
import type {
  DeviceProgramLoadResult,
  PreparedDeviceRuntimeProgram,
} from '../runtime/programLoader';
import type { RuntimeProgram } from '../runtime/runtimeAdapter';

const now = '2026-06-01T02:03:04.000Z';
const later = '2026-06-02T05:06:07.000Z';
const decoder = new TextDecoder();

function lockChange(deviceId: string, value: boolean): SceneFlagChange {
  return { kind: 'device', id: deviceId, flag: 'locked', value };
}

function editableChange(deviceId: string, value: boolean): SceneFlagChange {
  return { kind: 'device', id: deviceId, flag: 'editableProgram', value };
}

function makeProject(): SwarmProject {
  return {
    ...createBlankProject({ id: 'project-1', name: 'Scenario', now }),
    artifacts: [
      {
        id: 'mp-beacon',
        name: 'mp_beacon.hex',
        artifactKind: 'hex',
        runtimeSource: 'micropython',
        program: {
          runtimeSource: 'micropython',
          filesystemBase64: { 'main.py': btoa('print("shipped")\n') },
        },
        createdAt: now,
      },
      {
        id: 'mc-beacon',
        name: 'mc_beacon.hex',
        artifactKind: 'hex',
        runtimeSource: 'makecode-pxt',
        program: {
          runtimeSource: 'makecode-pxt',
          sourceFiles: {
            'main.ts': 'basic.showString("shipped")',
            'pxt.json': '{"name":"mc_beacon"}',
          },
          projectMetadata: { editor: 'tsprj', target: 'microbit' },
        },
        createdAt: now,
      },
    ],
    devices: [
      {
        id: 'device-1',
        name: 'Node 1',
        position: { x: 120, y: 80 },
        programArtifactId: 'mp-beacon',
        editableProgram: {
          runtimeSource: 'micropython',
          baseArtifactId: 'mp-beacon',
          revision: 3,
          updatedAt: now,
          files: { 'main.py': 'print("locked-current-µ")\n' },
        },
      },
      {
        id: 'device-2',
        name: 'Node 2',
        position: { x: 320, y: 180 },
        programArtifactId: 'mc-beacon',
        editableProgram: {
          runtimeSource: 'makecode-pxt',
          baseArtifactId: 'mc-beacon',
          revision: 1,
          updatedAt: now,
          sourceFiles: {
            'main.ts': 'basic.showString("edited")',
            'pxt.json': '{"name":"mc_beacon"}',
          },
          projectMetadata: { editor: 'tsprj', target: 'microbit' },
        },
      },
      {
        id: 'device-3',
        name: 'Node 3',
        position: { x: 520, y: 280 },
        positionPinned: true,
      },
    ],
    environmentSources: [
      {
        id: 'light-1',
        type: 'light',
        name: 'Light 1',
        position: { x: 60, y: 100 },
        radius: 160,
        intensity: 0.8,
      },
    ],
  };
}

function device(project: SwarmProject, deviceId: string) {
  const found = project.devices.find((candidate) => candidate.id === deviceId);
  if (!found) {
    throw new Error(`missing device ${deviceId}`);
  }
  return found;
}

function artifact(project: SwarmProject, artifactId: string) {
  const found = project.artifacts.find((candidate) => candidate.id === artifactId);
  if (!found) {
    throw new Error(`missing artifact ${artifactId}`);
  }
  return found;
}

/** The loader returns a failure record instead of a program when it cannot prepare one. */
function preparedProgram(
  prepared: PreparedDeviceRuntimeProgram | DeviceProgramLoadResult,
): RuntimeProgram {
  if (!('device' in prepared)) {
    throw new Error(prepared.diagnostic ?? 'program was not prepared');
  }
  return prepared.program;
}

describe('parseSceneFlagChange', () => {
  it('accepts the device and node flag shapes', () => {
    expect(parseSceneFlagChange({ kind: 'device', id: 'device-1', flag: 'locked', value: true }))
      .toEqual({ kind: 'device', id: 'device-1', flag: 'locked', value: true });
    expect(parseSceneFlagChange({ kind: 'node', id: 'light-1', flag: 'positionPinned', value: false }))
      .toEqual({ kind: 'node', id: 'light-1', flag: 'positionPinned', value: false });
    expect(parseSceneFlagChange({ kind: 'device', id: 'device-1', flag: 'editableProgram', value: true }))
      .toEqual({ kind: 'device', id: 'device-1', flag: 'editableProgram', value: true });
  });

  it.each([
    ['a null payload', null],
    ['a missing id', { kind: 'device', id: '', flag: 'locked', value: true }],
    ['an unknown kind', { kind: 'source', id: 'device-1', flag: 'locked', value: true }],
    ['an unknown flag', { kind: 'device', id: 'device-1', flag: 'visible', value: true }],
    ['a non-boolean value', { kind: 'device', id: 'device-1', flag: 'locked', value: 'true' }],
    ['an editable environment node', { kind: 'node', id: 'light-1', flag: 'editableProgram', value: true }],
  ])('rejects %s', (_label, payload) => {
    expect(() => parseSceneFlagChange(payload)).toThrow('Invalid scene flag change.');
  });
});

describe('scene flag transforms', () => {
  it('locks a MicroPython device and promotes its exact edited source', async () => {
    const project = makeProject();
    const locked = setSceneFlag(project, lockChange('device-1', true), later);

    const lockedDevice = device(locked, 'device-1');
    expect(lockedDevice.locked).toBe(true);
    expect(lockedDevice).not.toHaveProperty('editableProgram');
    expect(lockedDevice.programArtifactId).not.toBe('mp-beacon');

    const promoted = artifact(locked, lockedDevice.programArtifactId!);
    expect(promoted).toMatchObject({
      name: 'mp_beacon.hex',
      artifactKind: 'hex',
      runtimeSource: 'micropython',
      createdAt: later,
    });
    if (!('program' in promoted) || promoted.program.runtimeSource !== 'micropython') {
      throw new Error('expected a MicroPython program artifact');
    }
    expect(decoder.decode(base64Bytes(promoted.program.filesystemBase64['main.py']!))).toBe(
      'print("locked-current-µ")\n',
    );
    // The original artifact is no longer referenced by any device.
    expect(locked.artifacts.some((candidate) => candidate.id === 'mp-beacon')).toBe(false);

    const prepared = preparedProgram(await prepareDeviceRuntimeProgram(locked, lockedDevice));
    if (prepared.source !== 'micropython') {
      throw new Error('expected a prepared MicroPython program');
    }
    expect(decoder.decode(prepared.filesystem['main.py']!)).toBe('print("locked-current-µ")\n');

    // Unrelated devices and nodes keep their state.
    expect(device(locked, 'device-2')).toEqual(device(project, 'device-2'));
    expect(device(locked, 'device-3')).toEqual(device(project, 'device-3'));
    expect(locked.environmentSources).toEqual(project.environmentSources);
    expect(locked.name).toBe(project.name);
  });

  it('keeps MakeCode secondary files and project metadata when locking', async () => {
    const project = makeProject();
    const locked = setSceneFlag(project, lockChange('device-2', true), later);
    const lockedDevice = device(locked, 'device-2');
    const promoted = artifact(locked, lockedDevice.programArtifactId!);

    expect(promoted).toMatchObject({
      name: 'mc_beacon.hex',
      artifactKind: 'hex',
      runtimeSource: 'makecode-pxt',
    });
    if (!('program' in promoted) || promoted.program.runtimeSource !== 'makecode-pxt') {
      throw new Error('expected a MakeCode program artifact');
    }
    expect(promoted.program.sourceFiles).toEqual({
      'main.ts': 'basic.showString("edited")',
      'pxt.json': '{"name":"mc_beacon"}',
    });
    expect(promoted.program.projectMetadata).toEqual({ editor: 'tsprj', target: 'microbit' });

    const prepared = preparedProgram(await prepareDeviceRuntimeProgram(locked, lockedDevice));
    if (prepared.source !== 'makecode-pxt') {
      throw new Error('expected a prepared MakeCode program');
    }
    expect(prepared.sourceFiles).toEqual({
      'main.ts': 'basic.showString("edited")',
      'pxt.json': '{"name":"mc_beacon"}',
    });
    expect(prepared.projectMetadata).toEqual({ editor: 'tsprj', target: 'microbit' });
  });

  it('copies on write when two devices share the edited artifact', async () => {
    const shared: SwarmProject = {
      ...makeProject(),
      artifacts: [
        {
          id: 'shared',
          name: 'mp_beacon.hex',
          artifactKind: 'hex',
          runtimeSource: 'micropython',
          program: {
            runtimeSource: 'micropython',
            filesystemBase64: { 'main.py': btoa('print("base")\n') },
          },
          createdAt: now,
        },
      ],
      devices: [
        {
          id: 'device-1',
          name: 'Node 1',
          position: { x: 120, y: 80 },
          programArtifactId: 'shared',
          editableProgram: {
            runtimeSource: 'micropython',
            baseArtifactId: 'shared',
            revision: 1,
            updatedAt: now,
            files: { 'main.py': 'print("edited")\n' },
          },
        },
        {
          id: 'device-2',
          name: 'Node 2',
          position: { x: 320, y: 180 },
          programArtifactId: 'shared',
        },
      ],
    };

    const locked = setSceneFlag(shared, lockChange('device-1', true), later);
    const editedDevice = device(locked, 'device-1');
    const peer = device(locked, 'device-2');

    expect(editedDevice.programArtifactId).not.toBe('shared');
    expect(editedDevice.programArtifactId).toMatch(new RegExp(`^device-1-mp-beacon-[0-9]+$`));
    expect(peer.programArtifactId).toBe('shared');
    expect(artifact(locked, 'shared')).toMatchObject({
      program: { runtimeSource: 'micropython', filesystemBase64: { 'main.py': btoa('print("base")\n') } },
    });

    const edited = preparedProgram(await prepareDeviceRuntimeProgram(locked, editedDevice));
    const untouched = preparedProgram(await prepareDeviceRuntimeProgram(locked, peer));
    if (edited.source !== 'micropython' || untouched.source !== 'micropython') {
      throw new Error('expected MicroPython programs on both devices');
    }
    expect(decoder.decode(edited.filesystem['main.py']!)).toBe('print("edited")\n');
    expect(decoder.decode(untouched.filesystem['main.py']!)).toBe('print("base")\n');
  });

  it('reuses the assigned artifact when the device never edited it', () => {
    const project = makeProject();
    const untouched: SwarmProject = {
      ...project,
      devices: project.devices.map((candidate) =>
        candidate.id === 'device-1'
          ? {
              ...candidate,
              editableProgram: {
                runtimeSource: 'micropython',
                baseArtifactId: 'mp-beacon',
                revision: 0,
                updatedAt: now,
                files: { 'main.py': 'print("shipped")\n' },
              },
            }
          : candidate,
      ),
    };

    const locked = setSceneFlag(untouched, lockChange('device-1', true), later);

    expect(device(locked, 'device-1').programArtifactId).toBe('mp-beacon');
    expect(locked.artifacts).toEqual(untouched.artifacts);
    expect(device(locked, 'device-1')).not.toHaveProperty('editableProgram');
  });

  it('unlocks without re-enabling edits, then rebuilds an editable snapshot from the artifact', async () => {
    const project = makeProject();
    const locked = setSceneFlag(project, lockChange('device-1', true), later);
    const unlocked = setSceneFlag(locked, lockChange('device-1', false), later);

    expect(device(unlocked, 'device-1')).not.toHaveProperty('locked');
    expect(device(unlocked, 'device-1')).not.toHaveProperty('editableProgram');
    expect(device(unlocked, 'device-1').programArtifactId).toBe(
      device(locked, 'device-1').programArtifactId,
    );

    const enabled = setSceneFlag(unlocked, editableChange('device-1', true), later);
    const enabledDevice = device(enabled, 'device-1');
    expect(enabledDevice.editableProgram).toMatchObject({
      runtimeSource: 'micropython',
      baseArtifactId: enabledDevice.programArtifactId,
      revision: 0,
      updatedAt: later,
    });
    if (enabledDevice.editableProgram?.runtimeSource !== 'micropython') {
      throw new Error('expected a MicroPython editable snapshot');
    }
    expect(enabledDevice.editableProgram.files['main.py']).toBe('print("locked-current-µ")\n');

    const prepared = preparedProgram(await prepareDeviceRuntimeProgram(enabled, enabledDevice));
    if (prepared.source !== 'micropython') {
      throw new Error('expected the editable source to run');
    }
    expect(decoder.decode(prepared.filesystem['main.py']!)).toBe('print("locked-current-µ")\n');
  });

  it('unlocks and enables edits atomically from the locked device’s stored source', async () => {
    const project = makeProject();
    const pinned = setSceneFlag(
      project,
      { kind: 'device', id: 'device-1', flag: 'positionPinned', value: true },
      later,
    );
    const locked = setSceneFlag(pinned, lockChange('device-1', true), later);
    const lockedDevice = device(locked, 'device-1');
    expect(lockedDevice.locked).toBe(true);
    expect(lockedDevice.positionPinned).toBe(true);
    const promotedId = lockedDevice.programArtifactId!;
    expect(promotedId).not.toBe('mp-beacon');

    const enabled = setSceneFlag(locked, editableChange('device-1', true), later);
    const enabledDevice = device(enabled, 'device-1');

    expect(enabledDevice).not.toHaveProperty('locked');
    expect(enabledDevice.positionPinned).toBe(true);
    expect(enabledDevice.programArtifactId).toBe(promotedId);
    expect(enabled.artifacts).toEqual(locked.artifacts);
    expect(enabledDevice.editableProgram).toMatchObject({
      runtimeSource: 'micropython',
      baseArtifactId: promotedId,
      revision: 0,
      updatedAt: later,
    });
    if (enabledDevice.editableProgram?.runtimeSource !== 'micropython') {
      throw new Error('expected a MicroPython editable snapshot');
    }
    expect(enabledDevice.editableProgram.files['main.py']).toBe('print("locked-current-µ")\n');

    const prepared = preparedProgram(await prepareDeviceRuntimeProgram(enabled, enabledDevice));
    if (prepared.source !== 'micropython') {
      throw new Error('expected the restored source to run');
    }
    expect(decoder.decode(prepared.filesystem['main.py']!)).toBe('print("locked-current-µ")\n');
  });

  it('turns editable code off and on again without losing the source', () => {
    const project = makeProject();
    const off = setSceneFlag(project, editableChange('device-1', false), later);

    expect(device(off, 'device-1').locked).toBeUndefined();
    expect(device(off, 'device-1')).not.toHaveProperty('editableProgram');
    expect(device(off, 'device-1').programArtifactId).not.toBe('mp-beacon');

    const on = setSceneFlag(off, editableChange('device-1', true), later);
    const editableDevice = device(on, 'device-1');
    if (editableDevice.editableProgram?.runtimeSource !== 'micropython') {
      throw new Error('expected a MicroPython editable snapshot');
    }
    expect(editableDevice.editableProgram.files['main.py']).toBe('print("locked-current-µ")\n');
    expect(editableDevice.editableProgram.revision).toBe(0);
  });

  it('keeps an authored source artifact name and kind when locking', () => {
    const project: SwarmProject = {
      ...createBlankProject({ id: 'project-2', name: 'Authored', now }),
      artifacts: [
        {
          id: 'custom',
          name: 'custom.py',
          artifactKind: 'source',
          runtimeSource: 'micropython',
          program: {
            runtimeSource: 'micropython',
            filesystemBase64: { 'main.py': btoa('') },
          },
          createdAt: now,
        },
      ],
      devices: [
        {
          id: 'device-1',
          name: 'Node 1',
          position: { x: 40, y: 40 },
          programArtifactId: 'custom',
          editableProgram: {
            runtimeSource: 'micropython',
            baseArtifactId: 'custom',
            revision: 2,
            updatedAt: now,
            files: { 'main.py': 'print("py-custom-saved")\n' },
          },
        },
      ],
    };

    const locked = setSceneFlag(project, lockChange('device-1', true), later);
    const lockedDevice = device(locked, 'device-1');
    const promoted = artifact(locked, lockedDevice.programArtifactId!);

    expect(promoted).toMatchObject({ name: 'custom.py', artifactKind: 'source' });
    expect(locked.artifacts).toHaveLength(1);
    expect(locked.artifacts[0]).toBe(promoted);
  });

  it('sets and clears locks and pins, omitting false flags', () => {
    const project = makeProject();
    const pinned = setSceneFlag(
      project,
      { kind: 'device', id: 'device-1', flag: 'positionPinned', value: true },
      later,
    );
    expect(device(pinned, 'device-1').positionPinned).toBe(true);
    expect(device(pinned, 'device-1')).toHaveProperty('editableProgram');

    const unpinned = setSceneFlag(
      pinned,
      { kind: 'device', id: 'device-1', flag: 'positionPinned', value: false },
      later,
    );
    expect(device(unpinned, 'device-1')).not.toHaveProperty('positionPinned');

    const lockedNode = setSceneFlag(
      project,
      { kind: 'node', id: 'light-1', flag: 'locked', value: true },
      later,
    );
    expect(lockedNode.environmentSources[0]).toMatchObject({ id: 'light-1', locked: true });
    expect(lockedNode.devices).toEqual(project.devices);

    const pinnedNode = setSceneFlag(
      lockedNode,
      { kind: 'node', id: 'light-1', flag: 'positionPinned', value: true },
      later,
    );
    expect(pinnedNode.environmentSources[0]).toMatchObject({
      id: 'light-1',
      locked: true,
      positionPinned: true,
    });

    const cleared = setSceneFlag(
      pinnedNode,
      { kind: 'node', id: 'light-1', flag: 'locked', value: false },
      later,
    );
    expect(cleared.environmentSources[0]).not.toHaveProperty('locked');
    expect(cleared.environmentSources[0]).toMatchObject({ positionPinned: true });
  });

  it('returns the same project for idempotent requests', () => {
    const project = makeProject();
    expect(setSceneFlag(project, lockChange('device-1', false), later)).toBe(project);
    expect(setSceneFlag(project, editableChange('device-1', true), later)).toBe(project);
    expect(setSceneFlag(
      project,
      { kind: 'device', id: 'device-3', flag: 'positionPinned', value: true },
      later,
    )).toBe(project);
    expect(setSceneFlag(
      project,
      { kind: 'node', id: 'light-1', flag: 'locked', value: false },
      later,
    )).toBe(project);
  });

  it('rejects unknown objects and impossible edits with deterministic messages', () => {
    const project = makeProject();
    expect(() => setSceneFlag(project, lockChange('ghost', true), later)).toThrow(
      'Unknown scene device: ghost',
    );
    expect(() => setSceneFlag(
      project,
      { kind: 'node', id: 'ghost', flag: 'locked', value: true },
      later,
    )).toThrow('Unknown scene node: ghost');

    expect(() => setSceneFlag(project, editableChange('device-3', true), later)).toThrow(
      'This device has no editable source.',
    );
    // Authored code cannot be reconstructed from unextractable legacy bytes.
    const bytesOnly: SwarmProject = {
      ...project,
      artifacts: [
        {
          id: 'legacy',
          name: 'legacy.hex',
          artifactKind: 'hex',
          runtimeSource: 'unknown',
          bytes: new Uint8Array([1, 2, 3]),
          createdAt: now,
        },
      ],
      devices: [
        {
          id: 'device-1',
          name: 'Node 1',
          position: { x: 10, y: 10 },
          locked: true,
          programArtifactId: 'legacy',
        },
      ],
    };
    expect(() => setSceneFlag(bytesOnly, editableChange('device-1', true), later)).toThrow(
      'This device has no editable source.',
    );
    expect(device(bytesOnly, 'device-1').locked).toBe(true);

    const missingArtifact: SwarmProject = {
      ...project,
      devices: [
        {
          ...device(project, 'device-1'),
          programArtifactId: 'ghost',
          editableProgram: {
            runtimeSource: 'micropython',
            baseArtifactId: 'ghost',
            revision: 1,
            updatedAt: now,
            files: { 'main.py': 'print("kept")' },
          },
        },
      ],
    };
    expect(() => setSceneFlag(missingArtifact, lockChange('device-1', true), later)).toThrow(
      "This device's program artifact is missing.",
    );
    expect(() => setSceneFlag(missingArtifact, editableChange('device-1', false), later)).toThrow(
      "This device's program artifact is missing.",
    );
  });
});

function base64Bytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
