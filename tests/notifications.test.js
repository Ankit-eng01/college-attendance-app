'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const calc = require('../calc.js');

const baseState = () => ({
  globalTarget: 75,
  subjects: [
    { id: 'math', name: 'Mathematics', attended: 5, total: 10, target: 75 },
    { id: 'mal', name: 'MAL', attended: 9, total: 10, target: 75 }
  ],
  timetable: [],
  history: [],
  calendar: {}
});

test('notification preferences accept legacy backups and new categories', () => {
  const legacy = calc.sanitizeNotifPrefs({ enabled: true, danger: false, lastMilestone: 80 });
  assert.equal(legacy.danger, false);
  assert.equal(legacy.categories.danger, false);
  assert.equal(legacy.categories.belowTarget, true);
  assert.equal(legacy.reminderLeadMinutes, 30);
  assert.equal(legacy.quietStart, '22:00');

  const modern = calc.sanitizeNotifPrefs({
    categories: { danger: false, weekly: false },
    quietHours: { enabled: true, start: '23:30', end: '6:00' },
    reminderLeadMinutes: 999,
    permissionDenied: true
  });
  assert.equal(modern.categories.danger, false);
  assert.equal(modern.categories.weekly, false);
  assert.equal(modern.danger, false);
  assert.equal(modern.quietHoursEnabled, true);
  assert.equal(modern.quietStart, '23:30');
  assert.equal(modern.quietEnd, '06:00');
  assert.equal(modern.reminderLeadMinutes, 240);
  assert.equal(modern.permissionDenied, true);
});

test('quiet hours handle overnight windows and never apply when disabled', () => {
  const prefs = { quietHoursEnabled: true, quietStart: '22:00', quietEnd: '07:00' };
  assert.equal(calc.isQuietHour(prefs, new Date(2026, 10, 27, 23, 15)), true);
  assert.equal(calc.isQuietHour(prefs, new Date(2026, 10, 27, 3, 0)), true);
  assert.equal(calc.isQuietHour(prefs, new Date(2026, 10, 27, 12, 0)), false);
  assert.equal(calc.isQuietHour({ quietHoursEnabled: false }, new Date(2026, 10, 27, 23, 15)), false);

  const daytime = { quietHoursEnabled: true, quietStart: '09:00', quietEnd: '17:00' };
  assert.equal(calc.isQuietHour(daytime, new Date(2026, 10, 27, 10, 0)), true);
  assert.equal(calc.isQuietHour(daytime, new Date(2026, 10, 27, 18, 0)), false);
});

test('class reminders respect the configured lead time, not a fixed 120 minutes', () => {
  const entry = { start: '10:00' };
  assert.equal(calc.isWithinReminderLead(entry, { reminderLeadMinutes: 30 }, new Date(2026, 10, 27, 9, 35)), true);
  assert.equal(calc.isWithinReminderLead(entry, { reminderLeadMinutes: 30 }, new Date(2026, 10, 27, 8, 0)), false);
  assert.equal(calc.isWithinReminderLead(entry, { reminderLeadMinutes: 60 }, new Date(2026, 10, 27, 9, 0)), true);
  assert.equal(calc.isWithinReminderLead(entry, { reminderLeadMinutes: 60 }, new Date(2026, 10, 27, 8, 0)), false);
  assert.equal(calc.isWithinReminderLead(entry, { reminderLeadMinutes: 60 }, new Date(2026, 10, 27, 10, 15)), false);
});

test('candidates come from raw subject stats and are deduplicated by key', () => {
  const state = baseState();
  const prefs = calc.sanitizeNotifPrefs({ categories: { weekly: false, milestones: false } });
  const now = new Date(2026, 10, 27, 12, 0);
  const first = calc.buildNotificationCandidates(state, now, prefs, []);
  const keys = first.candidates.map((c) => c.key);
  assert.ok(keys.includes('below:math:10:50.0'));
  assert.ok(!keys.some((k) => k.startsWith('below:mal')), 'a subject on target is not alerted');
  assert.ok(keys.some((k) => k.startsWith('danger:math')), '50% is in the danger zone');

  const second = calc.buildNotificationCandidates(state, now, prefs, keys);
  assert.equal(second.candidates.length, 0, 'the same real situation never creates a duplicate alert');
});

test('disabled notifications and disabled categories create no candidates', () => {
  const state = baseState();
  const disabled = calc.buildNotificationCandidates(state, new Date(), calc.sanitizeNotifPrefs({ enabled: false }), []);
  assert.equal(disabled.candidates.length, 0);

  const quiet = calc.sanitizeNotifPrefs({
    categories: { belowTarget: false, danger: false, classReminder: false, weekly: false, milestones: false }
  });
  assert.equal(calc.buildNotificationCandidates(state, new Date(), quiet, []).candidates.length, 0);
});

test('weekly and milestone alerts update their markers exactly once', () => {
  const state = baseState();
  state.subjects = [{ id: 'math', name: 'Mathematics', attended: 9, total: 10, target: 75 }];
  state.history = [{ subId: 'math', date: '2026-11-23', status: 'present' }];
  const prefs = calc.sanitizeNotifPrefs({ categories: { belowTarget: false, danger: false } });
  const now = new Date(2026, 10, 27, 12, 0);

  const first = calc.buildNotificationCandidates(state, now, prefs, []);
  const kinds = first.candidates.map((c) => c.category);
  assert.ok(kinds.includes('weekly'));
  assert.ok(kinds.includes('milestones'));
  assert.equal(first.prefUpdates.lastWeeklyISO, '2026-11-23');
  assert.equal(first.prefUpdates.lastMilestone, 85, 'milestones use real 75/80/85 thresholds');

  const updated = Object.assign({}, prefs, first.prefUpdates);
  const second = calc.buildNotificationCandidates(state, now, updated, first.candidates.map((c) => c.key));
  assert.equal(second.candidates.length, 0);
  assert.deepEqual(second.prefUpdates, {});
});

test('notification records are sanitized, deduplicated and capped', () => {
  const notes = calc.sanitizeNotifications([
    { key: 'a', title: '<script>x</script>Alarm', body: 'Real <b>alert</b> text', category: 'danger', timestamp: 2 },
    { key: 'a', title: 'Duplicate', body: 'Should be ignored', timestamp: 3 },
    { key: 'b', title: 'Second', body: 'Another real alert', timestamp: 1, read: true }
  ], { maxHistory: 2 });
  assert.equal(notes.length, 2);
  assert.equal(notes[0].key, 'a');
  assert.ok(!notes[0].title.includes('<script>'));
  assert.ok(!notes[0].body.includes('<b>'));
  assert.equal(notes[0].read, false);
  assert.equal(notes[1].key, 'b');
  assert.equal(notes[1].read, true);
});

test('backup sanitization and merge preserve notification preferences and history', () => {
  const state = baseState();
  state.notifPrefs = calc.sanitizeNotifPrefs({ categories: { danger: false }, reminderLeadMinutes: 60 });
  state.notifications = [{
    key: 'below:math:10:50.0', category: 'belowTarget', title: 'Alert', body: 'Mathematics is at 50.0%', timestamp: 100, read: true
  }];
  const clean = calc.sanitizeState(state);
  assert.equal(clean.notifPrefs.categories.danger, false);
  assert.equal(clean.notifPrefs.reminderLeadMinutes, 60);
  assert.equal(clean.notifications.length, 1);
  assert.equal(clean.notifications[0].read, true);

  const merged = calc.mergeStates(baseState(), clean);
  assert.equal(merged.state.notifications.length, 1, 'merge unions alert history without dropping local records');
  assert.equal(merged.state.notifPrefs.reminderLeadMinutes, 30, 'merge keeps the local preferences; replace restores them');
  assert.equal(merged.added.notifications, 1);
  assert.notEqual(calc.fingerprintState(baseState()), calc.fingerprintState(clean),
    'preferences and alerts participate in sync change detection');
});
