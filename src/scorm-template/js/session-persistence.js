/**
 * Session Persistence — layered storage for the student's scene bundle.
 *
 * Layer 1: SCORM 1.2 `cmi.suspend_data` (spec limit 4096 characters). Portable
 *          across devices, visible to the LMS, and the only layer an LMS can
 *          report on.
 * Layer 2: IndexedDB, scoped to the Moodle origin. Effectively unlimited, but
 *          per browser and per device, and it can be evicted (Safari's 7-day
 *          script-writable storage cap, quota pressure, "clear browsing data",
 *          private windows). Used when the scene bundle does not fit in layer 1,
 *          and as a higher-fidelity copy otherwise.
 *
 * Layer 2 is bound to one LMS attempt through the standard bookmark
 * `cmi.core.lesson_location` (`swarm-scene-v1:<32 hex>`). Moodle loads both
 * `cmi.suspend_data` and the bookmark per SCO, student and current attempt, so
 * a browser record is only restored by the attempt that wrote it. An attempt
 * that starts `ab-initio` never reads (or attaches) an earlier attempt's data.
 *
 * suspend_data keeps the last snapshot that fits, so a student returning on
 * another device still gets a (possibly older) complete scene. When it has
 * never held a full snapshot, it receives a small reference payload instead so
 * the LMS still records that a saved session exists. Restores pick the newest
 * complete snapshot and never a partial one.
 */

import * as scorm from './scorm-wrapper.js';
import {
  decodeSessionPayload,
  encodeSessionReference,
  encodeSessionState,
  isUsableSessionState,
  SUSPEND_DATA_MAX_LENGTH,
} from './state-codec.js';

const DB_NAME = 'swarm-scorm';
const DB_VERSION = 1;
const STORE_NAME = 'session_state';
const RECORD_TTL_MS = 180 * 24 * 60 * 60 * 1000;
const MAX_RECORDS_PER_ACTIVITY = 8;
const INDEXED_DB_OPEN_TIMEOUT_MS = 2000;
const BOOKMARK_PREFIX = 'swarm-scene-v1:';

/**
 * Create a persistence controller for one activity session.
 *
 * The controller reads the LMS entry mode when it is created, so call it after
 * `scorm.init()`.
 * @param {{
 *   activityId?: string,
 *   studentId?: string,
 *   limit?: number,
 *   onWarning?: (message: string) => void,
 * }} options
 */
export function createSessionPersistence({
  activityId = '',
  studentId = '',
  limit = SUSPEND_DATA_MAX_LENGTH,
  onWarning = () => {},
} = {}) {
  const configuredLimit = normalizeLimit(limit);
  const startsFresh = scorm.getEntry() === 'ab-initio';
  // Read once: a Moodle attempt is identified by the path the package is
  // served from, and the page can change its location later in the session.
  const locationHash = hashLocation();

  let effectiveLimit = configuredLimit;
  let persistedPayload = null;
  let suspendDataHasState = false;
  let indexedDbSavedAt = 0;
  let indexedDbSupported = Boolean(globalThis.indexedDB) && studentId !== '';
  let lastPersistedFingerprint = null;
  let hasWarnedAboutRejectedWrite = false;
  let hasWarnedAboutSize = false;
  let dbPromise = null;
  let queue = Promise.resolve();
  let discarding = false;

  // Binding for this attempt: the bookmark this package owns, the key derived
  // from it, and whether the LMS holds someone else's non-empty bookmark.
  let boundBookmark = '';
  let recordKey = null;
  let foreignBookmark = false;
  applyLaunchBookmark();

  /**
   * Restore the newest complete snapshot from either layer.
   * @returns {Promise<{
   *   state: object|null,
   *   source: 'suspend_data'|'indexeddb'|null,
   *   savedAt: number,
   *   notice: string|null,
   * }>}
   */
  async function restore() {
    if (startsFresh) {
      // Moodle starts every new attempt with empty track fields, but a reload
      // of the same fresh attempt would otherwise reattach whatever the LMS
      // still shows. Clear only data this package recognises as its own.
      const leftover = scorm.getSuspendData();
      if (decodeSessionPayload({ payload: leftover, activityId })) {
        scorm.clearSuspendData();
      }
      if (scorm.isSceneBookmark(scorm.getSceneBookmark())) {
        scorm.setSceneBookmark('');
      }
      boundBookmark = '';
      recordKey = null;
      return { state: null, source: null, savedAt: 0, notice: null };
    }

    const storedPayload = scorm.getSuspendData();
    const decoded = decodeSessionPayload({ payload: storedPayload, activityId });
    applyLaunchBookmark();

    // Layer 2 is reachable only through a bookmark this package wrote.
    const record = boundBookmark ? await readRecord() : null;

    persistedPayload = decoded ? storedPayload : null;
    suspendDataHasState = decoded?.kind === 'state';
    indexedDbSavedAt = record?.savedAt ?? 0;

    // Reuse the cap learned in an earlier session instead of re-discovering it
    // with another rejected write.
    if (Number.isFinite(record?.suspendLimit) && record.suspendLimit > 0) {
      effectiveLimit = Math.min(configuredLimit, Math.trunc(record.suspendLimit));
    }

    const candidates = [];
    if (decoded?.kind === 'state') {
      candidates.push({ source: 'suspend_data', state: decoded.state, savedAt: decoded.savedAt });
    }
    if (record) {
      candidates.push({ source: 'indexeddb', state: record.state, savedAt: record.savedAt });
    }

    candidates.sort((a, b) => b.savedAt - a.savedAt);
    const newest = candidates[0];
    if (!newest) {
      return {
        state: null,
        source: null,
        savedAt: 0,
        // The LMS knows about a saved session, but this browser no longer holds it.
        notice: decoded?.kind === 'reference'
          ? 'This browser no longer has the saved copy of your scene (storage was cleared, or you are on another device). Starting from the activity\'s packaged scene.'
          : null,
      };
    }

    lastPersistedFingerprint = fingerprintOf(newest.state);
    return { state: newest.state, source: newest.source, savedAt: newest.savedAt, notice: null };
  }

  /**
   * Persist the scene: IndexedDB first (full fidelity), then suspend_data.
   * Writes are serialised so a slow IndexedDB write cannot land out of order.
   * @param {object} state
   * @returns {Promise<'suspend_data'|'indexeddb'|'none'>}
   */
  function persist(state) {
    const run = () => persistState(state);
    // Resume after a failed write instead of leaving the chain rejected.
    queue = queue.then(run, run);
    return queue;
  }

  /**
   * Persist synchronously using suspend_data only, for unload handlers where
   * IndexedDB writes may not complete.
   * @param {object} state
   * @returns {'suspend_data'|'indexeddb'|'none'}
   */
  function persistNow(state) {
    // A reset is clearing this attempt; letting an unload save recreate it
    // would resurrect the discarded scene.
    if (discarding) return 'none';
    if (!scorm.isSessionActive()) return 'none';

    const fingerprint = fingerprintOf(state);
    if (fingerprint === lastPersistedFingerprint) {
      return currentSource();
    }

    const payload = encodeSessionState({
      activityId,
      state,
      savedAt: Date.now(),
      limit: effectiveLimit,
    });

    if (payload && writePayload(payload)) {
      lastPersistedFingerprint = fingerprint;
      return 'suspend_data';
    }

    if (indexedDbSavedAt > 0) {
      // The IndexedDB copy is at most one debounce interval old.
      if (!suspendDataHasState) {
        writeReference(indexedDbSavedAt);
      }
      if (!payload) {
        warnAboutUnsavedScene(payload, true);
      }
      return 'indexeddb';
    }

    warnAboutUnsavedScene(payload, false);
    return 'none';
  }

  /**
   * Drop both stored layers. The supplied state becomes the new baseline, so
   * scene change events fired after a reset do not write it straight back.
   * A pending queued save cannot recreate the discarded state.
   * @param {object} [state] - Scene state to treat as already persisted
   * @returns {Promise<void>}
   */
  function discard(state) {
    discarding = true;
    const run = () => discardState(state).finally(() => {
      discarding = false;
    });
    queue = queue.then(run, run);
    return queue;
  }

  async function discardState(state) {
    const sessionActive = scorm.isSessionActive();
    const snapshotCleared = !sessionActive || scorm.clearSuspendData();
    let bookmarkCleared = true;
    if (sessionActive && boundBookmark !== '') {
      bookmarkCleared = scorm.setSceneBookmark('');
    }
    const deleted = await deleteRecord();

    persistedPayload = null;
    suspendDataHasState = false;
    indexedDbSavedAt = 0;
    effectiveLimit = configuredLimit;
    boundBookmark = '';
    recordKey = null;
    lastPersistedFingerprint = state ? fingerprintOf(state) : null;

    // An untouched local record still prevents a restore, so a rejected
    // bookmark clear only matters when the delete failed too.
    if (!snapshotCleared || (!bookmarkCleared && !deleted)) {
      throw new Error('the saved scene could not be cleared');
    }
  }

  async function persistState(state) {
    if (!scorm.isSessionActive()) return 'none';

    const fingerprint = fingerprintOf(state);
    if (fingerprint === lastPersistedFingerprint) {
      return currentSource();
    }

    const savedAt = Date.now();
    const indexedDbSaved = await writeRecord(state, savedAt);
    const payload = encodeSessionState({
      activityId,
      state,
      savedAt,
      limit: effectiveLimit,
    });

    if (payload && writePayload(payload)) {
      lastPersistedFingerprint = fingerprint;
      return 'suspend_data';
    }

    if (indexedDbSaved) {
      if (!suspendDataHasState) {
        writeReference(savedAt);
      }
      if (!payload) {
        // Too large for the LMS: say so once, so the limitation is visible.
        warnAboutUnsavedScene(payload, true);
      }
      lastPersistedFingerprint = fingerprint;
      return 'indexeddb';
    }

    warnAboutUnsavedScene(payload, false);
    return 'none';
  }

  function currentSource() {
    if (suspendDataHasState) return 'suspend_data';
    return indexedDbSavedAt > 0 ? 'indexeddb' : 'none';
  }

  function writePayload(payload) {
    if (!scorm.setSuspendData(payload)) {
      return false;
    }

    const stored = scorm.getSuspendData();
    if (stored === payload) {
      persistedPayload = payload;
      suspendDataHasState = true;
      return true;
    }

    // The LMS stored something else — usually truncation at its own limit.
    if (stored.length < payload.length) {
      effectiveLimit = Math.max(stored.length, 0) || configuredLimit;
      if (persistedPayload) {
        // Put the last known good snapshot back.
        scorm.setSuspendData(persistedPayload);
      } else {
        // Never leave a truncated payload behind for the next session.
        scorm.clearSuspendData();
      }
    }
    warnOnceAboutRejectedWrite(stored.length, payload.length);
    return false;
  }

  function writeReference(savedAt) {
    const reference = encodeSessionReference({ activityId, savedAt });
    if (reference === persistedPayload) return true;
    if (!writePayload(reference)) return false;
    suspendDataHasState = false;
    return true;
  }

  function warnAboutUnsavedScene(payload, indexedDbSaved) {
    if (hasWarnedAboutSize) return;
    hasWarnedAboutSize = true;

    if (!payload) {
      onWarning(
        indexedDbSaved
          ? 'Your scene is stored in this browser only — it is too large for the LMS to keep.'
          : 'Your scene is too large to save, so it will not be restored next session.',
      );
      return;
    }

    onWarning('The LMS did not store your scene, so it will not be restored next session.');
  }

  function warnOnceAboutRejectedWrite(storedLength, payloadLength) {
    if (hasWarnedAboutRejectedWrite) return;
    hasWarnedAboutRejectedWrite = true;
    console.warn(
      `[SessionPersistence] LMS stored ${storedLength} of ${payloadLength} characters; `
      + `capping suspend data at ${effectiveLimit} characters.`,
    );
  }

  /** Adopt the bookmark the LMS returned for this attempt, if it is ours. */
  function applyLaunchBookmark() {
    const value = scorm.getSceneBookmark();
    foreignBookmark = value !== '' && !scorm.isSceneBookmark(value);
    boundBookmark = scorm.isSceneBookmark(value) ? value : '';
    recordKey = boundBookmark ? buildRecordKey(activityId, studentId, locationHash, boundBookmark) : null;
  }

  async function readRecord() {
    if (!recordKey) return null;
    const db = await openDatabase();
    if (!db) return null;

    try {
      const record = await runRequest(db.transaction(STORE_NAME, 'readonly')
        .objectStore(STORE_NAME)
        .get(recordKey));
      if (!record) return null;
      if (record.activityId !== activityId || record.studentId !== studentId) return null;
      if (record.bookmark !== boundBookmark) return null;
      if (!isUsableSessionState(record.state)) return null;
      return {
        state: record.state,
        savedAt: Number(record.savedAt) || 0,
        suspendLimit: Number(record.suspendLimit) || 0,
      };
    } catch (err) {
      console.warn('[SessionPersistence] Could not read IndexedDB state:', err.message);
      indexedDbSupported = false;
      return null;
    }
  }

  async function writeRecord(state, savedAt) {
    if (!indexedDbSupported || studentId === '' || foreignBookmark) return false;

    const db = await openDatabase();
    if (!db) return false;

    // The first browser save of an attempt allocates its binding. Until this
    // succeeds there is no reachable record to write.
    if (!boundBookmark && !bindBookmark()) return false;

    const record = {
      key: recordKey,
      activityId,
      studentId,
      bookmark: boundBookmark,
      savedAt,
      suspendLimit: effectiveLimit,
      state,
    };
    try {
      await putRecord(db, record);
      indexedDbSavedAt = savedAt;
      pruneOldRecords(db, savedAt).catch(() => {});
      return true;
    } catch (err) {
      console.warn('[SessionPersistence] Could not store IndexedDB state:', err.message);
      return false;
    }
  }

  /** Allocate the attempt token and prove the LMS stored it verbatim. */
  function bindBookmark() {
    const cryptoApi = globalThis.crypto;
    if (typeof cryptoApi?.getRandomValues !== 'function') return false;

    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    const value = `${BOOKMARK_PREFIX}${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
    if (!scorm.setSceneBookmark(value)) return false;
    if (scorm.getSceneBookmark() !== value) return false;

    boundBookmark = value;
    recordKey = buildRecordKey(activityId, studentId, locationHash, value);
    return true;
  }

  async function putRecord(db, record) {
    try {
      await runRequest(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(record));
    } catch (err) {
      if (err?.name !== 'QuotaExceededError') throw err;
      // Make room by dropping every other record, then retry once.
      await deleteAllExcept(db, record.key);
      await runRequest(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).put(record));
    }
  }

  async function deleteRecord() {
    if (!indexedDbSupported || !recordKey) return false;

    const db = await openDatabase();
    if (!db) return false;

    try {
      await runRequest(db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(recordKey));
      return true;
    } catch (err) {
      console.warn('[SessionPersistence] Could not clear IndexedDB state:', err.message);
      return false;
    }
  }

  async function deleteAllExcept(db, keepKey) {
    const records = await runRequest(db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll());
    await Promise.all(records
      .filter((record) => record.key !== keepKey)
      .map((record) => runRequest(
        db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(record.key),
      )));
  }

  async function pruneOldRecords(db, now) {
    const records = await runRequest(db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll());
    const mine = records
      .filter((record) => record.activityId === activityId && record.studentId === studentId)
      .sort((a, b) => (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0));

    const doomed = records
      // Expire stale records everywhere, including tokenless legacy keys.
      .filter((record) => record.key !== recordKey && now - (Number(record.savedAt) || 0) > RECORD_TTL_MS)
      // The per-attempt cap is per activity and student, never per attempt.
      .concat(mine.slice(MAX_RECORDS_PER_ACTIVITY).filter((record) => record.key !== recordKey));

    await Promise.all(doomed.map((record) => runRequest(
      db.transaction(STORE_NAME, 'readwrite').objectStore(STORE_NAME).delete(record.key),
    )));
  }

  function openDatabase() {
    if (!indexedDbSupported) return Promise.resolve(null);
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve) => {
      let settled = false;
      const settle = (db) => {
        if (settled) return;
        settled = true;
        resolve(db);
      };

      let request;
      try {
        request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        console.warn('[SessionPersistence] IndexedDB unavailable:', err.message);
        indexedDbSupported = false;
        settle(null);
        return;
      }

      // A blocked or stalled open must never hold up activity start-up.
      setTimeout(() => {
        if (settled) return;
        console.warn('[SessionPersistence] IndexedDB open timed out; continuing without it.');
        settle(null);
      }, INDEXED_DB_OPEN_TIMEOUT_MS);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME, { keyPath: 'key' });
        }
      };
      request.onsuccess = () => settle(request.result);
      request.onerror = () => {
        console.warn('[SessionPersistence] IndexedDB open failed:', request.error?.message);
        indexedDbSupported = false;
        settle(null);
      };
      request.onblocked = () => settle(null);
    });

    return dbPromise;
  }

  return {
    restore,
    persist,
    persistNow,
    discard,
  };
}

function runRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

function buildRecordKey(activityId, studentId, locationHash, bookmark) {
  return `${activityId}::${studentId}::${locationHash}::${bookmark}`;
}

/**
 * Distinguish Moodle activities that reuse the same package. Each SCORM
 * instance is served from its own path (content id), so hashing the document
 * path keeps two copies of one package from sharing a record. The query string
 * is excluded because Moodle and cache-busting append volatile parameters.
 * @returns {string}
 */
function hashLocation() {
  const source = globalThis.location?.pathname ?? '';
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

function fingerprintOf(state) {
  return JSON.stringify(state);
}

function normalizeLimit(limit) {
  const value = Number(limit);
  return Number.isFinite(value) && value > 0 ? Math.trunc(value) : SUSPEND_DATA_MAX_LENGTH;
}
