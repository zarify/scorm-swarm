const REQUEST_TYPES = { 'load-bundle': true, 'get-bundle': true, 'get-display': true };
const COMMAND_TYPES = {
  'load-bundle': true,
  'get-bundle': true,
  'set-capabilities': true,
  reset: true,
  'set-ui-visibility': true,
  'press-button': true,
  'radio-broadcast': true,
  'set-node-level': true,
  'add-node': true,
  'get-display': true,
};

export class SimBridgeError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SimBridgeError';
  }
}

export function connectSimBridge(iframeWindow, targetOrigin) {
  if (!iframeWindow || typeof iframeWindow.postMessage !== 'function') {
    throw new TypeError('connectSimBridge requires an iframe window');
  }
  if (typeof targetOrigin !== 'string' || targetOrigin.length === 0) {
    throw new TypeError('connectSimBridge requires a target origin');
  }

  let closed = false;
  let readyResolve;
  let isReady = false;
  let nextRequestId = 0;
  const pending = new Map();
  const eventListeners = new Set();
  const ready = new Promise((resolve) => {
    readyResolve = resolve;
  });

  const onMessage = (messageEvent) => {
    if (closed || messageEvent.source !== iframeWindow) return;
    if (targetOrigin !== '*' && messageEvent.origin !== targetOrigin) return;
    const message = messageEvent.data;
    if (!message || typeof message !== 'object' ||
        message.source !== 'swarm-sim-bridge' || message.v !== 1) return;

    if (message.type === 'ready') {
      isReady = true;
      readyResolve(true);
      return;
    }
    if (message.type === 'event') {
      if (!isObject(message.payload) || !isObject(message.payload.event)) return;
      for (const listener of eventListeners) listener(message.payload);
      return;
    }
    if (message.type !== 'bundle' && message.type !== 'display' && message.type !== 'error') return;
    if (typeof message.id !== 'string') return;

    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.type === 'error') {
      const detail = isObject(message.payload) ? message.payload.message : message.payload;
      request.reject(new SimBridgeError(typeof detail === 'string' ? detail : 'Simulator bridge request failed'));
    } else if (message.type === 'display') {
      if (isObject(message.payload)) {
        request.resolve(message.payload);
      } else {
        request.reject(new SimBridgeError('Simulator returned an invalid display response'));
      }
    } else if (typeof message.payload === 'string') {
      request.resolve(message.payload);
    } else {
      request.reject(new SimBridgeError('Simulator returned an invalid bundle response'));
    }
  };

  window.addEventListener('message', onMessage);

  async function sendCommand(type, payload) {
    if (!Object.prototype.hasOwnProperty.call(COMMAND_TYPES, type)) {
      throw new TypeError(`Unsupported simulator bridge command: ${type}`);
    }
    await ready;
    if (closed || !isReady) throw new SimBridgeError('Simulator bridge is closed');
    iframeWindow.postMessage(
      {
        source: 'swarm-scorm',
        v: 1,
        type,
        ...(payload === undefined ? {} : { payload }),
      },
      targetOrigin,
    );
  }

  async function request(type, payload) {
    if (!Object.prototype.hasOwnProperty.call(REQUEST_TYPES, type)) {
      throw new TypeError(`Simulator bridge command does not have a response: ${type}`);
    }
    await ready;
    if (closed || !isReady) throw new SimBridgeError('Simulator bridge is closed');
    nextRequestId += 1;
    const id = `swarm-${nextRequestId}`;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      try {
        iframeWindow.postMessage(
          {
            source: 'swarm-scorm',
            v: 1,
            type,
            id,
            ...(payload === undefined ? {} : { payload }),
          },
          targetOrigin,
        );
      } catch (error) {
        pending.delete(id);
        reject(error);
      }
    });
  }

  return {
    ready,
    loadBundle(base64) {
      return request('load-bundle', base64).then(() => undefined);
    },
    getBundle() {
      return request('get-bundle');
    },
    setCapabilities(capabilities) {
      return sendCommand('set-capabilities', capabilities);
    },
    setUiVisibility(visibility) {
      return sendCommand('set-ui-visibility', visibility);
    },
    pressButton(payload) {
      return sendCommand('press-button', payload);
    },
    radioBroadcast(payload) {
      return sendCommand('radio-broadcast', payload);
    },
    setNodeLevel(payload) {
      return sendCommand('set-node-level', payload);
    },
    addNode(payload) {
      return sendCommand('add-node', payload);
    },
    getDisplay() {
      return request('get-display').then((payload) => payload.displays);
    },
    reset() {
      return sendCommand('reset');
    },
    request,
    onEvent(callback) {
      if (typeof callback !== 'function') throw new TypeError('onEvent requires a callback');
      eventListeners.add(callback);
      return () => eventListeners.delete(callback);
    },
    close() {
      if (closed) return;
      closed = true;
      window.removeEventListener('message', onMessage);
      readyResolve(false);
      for (const request of pending.values()) {
        request.reject(new SimBridgeError('Simulator bridge closed before responding'));
      }
      pending.clear();
      eventListeners.clear();
    },
  };
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
