const REQUEST_RESPONSES = {
  'load-bundle': 'bundle',
  'get-bundle': 'bundle',
  'get-display': 'display',
  'get-node-positions': 'node-positions',
  'press-button': 'ack',
  'radio-broadcast': 'ack',
  'set-node-level': 'ack',
  'add-node': 'ack',
  'move-node': 'ack',
};

const COMMAND_TYPES = {
  'set-capabilities': true,
  reset: true,
  'set-ui-visibility': true,
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
    if (typeof message.id !== 'string') return;

    const request = pending.get(message.id);
    if (!request) return;
    if (message.type === 'error') {
      settle(request, () => {
        const detail = isObject(message.payload) ? message.payload.message : message.payload;
        request.reject(new SimBridgeError(typeof detail === 'string' ? detail : 'Simulator bridge request failed'));
      });
      return;
    }
    // A late or mismatched reply must not clear a live request.
    if (message.type !== request.expected) return;
    if (message.type === 'display') {
      settle(request, () => {
        if (isObject(message.payload)) request.resolve(message.payload);
        else request.reject(new SimBridgeError('Simulator returned an invalid display response'));
      });
      return;
    }
    if (message.type === 'node-positions') {
      settle(request, () => {
        if (isObject(message.payload) && Array.isArray(message.payload.positions)) {
          request.resolve(message.payload);
        } else {
          request.reject(new SimBridgeError('Simulator returned an invalid node position response'));
        }
      });
      return;
    }
    if (message.type === 'ack') {
      settle(request, () => request.resolve(true));
      return;
    }
    settle(request, () => {
      if (typeof message.payload === 'string') request.resolve(message.payload);
      else request.reject(new SimBridgeError('Simulator returned an invalid bundle response'));
    });
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

  async function request(type, payload, { timeoutMs, signal } = {}) {
    if (!Object.prototype.hasOwnProperty.call(REQUEST_RESPONSES, type)) {
      throw new TypeError(`Simulator bridge command does not have a response: ${type}`);
    }
    if (signal?.aborted) throw abortError(type, signal);
    if (closed) throw new SimBridgeError('Simulator bridge is closed');
    nextRequestId += 1;
    const id = `swarm-${nextRequestId}`;
    const expected = REQUEST_RESPONSES[type];
    return new Promise((resolve, reject) => {
      const entry = { expected, resolve, reject, cleanup };
      let timer;
      let onAbort;

      function cleanup() {
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        if (onAbort && signal) {
          signal.removeEventListener('abort', onAbort);
          onAbort = undefined;
        }
        if (pending.get(id) === entry) pending.delete(id);
      }

      pending.set(id, entry);
      if (Number.isFinite(timeoutMs)) {
        timer = setTimeout(() => {
          settle(entry, () => reject(new SimBridgeError(
            `Simulator did not answer ${type} within ${Math.max(0, timeoutMs)} ms`,
          )));
        }, Math.max(0, timeoutMs));
      }
      if (signal) {
        onAbort = () => {
          settle(entry, () => reject(abortError(type, signal)));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      // Post only once the bridge is ready; the timeout still bounds the wait.
      ready.then(() => {
        if (pending.get(id) !== entry) return;
        if (closed || !isReady) {
          settle(entry, () => reject(new SimBridgeError('Simulator bridge is closed')));
          return;
        }
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
          settle(entry, () => reject(error));
        }
      });
    });
  }

  return {
    ready,
    loadBundle(base64, options) {
      return request('load-bundle', base64, options).then(() => undefined);
    },
    getBundle(options) {
      return request('get-bundle', undefined, options);
    },
    setCapabilities(capabilities) {
      return sendCommand('set-capabilities', capabilities);
    },
    setUiVisibility(visibility) {
      return sendCommand('set-ui-visibility', visibility);
    },
    pressButton(payload, options) {
      return request('press-button', payload, options);
    },
    radioBroadcast(payload, options) {
      return request('radio-broadcast', payload, options);
    },
    setNodeLevel(payload, options) {
      return request('set-node-level', payload, options);
    },
    addNode(payload, options) {
      return request('add-node', payload, options);
    },
    moveNode(payload, options) {
      return request('move-node', payload, options);
    },
    getDisplay(options) {
      return request('get-display', undefined, options).then((payload) => payload.displays);
    },
    getNodePositions(nodes, options) {
      return request('get-node-positions', { nodes }, options)
        .then((payload) => payload.positions);
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
      for (const request of [...pending.values()]) {
        request.cleanup();
        request.reject(new SimBridgeError('Simulator bridge closed before responding'));
      }
      pending.clear();
      eventListeners.clear();
    },
  };
}

function abortError(type, signal) {
  const reason = signal?.reason;
  if (reason instanceof Error) return reason;
  return new SimBridgeError(`Simulator request aborted: ${type}`);
}

/** Resolve/reject exactly once, then drop the timer, abort listener, and pending entry. */
function settle(request, applyOutcome) {
  request.cleanup();
  applyOutcome();
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
