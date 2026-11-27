// ==========================================================================
// ATTENDIFY OFFLINE OUTBOX
// --------------------------------------------------------------------------
// Local-only durability layer. It records real changes on this device and
// keeps them until the app receives a real HTTP 200 from POST /push.
//
// The deployed Neon Functions backend supports only whole-document /push and
// /pull. There is no per-operation or idempotency endpoint, so this queue is
// an honest retry ledger — it never claims the server applied individual
// operations, and it never marks anything synced without a successful push.
// ==========================================================================

(function (global) {
  'use strict';

  const DB_NAME = 'attendify_offline';
  const DB_VERSION = 1;
  const STORES = ['snapshot', 'operations', 'conflicts', 'meta'];
  const FALLBACK_KEY = 'attendify_offline_v1';
  const MAX_OPERATIONS = 1000;
  const VALID_TYPES = ['attendance', 'state', 'conflict-resolution', 'restore'];

  function toInt(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
  }

  function safeText(value, max) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
      .replace(/<[^>]*>?/g, '')
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .trim()
      .slice(0, max || 120);
  }

  // --------------------------------------------------------------------
  // Pure queue logic (shared by the browser and node:test).
  // --------------------------------------------------------------------

  /** Return a normalized operation, or null when the input is unusable. */
  function normalizeOperation(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const id = safeText(raw.id, 120);
    if (!id) return null;
    const status = raw.status === 'synced' || raw.status === 'discarded' ? raw.status : 'pending';
    return {
      id,
      type: VALID_TYPES.includes(raw.type) ? raw.type : 'state',
      entity: safeText(raw.entity, 60),
      ref: safeText(raw.ref, 160),
      fingerprint: safeText(raw.fingerprint, 40),
      createdAt: toInt(raw.createdAt, Date.now()),
      attempts: toInt(raw.attempts, 0),
      lastError: safeText(raw.lastError, 200),
      status,
      syncedAt: toInt(raw.syncedAt, 0)
    };
  }

  /**
   * Add an operation once. The id is derived from the real change, so a
   * repeated save of identical data cannot inflate the queue.
   */
  function enqueueOperation(list, raw) {
    const op = normalizeOperation(raw);
    const operations = Array.isArray(list) ? list.slice() : [];
    if (!op) return { operations, added: false };
    if (operations.some((item) => item && item.id === op.id)) {
      return { operations, added: false };
    }
    operations.push(op);

    // Keep a bounded audit trail. Pending work is never dropped: only already
    // synced/discarded records are trimmed when the ledger grows too large.
    if (operations.length > MAX_OPERATIONS) {
      let surplus = operations.length - MAX_OPERATIONS;
      for (let i = 0; i < operations.length && surplus > 0; i++) {
        if (operations[i].status === 'pending') continue;
        operations.splice(i, 1);
        i--;
        surplus--;
      }
    }
    return { operations, added: true };
  }

  function pendingOperations(list) {
    return (Array.isArray(list) ? list : []).filter((op) => op && op.status === 'pending');
  }

  /** Patch only the named ids. Used after a real /push result. */
  function markOperations(list, ids, patch) {
    const wanted = new Set(Array.isArray(ids) ? ids : []);
    const cleanPatch = patch && typeof patch === 'object' ? patch : {};
    return (Array.isArray(list) ? list : []).map((op) => (
      op && wanted.has(op.id) ? Object.assign({}, op, cleanPatch) : op
    ));
  }

  /** Record a failed attempt without ever changing a pending item to synced. */
  function markOperationAttempts(list, ids, error) {
    const wanted = new Set(Array.isArray(ids) ? ids : []);
    return (Array.isArray(list) ? list : []).map((op) => {
      if (!op || !wanted.has(op.id) || op.status !== 'pending') return op;
      return Object.assign({}, op, {
        attempts: Math.min(50, toInt(op.attempts, 0) + 1),
        lastError: safeText(error, 200)
      });
    });
  }

  function operationSummary(list) {
    const ops = Array.isArray(list) ? list : [];
    const pending = pendingOperations(ops);
    const timestamps = pending.map((op) => op.createdAt).filter((n) => n > 0);
    const types = {};
    pending.forEach((op) => { types[op.type] = (types[op.type] || 0) + 1; });
    return {
      count: ops.length,
      pending: pending.length,
      synced: ops.filter((op) => op && op.status === 'synced').length,
      discarded: ops.filter((op) => op && op.status === 'discarded').length,
      oldestAt: timestamps.length ? Math.min.apply(null, timestamps) : 0,
      newestAt: timestamps.length ? Math.max.apply(null, timestamps) : 0,
      types
    };
  }

  /**
   * Pre-push decision using content fingerprints, not timestamps alone.
   * 'conflict' always requires an explicit choice by the user.
   */
  function decideFlush(input) {
    const i = input || {};
    if (i.force === true) return { action: 'push', reason: 'user-approved' };
    const local = safeText(i.localFingerprint, 40);
    const remote = safeText(i.remoteFingerprint, 40);
    const pushed = safeText(i.lastPushedFingerprint, 40);
    if (!i.hasRemote || !remote) return { action: 'push', reason: 'no-remote' };
    if (remote === local) return { action: 'push', reason: 'in-sync' };
    // The cloud still holds exactly the snapshot we last pushed: the local
    // difference is ours, so pushing cannot erase somebody else's work.
    if (pushed && remote === pushed) return { action: 'push', reason: 'our-last-push' };
    if (pushed && local === pushed) return { action: 'conflict', reason: 'remote-changed' };
    return { action: 'conflict', reason: 'both-changed' };
  }

  /** Build the exact whole-document payload accepted by POST /push. */
  function buildPushPayload(state, device, nowISO) {
    const s = state || {};
    return {
      sync_code: s.syncCode || '',
      auth_token: s.syncAuthKey || '',
      data: {
        studentName: s.studentName || '',
        accountEmail: s.accountEmail || '',
        subjects: Array.isArray(s.subjects) ? s.subjects : [],
        calendar: s.calendar && typeof s.calendar === 'object' ? s.calendar : {},
        history: Array.isArray(s.history) ? s.history : [],
        globalTarget: s.globalTarget || 75,
        activeTheme: s.activeTheme || 'graphite',
        themeMode: s.themeMode || 'dark',
        privacyMode: Boolean(s.privacyMode),
        timetable: Array.isArray(s.timetable) ? s.timetable : [],
        notifPrefs: s.notifPrefs && typeof s.notifPrefs === 'object' ? s.notifPrefs : {},
        notifications: Array.isArray(s.notifications) ? s.notifications : [],
        simScenarios: Array.isArray(s.simScenarios) ? s.simScenarios : [],
        localUpdatedAt: toInt(s.localUpdatedAt, 0),
        device: device || {},
        lastUpdated: nowISO || new Date().toISOString()
      }
    };
  }

  // --------------------------------------------------------------------
  // Storage adapters. IndexedDB is preferred; localStorage and memory are
  // explicitly reported as fallbacks so the UI never overstates durability.
  // --------------------------------------------------------------------

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined' || !indexedDB) {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      let request;
      try {
        request = indexedDB.open(DB_NAME, DB_VERSION);
      } catch (err) {
        reject(err);
        return;
      }
      request.onupgradeneeded = () => {
        const db = request.result;
        STORES.forEach((name) => {
          if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'key' });
        });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('IndexedDB open failed'));
      request.onblocked = () => reject(new Error('IndexedDB blocked by another tab'));
    });
  }

  function idbAdapter(db) {
    function request(storeName, mode, action) {
      return new Promise((resolve, reject) => {
        let transaction;
        try {
          transaction = db.transaction(storeName, mode);
        } catch (err) {
          reject(err);
          return;
        }
        const req = action(transaction.objectStore(storeName));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error || new Error('IndexedDB request failed'));
        transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted'));
      });
    }
    const wrap = (value) => ({ key: 'value', value, updatedAt: Date.now() });
    return {
      kind: 'indexeddb',
      durable: true,
      get: (store) => request(store, 'readonly', (os) => os.get('value')).then((row) => row && row.value),
      getAll: (store) => request(store, 'readonly', (os) => os.getAll()),
      put: (store, key, value) => request(store, 'readwrite', (os) => os.put(wrap(value))).then(() => true),
      remove: (store) => request(store, 'readwrite', (os) => os.delete('value')).then(() => true),
      clear: (store) => request(store, 'readwrite', (os) => os.clear()).then(() => true),
      close: () => db.close()
    };
  }

  function wrapRow(value) {
    return { key: 'value', value, updatedAt: Date.now() };
  }

  function memoryAdapter() {
    const rows = {};
    return {
      kind: 'memory',
      durable: false,
      get: (store) => Promise.resolve(rows[store] && rows[store].value),
      getAll: (store) => Promise.resolve(rows[store] ? [rows[store]] : []),
      put: (store, key, value) => { rows[store] = wrapRow(value); return Promise.resolve(true); },
      remove: (store) => { delete rows[store]; return Promise.resolve(true); },
      clear: (store) => { delete rows[store]; return Promise.resolve(true); },
      close: () => Promise.resolve(true)
    };
  }

  function localStorageAdapter() {
    let data = {};
    try {
      const raw = global.localStorage && global.localStorage.getItem(FALLBACK_KEY);
      data = raw ? JSON.parse(raw) : {};
      if (!data || typeof data !== 'object' || Array.isArray(data)) data = {};
    } catch (err) {
      data = {};
    }
    const flush = () => {
      try {
        global.localStorage.setItem(FALLBACK_KEY, JSON.stringify(data));
        return Promise.resolve(true);
      } catch (err) {
        return Promise.reject(err);
      }
    };
    return {
      kind: 'localStorage',
      durable: true,
      get: (store) => Promise.resolve(data[store] && data[store].value),
      getAll: (store) => Promise.resolve(data[store] ? [data[store]] : []),
      put: (store, key, value) => { data[store] = wrapRow(value); return flush(); },
      remove: (store) => { delete data[store]; return flush(); },
      clear: (store) => { delete data[store]; return flush(); },
      close: () => Promise.resolve(true)
    };
  }

  /** Resolve with the best available adapter; never throw to the caller. */
  function createAdapter() {
    return openDatabase()
      .then((db) => idbAdapter(db))
      .catch(() => {
        try {
          if (global.localStorage && typeof global.localStorage.setItem === 'function') {
            return localStorageAdapter();
          }
        } catch (err) {
          /* storage blocked — fall through to memory, reported as non-durable */
        }
        return memoryAdapter();
      });
  }

  const api = {
    DB_NAME,
    DB_VERSION,
    STORES,
    FALLBACK_KEY,
    MAX_OPERATIONS,
    toInt,
    safeText,
    normalizeOperation,
    enqueueOperation,
    pendingOperations,
    markOperations,
    markOperationAttempts,
    operationSummary,
    decideFlush,
    buildPushPayload,
    openDatabase,
    createAdapter
  };

  global.AttendifyOffline = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
