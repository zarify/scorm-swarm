import type {
  ArtifactProgram,
  EnvironmentSource,
  ProgramArtifact,
  SwarmProject,
  VirtualDevice,
} from './project';
import { makeArtifactId, replaceDeviceArtifact } from './projectArtifacts';
import {
  buildRuntimeProgramFromArtifactProgram,
  buildRuntimeProgramFromEditableProgram,
  createArtifactProgramSnapshot,
  createEditableProgramSnapshot,
  getActiveEditableProgram,
} from '../runtime/editableProgram';

/**
 * One authored starting rule change, as delivered by the builder over the
 * bridge. `editableProgram` is device-only: an environment source has no code.
 */
export interface SceneFlagChange {
  kind: 'device' | 'node';
  id: string;
  flag: 'locked' | 'positionPinned' | 'editableProgram';
  value: boolean;
}

/** Wire-shape validation. Malformed payloads never reach the project. */
export function parseSceneFlagChange(payload: unknown): SceneFlagChange {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Invalid scene flag change.');
  }
  const record = payload as Record<string, unknown>;
  const { kind, id, flag, value } = record;
  if (
    (kind !== 'device' && kind !== 'node') ||
    typeof id !== 'string' ||
    id.length === 0 ||
    (flag !== 'locked' && flag !== 'positionPinned' && flag !== 'editableProgram') ||
    typeof value !== 'boolean' ||
    (flag === 'editableProgram' && kind !== 'device')
  ) {
    throw new Error('Invalid scene flag change.');
  }
  return { kind, id, flag, value };
}

/**
 * Apply one starting rule to a project without touching anything else: peers
 * sharing an artifact keep it, runtimes stay loaded, and the caller republishes
 * the whole project as the new snapshot. Returns the same project when the
 * request changes nothing.
 */
export function setSceneFlag(
  project: SwarmProject,
  change: SceneFlagChange,
  now: string,
): SwarmProject {
  if (change.flag === 'editableProgram' && change.kind !== 'device') {
    throw new Error('Invalid scene flag change.');
  }
  if (change.kind === 'node') {
    return setSourceFlag(project, change.id, change.flag, change.value);
  }
  return setDeviceFlag(project, change.id, change.flag, change.value, now);
}

function setSourceFlag(
  project: SwarmProject,
  sourceId: string,
  flag: SceneFlagChange['flag'],
  value: boolean,
): SwarmProject {
  if (flag === 'editableProgram') {
    throw new Error('Invalid scene flag change.');
  }
  const source = project.environmentSources.find((candidate) => candidate.id === sourceId);
  if (!source) {
    throw new Error(`Unknown scene node: ${sourceId}`);
  }
  const nextSource = applyFlag(source, flag, value);
  if (nextSource === source) {
    return project;
  }
  return {
    ...project,
    environmentSources: project.environmentSources.map((candidate) =>
      candidate.id === sourceId ? nextSource : candidate,
    ),
  };
}

function setDeviceFlag(
  project: SwarmProject,
  deviceId: string,
  flag: SceneFlagChange['flag'],
  value: boolean,
  now: string,
): SwarmProject {
  const device = project.devices.find((candidate) => candidate.id === deviceId);
  if (!device) {
    throw new Error(`Unknown scene device: ${deviceId}`);
  }

  if (flag === 'positionPinned') {
    const nextDevice = applyFlag(device, flag, value);
    if (nextDevice === device) {
      return project;
    }
    return replaceDevice(project, nextDevice, project.artifacts);
  }

  if (flag === 'locked') {
    return value ? lockDevice(project, device, now) : unlockDevice(project, device);
  }

  return setDeviceEditableProgram(project, device, value, now);
}

function unlockDevice(project: SwarmProject, device: VirtualDevice): SwarmProject {
  if (device.locked !== true) {
    return project;
  }
  const { locked: _locked, ...rest } = device;
  return replaceDevice(project, rest, project.artifacts);
}

/**
 * Locking drops `editableProgram`. When the device actually has edits, they are
 * first promoted into its assigned executable artifact so the code keeps
 * running after the permission is removed.
 */
function lockDevice(project: SwarmProject, device: VirtualDevice, now: string): SwarmProject {
  const promoted = promoteActiveSnapshot(project, device, now);
  const { editableProgram: _editableProgram, ...rest } = promoted.device;
  return replaceDevice(project, { ...rest, locked: true }, promoted.artifacts);
}

function setDeviceEditableProgram(
  project: SwarmProject,
  device: VirtualDevice,
  value: boolean,
  now: string,
): SwarmProject {
  const activeSnapshot = getActiveEditableProgram(device);

  if (value) {
    if (device.locked) {
      throw new Error('Cannot make code editable on a locked device.');
    }
    if (activeSnapshot) {
      return project;
    }
    const artifact = findAssignedArtifact(project, device);
    if (!artifact || !('program' in artifact)) {
      throw new Error('This device has no editable source.');
    }
    const runtimeProgram = buildRuntimeProgramFromArtifactProgram(artifact);
    return replaceDevice(
      project,
      { ...device, editableProgram: createEditableProgramSnapshot(artifact.id, runtimeProgram, now) },
      project.artifacts,
    );
  }

  if (activeSnapshot) {
    const promoted = promoteActiveSnapshot(project, device, now);
    const { editableProgram: _editableProgram, ...rest } = promoted.device;
    return replaceDevice(project, rest, promoted.artifacts);
  }
  if (device.editableProgram === undefined) {
    return project;
  }
  const { editableProgram: _editableProgram, ...rest } = device;
  return replaceDevice(project, rest, project.artifacts);
}

interface PromotionResult {
  device: VirtualDevice;
  artifacts: ProgramArtifact[];
}

/**
 * Move the device's active editable snapshot into an executable artifact. The
 * assigned artifact is reused when its program content is identical, so a
 * device that never edited anything keeps sharing its peer's artifact.
 */
function promoteActiveSnapshot(
  project: SwarmProject,
  device: VirtualDevice,
  now: string,
): PromotionResult {
  const snapshot = getActiveEditableProgram(device);
  if (!snapshot) {
    return { device, artifacts: project.artifacts };
  }
  const baseArtifact = project.artifacts.find((candidate) => candidate.id === snapshot.baseArtifactId);
  if (!baseArtifact) {
    throw new Error("This device's program artifact is missing.");
  }

  const program = createArtifactProgramSnapshot(
    buildRuntimeProgramFromEditableProgram(snapshot, baseArtifact.name),
  );
  if (hasIdenticalProgram(baseArtifact, program)) {
    return {
      device: { ...device, editableProgram: undefined },
      artifacts: project.artifacts,
    };
  }

  const promotedArtifact: ProgramArtifact = {
    id: allocateArtifactId(project, device.id, baseArtifact.name, now),
    name: baseArtifact.name,
    artifactKind: baseArtifact.artifactKind,
    runtimeSource: program.runtimeSource,
    program,
    createdAt: now,
  };
  return {
    device: { ...device, programArtifactId: promotedArtifact.id, editableProgram: undefined },
    artifacts: replaceDeviceArtifact(project, device.id, promotedArtifact),
  };
}

function hasIdenticalProgram(artifact: ProgramArtifact, program: ArtifactProgram): boolean {
  return (
    'program' in artifact &&
    artifact.runtimeSource === program.runtimeSource &&
    stableSerialize(artifact.program) === stableSerialize(program)
  );
}

function allocateArtifactId(
  project: SwarmProject,
  deviceId: string,
  filename: string,
  now: string,
): string {
  const baseId = makeArtifactId(deviceId, filename, now);
  if (!project.artifacts.some((artifact) => artifact.id === baseId)) {
    return baseId;
  }
  let suffix = 2;
  while (project.artifacts.some((artifact) => artifact.id === `${baseId}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseId}-${suffix}`;
}

function replaceDevice(
  project: SwarmProject,
  device: VirtualDevice,
  artifacts: ProgramArtifact[],
): SwarmProject {
  return {
    ...project,
    devices: project.devices.map((candidate) =>
      candidate.id === device.id ? device : candidate,
    ),
    artifacts,
  };
}

function findAssignedArtifact(
  project: SwarmProject,
  device: VirtualDevice,
): ProgramArtifact | undefined {
  return device.programArtifactId
    ? project.artifacts.find((candidate) => candidate.id === device.programArtifactId)
    : undefined;
}

function applyFlag<T extends VirtualDevice | EnvironmentSource>(
  target: T,
  flag: 'locked' | 'positionPinned',
  value: boolean,
): T {
  const current = target[flag] === true;
  if (current === value) {
    return target;
  }
  return value ? { ...target, [flag]: true } : omitFlag(target, flag);
}

function omitFlag<T extends VirtualDevice | EnvironmentSource>(
  target: T,
  flag: 'locked' | 'positionPinned',
): T {
  const { [flag]: _removed, ...rest } = target;
  return rest as T;
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableSerialize(entry)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}
