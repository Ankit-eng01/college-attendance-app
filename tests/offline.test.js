'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const offline = require('../offline.js');

const op = (overrides) => Object.assign({
  id: 'attendance:2026-11-27:math:abc',
  type: 'attendance',
  entity: 'calendar',
  ref: '2026-11-27:math',
  fingerprint: 'abc',
  createdAt: 1000
}, overrides || {});

test('operation normalization rejects junk and clamps hostile metadata', () => {
  assert.equal(offline.normalizeOperation(null), null);
  assert.equal(offline.normalizeOperation([]), null);
  assert.equal(offline.normalizeOperation({ type: 'state' }), null, 'an id is required');

  const clean = offline.normalizeOperation(op({
    type: 'drop-table',
    attempts: -8,
    lastError: '<script>alert(1)</script>\nfailed',
    status: 'synced',
    createdAt: 'not a number'
  }));
  assert.equal(clean.type, 'state', 'unknown types fall back to a plain state record');
  assert.equal(clean.attempts, 0);
  assert.equal(clean.status, 'synced');
  assert.ok(clean.createdAt > 0);
  assert.ok(!clean.lastError.includes('<script>'));
  assert.ok(!clean.lastError.includes('\n'));
});

test('enqueue is idempotent and never duplicates the same real change', () => {
  const first = offline.enqueueOperation([], op());
  assert.equal(first.added, true);
  const second = offline.enqueueOperation(first.operations, op());
  assert.equal(second.added, false);
  assert.equal(second.operations.length, 1);

  const changed = offline.enqueueOperation(second.operations, op({ id: 'state:def', type: 'state', fingerprint: 'def' }));
  assert.equal(changed.added, true);
  assert.equal(changed.operations.length, 2);
  assert.equal(offline.operationSummary(changed.operations).pending, 2);
});

test('attempts are recorded on failure but never silently mark an item synced', () => {
  let queue = offline.enqueueOperation([], op()).operations;
  const ids = queue.map((item) => item.id);
  queue = offline.markOperationAttempts(queue, ids, 'Network unavailable');
  assert.equal(queue[0].status, 'pending');
  assert.equal(queue[0].attempts, 1);
  assert.equal(queue[0].lastError, 'Network unavailable');

  queue = offline.markOperationAttempts(queue, ['not-present'], 'ignored');
  assert.equal(queue[0].attempts, 1, 'unknown ids are left untouched');

  for (let i = 0; i < 100; i++) queue = offline.markOperationAttempts(queue, ids, 'still failing');
  assert.equal(queue[0].attempts, 50, 'attempt count is bounded');
  assert.equal(offline.pendingOperations(queue).length, 1);
});

test('markOperations only acknowledges the ids captured before the push', () => {
  const pushed = offline.enqueueOperation([], op()).operations;
  const queue = offline.enqueueOperation(pushed, op({ id: 'attendance:later', fingerprint: 'later' })).operations;
  const pushedIds = pushed.map((item) => item.id);

  const after = offline.markOperations(queue, pushedIds, { status: 'synced', syncedAt: 5000, fingerprint: 'pushed' });
  const summary = offline.operationSummary(after);
  assert.equal(summary.synced, 1);
  assert.equal(summary.pending, 1, 'a change made during the push stays pending');
  assert.equal(after.find((item) => item.id === 'attendance:later').status, 'pending');
  assert.equal(after.find((item) => item.id === pushedIds[0]).syncedAt, 5000);
});

test('queue summary reports real pending work and storage-independent counts', () => {
  const queue = [
    offline.normalizeOperation(op({ status: 'synced' })),
    offline.normalizeOperation(op({ id: 'p2', createdAt: 3000 })),
    offline.normalizeOperation(op({ id: 'p3', type: 'restore', createdAt: 2000 }))
  ];
  const summary = offline.operationSummary(queue);
  assert.equal(summary.count, 3);
  assert.equal(summary.pending, 2);
  assert.equal(summary.synced, 1);
  assert.equal(summary.oldestAt, 2000);
  assert.equal(summary.newestAt, 3000);
  assert.deepEqual(summary.types, { attendance: 1, restore: 1 });
});

test('flush decision requires explicit resolution when both copies diverged', () => {
  assert.deepEqual(offline.decideFlush({ hasRemote: false }), { action: 'push', reason: 'no-remote' });
  assert.equal(offline.decideFlush({ hasRemote: true, remoteFingerprint: 'a', localFingerprint: 'a' }).action, 'push');

  const ours = offline.decideFlush({
    hasRemote: true, remoteFingerprint: 'pushed', localFingerprint: 'local', lastPushedFingerprint: 'pushed'
  });
  assert.equal(ours.action, 'push');
  assert.equal(ours.reason, 'our-last-push');

  const remoteChanged = offline.decideFlush({
    hasRemote: true, remoteFingerprint: 'remote', localFingerprint: 'pushed', lastPushedFingerprint: 'pushed'
  });
  assert.equal(remoteChanged.action, 'conflict');
  assert.equal(remoteChanged.reason, 'remote-changed');

  const bothChanged = offline.decideFlush({
    hasRemote: true, remoteFingerprint: 'remote', localFingerprint: 'local', lastPushedFingerprint: 'pushed'
  });
  assert.equal(bothChanged.action, 'conflict');

  const firstSync = offline.decideFlush({ hasRemote: true, remoteFingerprint: 'remote', localFingerprint: 'local' });
  assert.equal(firstSync.action, 'conflict', 'an unknown remote is never overwritten silently');

  const approved = offline.decideFlush({
    hasRemote: true, remoteFingerprint: 'remote', localFingerprint: 'local', force: true
  });
  assert.equal(approved.action, 'push');
  assert.equal(approved.reason, 'user-approved');
});

test('push payload is the whole document the real backend accepts', () => {
  const state = {
    syncCode: 'ATN-ABCD-EFGH-IJKL',
    syncAuthKey: 'secret',
    studentName: 'Student',
    subjects: [{ id: 'math', attended: 1, total: 2 }],
    calendar: { '2026-11-27': { isHoliday: false, entries: { math: 'present' } } },
    history: [{ id: 'h1', subId: 'math', date: '2026-11-27', status: 'present' }],
    timetable: [{ id: 't1', subjectId: 'math' }],
    notifPrefs: { enabled: true, reminderLeadMinutes: 30 },
    notifications: [{ key: 'below:math:2:50.0', title: 'Alert', body: 'Real alert' }],
    simScenarios: [],
    localUpdatedAt: 123,
    globalTarget: 80
  };
  const payload = offline.buildPushPayload(state, { label: 'Test device' }, '2026-11-27T10:00:00.000Z');
  assert.equal(payload.sync_code, state.syncCode);
  assert.equal(payload.auth_token, state.syncAuthKey);
  assert.equal(payload.data.lastUpdated, '2026-11-27T10:00:00.000Z');
  assert.equal(payload.data.globalTarget, 80);
  assert.equal(payload.data.notifications.length, 1, 'alerts are part of the cloud document');
  assert.equal(payload.data.timetable.length, 1);
  assert.equal(payload.data.notifPrefs.reminderLeadMinutes, 30);
  assert.deepEqual(payload.data.device, { label: 'Test device' });
});

test('storage adapter works without browser APIs and reports that it is not durable', async () => {
  const adapter = await offline.createAdapter();
  assert.ok(['indexeddb', 'localStorage', 'memory'].includes(adapter.kind));
  if (adapter.kind === 'memory') assert.equal(adapter.durable, false);
  await adapter.put('operations', 'outbox', [offline.normalizeOperation(op())]);
  const rows = await adapter.getAll('operations');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].value[0].id, op().id);
  await adapter.clear('operations');
  assert.equal((await adapter.getAll('operations')).length, 0);
});
