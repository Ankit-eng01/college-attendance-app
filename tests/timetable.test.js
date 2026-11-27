'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const calc = require('../calc.js');

const subjects = [
  { id: 'math', name: 'Mathematics', category: 'theory', attended: 8, total: 10, target: 75 },
  { id: 'mal', name: 'MAL', category: 'lab', attended: 3, total: 8, target: 75 }
];

test('timetable entry validates time, weekday, type and metadata', () => {
  const entry = calc.normalizeTimetableEntry({
    id: 'tt_1', day: 3, subjectId: 'math', start: '09:00', end: '10:00',
    room: 'B-204', faculty: 'Dr. Rao', classType: 'lab', notes: '<script>alert(1)</script>Bring record',
    recurrence: 'weekly'
  }, subjects);

  assert.equal(entry.id, 'tt_1');
  assert.equal(entry.day, 3);
  assert.equal(entry.subjectName, 'Mathematics');
  assert.equal(entry.classType, 'lab');
  assert.equal(entry.room, 'B-204');
  assert.equal(entry.faculty, 'Dr. Rao');
  assert.ok(!entry.notes.includes('<script>'));
  assert.equal(entry.recurrence, 'weekly');
  assert.equal(entry.cancelled, false);
  assert.equal(entry.holiday, false);
});

test('timetable entry rejects invalid times and unknown subjects', () => {
  assert.equal(calc.normalizeTimetableEntry({ start: '25:00', subjectName: 'X' }, subjects), null);
  assert.equal(calc.normalizeTimetableEntry({ start: '10:00', end: '09:00', subjectName: 'X' }, subjects), null);
  assert.equal(calc.normalizeTimetableEntry({ start: '10:00', subjectId: 'ghost' }, subjects), null);
});

test('one-off entries derive the weekday from their date', () => {
  const entry = calc.normalizeTimetableEntry({
    subjectId: 'math', start: '11:00', recurrence: 'once', date: '2026-11-27', day: 1
  }, subjects);
  assert.equal(entry.recurrence, 'once');
  assert.equal(entry.date, '2026-11-27');
  assert.equal(entry.day, new Date(2026, 10, 27).getDay());
});

test('overlap detection honours explicit opt-in, cancellations and holidays', () => {
  const a = calc.normalizeTimetableEntry({ id: 'a', subjectId: 'math', day: 1, start: '09:00', end: '10:00' }, subjects);
  const b = calc.normalizeTimetableEntry({ id: 'b', subjectId: 'mal', day: 1, start: '09:30', end: '10:30' }, subjects);
  const c = calc.normalizeTimetableEntry({ id: 'c', subjectId: 'mal', day: 1, start: '10:00', end: '11:00' }, subjects);
  const cancelled = calc.normalizeTimetableEntry({ id: 'd', subjectId: 'mal', day: 1, start: '09:30', end: '10:30', cancelled: true }, subjects);

  assert.equal(calc.timetableOverlap(a, b), true);
  assert.equal(calc.timetableOverlap(a, c), false, 'back-to-back classes do not overlap');
  assert.equal(calc.timetableOverlap(a, cancelled), false);
  // 09:30-10:30 overlaps both 09:00-10:00 and 10:00-11:00.
  assert.equal(calc.timetableConflicts([a, b, c]).length, 2);
  assert.equal(calc.timetableConflicts([a, b, Object.assign({}, b, { allowOverlap: true })]).length, 3,
    'allowOverlap is a save-time acknowledgement; it must not hide the real clash from the weekly note');
});

test('daily timetable stats use recorded attendance, never inference', () => {
  const now = new Date(2026, 10, 27, 10, 30);
  const day = now.getDay();
  const iso = calc.formatISO(now);
  const state = {
    subjects,
    history: [
      { id: 'h1', subId: 'math', date: iso, status: 'present', timestamp: 1 },
      { id: 'h2', subId: 'mal', date: iso, status: 'absent', timestamp: 2 },
      { id: 'h3', subId: 'math', date: iso, status: 'present', timestamp: 3 }
    ],
    calendar: {}
  };
  const timetable = [
    calc.normalizeTimetableEntry({ id: 'a', subjectId: 'math', day, start: '09:00', end: '10:00' }, subjects),
    calc.normalizeTimetableEntry({ id: 'b', subjectId: 'mal', day, start: '10:00', end: '11:00' }, subjects),
    calc.normalizeTimetableEntry({ id: 'c', subjectId: 'math', day, start: '14:00', end: '15:00' }, subjects)
  ];

  const ledger = calc.buildDailyLedger(state);
  assert.equal(ledger[iso].present, 1, 'duplicate math history entry must not count twice');
  assert.equal(ledger[iso].absent, 1);

  const stats = calc.timetableStats(timetable, state, now);
  assert.equal(stats.date, iso);
  assert.equal(stats.slots, 3, 'all three time slots are displayed');
  assert.equal(stats.total, 2, 'only two distinct subjects are tracked for the day');
  assert.equal(stats.completed, 2, 'two subjects have one real attendance record each');
  assert.equal(stats.upcoming, 0, 'the later math slot shares the recorded math status');
  assert.equal(stats.rows[2].status, 'present');
  assert.equal(stats.currentClass && stats.currentClass.id, 'b');
  assert.equal(stats.nextClass && stats.nextClass.id, 'c');
});

test('off records are acknowledged in the daily timetable without being counted as present', () => {
  const now = new Date(2026, 10, 27, 8, 0);
  const day = now.getDay();
  const iso = calc.formatISO(now);
  const state = {
    subjects,
    history: [],
    calendar: { [iso]: { isHoliday: false, entries: { math: 'off' } } }
  };
  const timetable = [
    calc.normalizeTimetableEntry({ id: 'off1', subjectId: 'math', day, start: '09:00' }, subjects)
  ];
  const stats = calc.timetableStats(timetable, state, now);
  assert.equal(stats.completed, 1);
  assert.equal(stats.rows[0].status, 'off');
  assert.equal(calc.buildDailyLedger(state)[iso], undefined, '"off" is not a conducted class');
});

test('cancelled and holiday entries never increase conducted classes', () => {
  const now = new Date(2026, 10, 27, 8, 0);
  const day = now.getDay();
  const state = { subjects, history: [], calendar: {} };
  const timetable = [
    calc.normalizeTimetableEntry({ id: 'x', subjectId: 'math', day, start: '09:00', cancelled: true }, subjects),
    calc.normalizeTimetableEntry({ id: 'y', subjectId: 'mal', day, start: '10:00', holiday: true }, subjects)
  ];
  const stats = calc.timetableStats(timetable, state, now);
  assert.equal(stats.total, 0);
  assert.equal(stats.completed, 0);
  assert.equal(calc.upcomingClasses(timetable, now).today.length, 0);
});

test('occurrence keys are stable for duplicate-record prevention', () => {
  const entry = { id: 'tt_7' };
  assert.equal(calc.timetableOccurrenceKey(entry, '2026-11-27'), 'tt_7|2026-11-27');
  assert.equal(calc.timetableOccurrenceKey(entry, '2026-11-27'), calc.timetableOccurrenceKey(Object.assign({}, entry), '2026-11-27'));
  assert.notEqual(calc.timetableOccurrenceKey(entry, '2026-11-27'), calc.timetableOccurrenceKey(entry, '2026-11-28'));
});

test('backup sanitization preserves timetable metadata', () => {
  const backup = calc.sanitizeState({
    subjects,
    timetable: [{
      id: 'tt_meta', subjectId: 'mal', day: 2, start: '14:00', end: '15:30',
      classType: 'tutorial', notes: 'Assignment due', recurrence: 'once',
      date: '2026-12-01', cancelled: false, holiday: false
    }],
    history: []
  });
  assert.equal(backup.timetable.length, 1);
  assert.equal(backup.timetable[0].classType, 'tutorial');
  assert.equal(backup.timetable[0].notes, 'Assignment due');
  assert.equal(backup.timetable[0].recurrence, 'once');
  assert.equal(backup.timetable[0].date, '2026-12-01');
});
