import type {
  MicrobitRuntimeAdapter,
  RuntimeAdapterEvent,
  RuntimeProgram,
  RuntimeRadioPacket,
  RuntimeSensorId,
} from './runtime/runtimeAdapter';

export type BridgeEvent =
  | { kind: 'serial'; device_id: string; text: string }
  | { kind: 'button'; device_id: string; button: 'A' | 'B' | 'AB'; pressed: boolean }
  | {
      kind: 'radio-tx';
      device_id: string;
      packet: {
        data_b64: string;
        group: number | null;
        channel: number | null;
        signal_strength: number | null;
      };
    }
  | {
      kind: 'radio-rx';
      device_id: string;
      from_device_id: string;
      packet: {
        data_b64: string;
        group: number | null;
        channel: number | null;
        signal_strength: number | null;
      };
      rssi: number;
    }
  | { kind: 'radio-blocked'; device_id: string; from_device_id: string; reason: string }
  | {
      kind: 'sensor';
      device_id: string;
      sensor: RuntimeSensorId;
      value: number;
    }
  | { kind: 'code-load'; device_id: string };

export interface BridgeCommand {
  type: 'load-bundle' | 'get-bundle' | 'set-capabilities' | 'reset';
  id?: string;
  payload?: unknown;
}
export interface LearnerCapabilities {
  move_devices: boolean;
  move_nodes: boolean;
  use_buttons: boolean;
  load_code: boolean;
  edit_code: boolean;
}


export interface SimLearnerBridge {
  onCommand(handler: (command: BridgeCommand) => void | Promise<void>): () => void;
  sendBundle(id: string | undefined, base64: string): void;
  sendError(id: string | undefined, error: unknown): void;
}

interface BridgeEnvelope {
  source: 'swarm-scorm' | 'swarm-sim-bridge';
  v: 1;
  type: string;
  id?: string;
  payload?: unknown;
}

interface SensorThrottleState {
  value: number;
  emittedAt: number;
}
interface PendingAdapterRadioOutput {
  routedBySimulation: boolean;
}

let installedBridge: SimLearnerBridge | undefined;
let sequence = 0;
const recentButtons = new Map<string, number>();
const sensorState = new Map<string, SensorThrottleState>();
const pendingAdapterRadioOutputs = new Map<string, PendingAdapterRadioOutput[]>();

const allowedCommands: Record<BridgeCommand['type'], true> = {
  'load-bundle': true,
  'get-bundle': true,
  'set-capabilities': true,
  reset: true,
};

export function installLearnerBridge(): SimLearnerBridge {
  if (installedBridge) return installedBridge;

  let commandHandler: ((command: BridgeCommand) => void | Promise<void>) | undefined;
  const queuedCommands: BridgeCommand[] = [];
  let readySent = false;

  const send = (message: BridgeEnvelope) => {
    if (typeof window === 'undefined' || window.parent === window) return;
    window.parent.postMessage(message, window.location.origin);
  };

  const sendReady = () => {
    if (readySent || !commandHandler) return;
    readySent = true;
    send({ source: 'swarm-sim-bridge', v: 1, type: 'ready', payload: {} });
  };

  const dispatch = (command: BridgeCommand) => {
    if (!commandHandler) {
      queuedCommands.push(command);
      return;
    }
    void Promise.resolve(commandHandler(command)).catch((error: unknown) => {
      send({
        source: 'swarm-sim-bridge',
        v: 1,
        type: 'error',
        ...(command.id === undefined ? {} : { id: command.id }),
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
    });
  };

  const handleMessage = (event: MessageEvent<unknown>) => {
    if (
      typeof window === 'undefined' ||
      event.source !== window.parent ||
      event.origin !== window.location.origin
    ) {
      return;
    }
    if (!event.data || typeof event.data !== 'object') return;
    const message = event.data as Partial<BridgeEnvelope>;
    if (message.source !== 'swarm-scorm' || message.v !== 1) return;
    if (
      typeof message.type !== 'string' ||
      !Object.hasOwn(allowedCommands, message.type)
    ) {
      return;
    }
    const type = message.type as BridgeCommand['type'];

    dispatch({
      type,
      ...(typeof message.id === 'string' ? { id: message.id } : {}),
      ...(Object.hasOwn(message, 'payload') ? { payload: message.payload } : {}),
    });
  };

  window.addEventListener('message', handleMessage);
  const bridge: SimLearnerBridge = {
    onCommand(handler) {
      commandHandler = handler;
      sendReady();
      for (const command of queuedCommands.splice(0)) dispatch(command);
      return () => {
        if (commandHandler === handler) commandHandler = undefined;
      };
    },
    sendBundle(id, base64) {
      send({
        source: 'swarm-sim-bridge',
        v: 1,
        type: 'bundle',
        ...(id === undefined ? {} : { id }),
        payload: base64,
      });
    },
    sendError(id, error) {
      send({
        source: 'swarm-sim-bridge',
        v: 1,
        type: 'error',
        ...(id === undefined ? {} : { id }),
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
    },
  };

  installedBridge = bridge;
  window.swarmSimBridge = bridge;
  return bridge;
}

export function isBridgeEmbedded(): boolean {
  return typeof window !== 'undefined' && window.parent !== window;
}

export function emitBridgeEvent(event: BridgeEvent): void {
  if (!isBridgeEmbedded()) return;

  if (event.kind === 'radio-tx') {
    const key = `${event.device_id}\u0000${event.packet.data_b64}`;
    const pending = pendingAdapterRadioOutputs.get(key)?.find((candidate) => !candidate.routedBySimulation);
    if (pending) pending.routedBySimulation = true;
  }

  const now = Date.now();
  if (event.kind === 'button') {
    const key = `${event.device_id}\u0000${event.button}\u0000${event.pressed}`;
    const previous = recentButtons.get(key);
    if (previous !== undefined && now - previous < 150) return;
    recentButtons.set(key, now);
  }
  if (event.kind === 'sensor') {
    const key = `${event.device_id}\u0000${event.sensor}`;
    const previous = sensorState.get(key);
    if (previous?.value === event.value || (previous && now - previous.emittedAt < 250)) return;
    sensorState.set(key, { value: event.value, emittedAt: now });
  }

  sequence += 1;
  window.parent.postMessage(
    {
      source: 'swarm-sim-bridge',
      v: 1,
      type: 'event',
      payload: { seq: sequence, ts: now, event },
    },
    window.location.origin,
  );
}

export function wrapAdapterForBridge(
  deviceId: string,
  adapter: MicrobitRuntimeAdapter,
): MicrobitRuntimeAdapter {
  const pulseButtonAB = adapter.pulseButtonAB
    ? async () => {
        await adapter.pulseButtonAB?.();
        emitBridgeEvent({ kind: 'button', device_id: deviceId, button: 'AB', pressed: true });
        emitBridgeEvent({ kind: 'button', device_id: deviceId, button: 'AB', pressed: false });
      }
    : undefined;
  const disposeMethod = (
    adapter as MicrobitRuntimeAdapter & { dispose?: () => void }
  ).dispose;
  const dispose =
    typeof disposeMethod === 'function' ? () => disposeMethod.call(adapter) : undefined;

  const wrapped: MicrobitRuntimeAdapter = {
    name: adapter.name,
    source: adapter.source,
    evaluateArtifact: (filename, bytes) => adapter.evaluateArtifact(filename, bytes),
    flash: async (program: RuntimeProgram) => {
      await adapter.flash(program);
      emitBridgeEvent({ kind: 'code-load', device_id: deviceId });
    },
    reset: () => adapter.reset(),
    stop: () => adapter.stop(),
    setButton: async (button, pressed) => {
      await adapter.setButton(button, pressed);
      emitBridgeEvent({ kind: 'button', device_id: deviceId, button, pressed });
    },
    ...(pulseButtonAB ? { pulseButtonAB } : {}),
    ...(dispose ? { dispose } : {}),
    setSensor: async (sensor, value) => {
      await adapter.setSensor(sensor, value);
      emitBridgeEvent({ kind: 'sensor', device_id: deviceId, sensor, value });
    },
    sendRadio: (packet) => adapter.sendRadio(packet),
    onEvent: (listener) =>
      adapter.onEvent((event) => {
        forwardAdapterEvent(deviceId, event);
        listener(event);
      }),
  };
  return wrapped;
}

function forwardAdapterEvent(deviceId: string, event: RuntimeAdapterEvent): void {
  if (event.type === 'serial-output') {
    emitBridgeEvent({ kind: 'serial', device_id: deviceId, text: event.data });
  } else if (event.type === 'radio-output') {
    deferAdapterRadioOutput(deviceId, event.packet);
  }
}

function deferAdapterRadioOutput(deviceId: string, packet: RuntimeRadioPacket): void {
  if (!isBridgeEmbedded()) return;
  const bridgePacket = radioPacketForBridge(packet);
  const key = `${deviceId}\u0000${bridgePacket.data_b64}`;
  const pending: PendingAdapterRadioOutput = { routedBySimulation: false };
  const queue = pendingAdapterRadioOutputs.get(key) ?? [];
  queue.push(pending);
  pendingAdapterRadioOutputs.set(key, queue);
  queueMicrotask(() => {
    const currentQueue = pendingAdapterRadioOutputs.get(key);
    const index = currentQueue?.indexOf(pending) ?? -1;
    if (currentQueue && index !== -1) {
      currentQueue.splice(index, 1);
      if (currentQueue.length === 0) pendingAdapterRadioOutputs.delete(key);
    }
    if (!pending.routedBySimulation) {
      emitBridgeEvent({ kind: 'radio-tx', device_id: deviceId, packet: bridgePacket });
    }
  });
}


export function radioPacketForBridge(packet: RuntimeRadioPacket) {
  return {
    data_b64: bytesToBase64(packet.data),
    group: packet.group ?? null,
    channel: packet.channel ?? null,
    signal_strength: packet.signalStrength ?? null,
  };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

declare global {
  interface Window {
    swarmSimBridge?: SimLearnerBridge;
  }
}
