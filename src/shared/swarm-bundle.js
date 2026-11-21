import { gunzipSync, gzipSync } from 'fflate';

const MAGIC = [0x53, 0x57, 0x41, 0x52, 0x4d];
const VERSION = 2;
const HEADER_LENGTH = 7;
const COMPRESSION_NONE = 0;
const COMPRESSION_GZIP = 1;
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });

export class SwarmBundleError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'SwarmBundleError';
  }
}

export function decodeSwarmBundle(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.length < HEADER_LENGTH || !hasMagic(bytes)) {
    throw new SwarmBundleError('Invalid SWARM magic bytes or truncated header');
  }

  const version = bytes[5];
  if (version !== VERSION) {
    throw new SwarmBundleError(`Unsupported SWARM bundle version: ${version}`);
  }

  const compression = bytes[6];
  if (compression !== COMPRESSION_NONE && compression !== COMPRESSION_GZIP) {
    throw new SwarmBundleError(`Unsupported SWARM compression byte: ${compression}`);
  }

  let payload = bytes.subarray(HEADER_LENGTH);
  if (compression === COMPRESSION_GZIP) {
    try {
      payload = gunzipSync(payload);
    } catch (error) {
      throw new SwarmBundleError('Invalid gzip payload in SWARM bundle', { cause: error });
    }
  }

  let project;
  try {
    project = JSON.parse(decoder.decode(payload));
  } catch (error) {
    throw new SwarmBundleError('Invalid JSON payload in SWARM bundle', { cause: error });
  }
  if (project === null || typeof project !== 'object' || Array.isArray(project)) {
    throw new SwarmBundleError('Invalid JSON payload in SWARM bundle: project must be an object');
  }
  return project;
}

export function encodeSwarmBundle(projectJson, { compress = true } = {}) {
  let serialized;
  try {
    serialized = JSON.stringify(projectJson);
  } catch (error) {
    throw new SwarmBundleError('Unable to serialize project JSON for SWARM bundle', { cause: error });
  }
  if (serialized === undefined) {
    throw new SwarmBundleError('Unable to serialize project JSON for SWARM bundle');
  }

  const payload = encoder.encode(serialized);
  const compression = compress ? COMPRESSION_GZIP : COMPRESSION_NONE;
  const encodedPayload = compress ? gzipSync(payload) : payload;
  const bundle = new Uint8Array(HEADER_LENGTH + encodedPayload.length);
  for (let index = 0; index < MAGIC.length; index += 1) bundle[index] = MAGIC[index];
  bundle[5] = VERSION;
  bundle[6] = compression;
  bundle.set(encodedPayload, HEADER_LENGTH);
  return bundle;
}

function hasMagic(bytes) {
  for (let index = 0; index < MAGIC.length; index += 1) {
    if (bytes[index] !== MAGIC[index]) return false;
  }
  return true;
}

export function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

export function base64ToBytes(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
