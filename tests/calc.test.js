'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const calc = require('../calc.js');

test('percentage handles zero and decimal cases', () => {
  assert.equal(calc.percentage(0, 0), null);
  assert.equal(calc.percentage(0, 10), 0);
  assert.equal(calc.percentage(10, 10), 100);
  assert.ok(Math.abs(calc.percentage(1, 3) - 100 / 3) < 1e-9);
  assert.equal(calc.percentage(-5, 10), 0);
});

test('stats: no classes yet never reports 100%', () => {
  const st = calc.stats({ attended: 0, total: 0 }, 75);
  assert.equal(st.hasData, false);
  assert.equal(st.percentage, '--');
  assert.equal(st.pctNum, 0);
  assert.equal(st.isShort, false);
  assert.equal(st.risk, 'nodata');
  assert.equal(st.missed, 0);
});

test('stats: zero attended with classes held is below target', () => {
  const st = calc.stats({ attended: 0, total: 12 }, 75);
  assert.equal(st.percentage, '0.0');
  assert.equal(st.isShort, true);
  assert.equal(st.risk, 'danger');
  assert.equal(st.classesNeeded, 36); // 36 present classes -> 36/48 = 75%
  assert.equal(st.safeBunks, 0);
});

test('stats: exact 75% is on track and has no safe bunks', () => {
  const st = calc.stats({ attended: 15, total: 20 }, 75);
  assert.equal(st.percentage, '75.0');
  assert.equal(st.isShort, false);
  assert.equal(st.safeBunks, 0);
  assert.equal(st.classesNeeded, 0);
  assert.equal(st.risk, 'watch'); // within 5 points of the target
});

test('stats: 100% attendance and safe bunks', () => {
  const st = calc.stats({ attended: 10, total: 10 }, 75);
  assert.equal(st.percentage, '100.0');
  assert.equal(st.safeBunks, 3); // floor(1000/75) = 13, minus 10
  assert.equal(st.risk, 'safe');
});

test('stats: 100% target becomes unreachable after any absence', () => {
  const st = calc.stats({ attended: 9, total: 10, target: 100 }, 75);
  assert.equal(st.isShort, true);
  assert.equal(st.classesNeeded, null);
  assert.match(st.shortagePct, /^10\.0$/);
});

test('stats: invalid values are clamped, not trusted', () => {
  const st = calc.stats({ attended: -4, total: 'abc' }, 75);
  assert.equal(st.attended, 0);
  assert.equal(st.total, 0);
  const st2 = calc.stats({ attended: 40, total: 10 }, 75);
  assert.equal(st2.total, 40, 'total can never be smaller than attended');
  assert.equal(st2.missed, 0);
});

test('stats: very large class counts stay finite', () => {
  const st = calc.stats({ attended: 999999, total: 1000000 }, 75);
  assert.equal(st.percentage, '100.0'); // rounds to one decimal
  assert.ok(Number.isFinite(st.safeBunks));
  assert.ok(Number.isFinite(st.classesNeeded));
});

test('safeBunks uses the exact inequality a/T >= target', () => {
  assert.equal(calc.safeBunks(16, 20, 75), 1);
  assert.equal(calc.safeBunks(3, 4, 75), 0); // exactly 75%: no room to miss
  assert.equal(calc.safeBunks(17, 20, 75), 2);
  assert.equal(calc.safeBunks(8, 10, 90), 0);
  assert.equal(calc.safeBunks(10, 10, 90), 1);
  assert.equal(calc.safeBunks(0, 0, 75), 0);
});

test('classesNeeded reaches the target with the fewest classes', () => {
  assert.equal(calc.classesNeeded(14, 20, 75), 4);
  assert.equal(calc.classesNeeded(50, 100, 75), 100);
  assert.equal(calc.classesNeeded(80, 100, 75), 0);
  assert.equal(calc.classesNeeded(8, 10, 90), 10);
  assert.equal(calc.classesNeeded(0, 0, 75), 0);
  assert.equal(calc.classesNeeded(7, 10, 100), null);
});

test('custom targets 80 and 85 behave consistently', () => {
  assert.equal(calc.stats({ attended: 17, total: 20 }, 80).isShort, false);
  assert.equal(calc.stats({ attended: 16, total: 20 }, 80).isShort, false); // exactly 80%
  assert.equal(calc.stats({ attended: 15, total: 20 }, 80).isShort, true);
  assert.equal(calc.stats({ attended: 17, total: 20 }, 85).isShort, false); // exactly 85%
  assert.equal(calc.stats({ attended: 16, total: 20 }, 85).isShort, true);
  assert.equal(calc.stats({ attended: 20, total: 20 }, 85).safeBunks, 3); // floor(2000/85) = 23
});

test('project never mutates the subject and models attend/miss', () => {
  const sub = { id: 'a', name: 'Maths', attended: 14, total: 20, target: 75 };
  const before = JSON.stringify(sub);
  const p = calc.project(sub, { attend: 4, miss: 0 }, 75);
  assert.equal(JSON.stringify(sub), before);
  assert.equal(p.attended, 18);
  assert.equal(p.total, 24);
  assert.equal(p.percentage, '75.0');
  assert.equal(p.meets, true);
  assert.equal(p.delta, 5);

  const bad = calc.project(sub, { attend: 0, miss: 6 }, 75);
  assert.equal(bad.total, 26);
  assert.equal(bad.percentage, '53.8');
  assert.equal(bad.meets, false);
  assert.equal(bad.neededAfter, 22);
});

test('projection on an empty subject works', () => {
  const p = calc.project({ attended: 0, total: 0 }, { attend: 5, miss: 0 }, 75);
  assert.equal(p.percentage, '100.0');
  assert.equal(p.meets, true);
});

test('aggregate sums real subject totals', () => {
  const agg = calc.aggregate([
    { id: 'a', name: 'A', attended: 15, total: 20 },
    { id: 'b', name: 'B', attended: 5, total: 10 },
    { id: 'c', name: 'C', attended: 0, total: 0 }
  ], 75);
  assert.equal(agg.subjects, 3);
  assert.equal(agg.attended, 20);
  assert.equal(agg.conducted, 30);
  assert.equal(agg.missed, 10);
  assert.equal(agg.percentage, '66.7');
  assert.equal(agg.belowTarget, 1); // A is exactly on 75%, B is short
  assert.equal(agg.rows.length, 3);
});

test('date parsing rejects impossible dates and never shifts timezone', () => {
  assert.equal(calc.parseISODate('2026-02-30'), null);
  assert.equal(calc.parseISODate('2026-13-01'), null);
  assert.equal(calc.parseISODate('27-11-2026'), null);
  assert.equal(calc.isValidISODate('2026-11-27'), true);

  const d = calc.parseISODate('2026-11-27');
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 10);
  assert.equal(d.getDate(), 27);
  assert.equal(calc.formatISO(d), '2026-11-27');
});

test('date arithmetic crosses month and year boundaries', () => {
  assert.equal(calc.addDaysISO('2026-11-30', 1), '2026-12-01');
  assert.equal(calc.addDaysISO('2026-01-01', -1), '2025-12-31');
  assert.equal(calc.addDaysISO('2026-02-28', 1), '2026-03-01');
  assert.equal(calc.startOfWeekISO('2026-11-27'), '2026-11-23'); // Friday -> Monday
  assert.equal(calc.startOfWeekISO('2026-11-23'), '2026-11-23');
  assert.equal(calc.startOfWeekISO('2026-11-22'), '2026-11-16'); // Sunday
});

test('time helpers validate and format', () => {
  assert.equal(calc.timeToMinutes('09:30'), 570);
  assert.equal(calc.timeToMinutes('24:00'), null);
  assert.equal(calc.timeToMinutes('9:5'), null);
  assert.equal(calc.normalizeTime('9:05'), '09:05');
  assert.equal(calc.formatTime12('13:05'), '1:05 PM');
  assert.equal(calc.formatTime12('00:15'), '12:15 AM');
});

test('weekly buckets cover the requested span with real data', () => {
  const state = {
    history: [
      { id: 'h1', subId: 'a', date: '2026-11-24', status: 'present', timestamp: 1 },
      { id: 'h2', subId: 'a', date: '2026-11-25', status: 'absent', timestamp: 1 },
      { id: 'h3', subId: 'b', date: '2026-10-05', status: 'present', timestamp: 1 }
    ],
    calendar: {},
    subjects: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  };
  const buckets = calc.attendanceBuckets(state, { mode: 'week', count: 8, anchor: '2026-11-27' });
  assert.equal(buckets.length, 8);
  assert.equal(buckets[0].key, '2026-10-05');
  assert.equal(buckets[7].key, '2026-11-23');
  assert.equal(buckets[7].present, 1);
  assert.equal(buckets[7].absent, 1);
  assert.equal(buckets[7].pctNum, 50);
  assert.equal(buckets[0].present, 1);
});

test('monthly buckets use calendar months and local keys', () => {
  const state = {
    history: [{ id: 'h1', subId: 'a', date: '2026-09-15', status: 'present', timestamp: 1 }],
    calendar: { '2026-10-02': { isHoliday: false, entries: { a: 'absent' } } },
    subjects: [{ id: 'a', name: 'A' }]
  };
  const buckets = calc.attendanceBuckets(state, { mode: 'month', count: 3, anchor: '2026-11-27' });
  assert.deepEqual(buckets.map((b) => b.key), ['2026-09', '2026-10', '2026-11']);
  assert.equal(buckets[0].present, 1);
  assert.equal(buckets[1].absent, 1);
  assert.equal(buckets[2].total, 0);
  assert.equal(buckets[2].pctNum, null);
});

test('duplicate calendar + history entries are counted once', () => {
  const state = {
    history: [{ id: 'h1', subId: 'a', date: '2026-11-24', status: 'present', timestamp: 1 }],
    calendar: { '2026-11-24': { isHoliday: false, entries: { a: 'present' } } }
  };
  const buckets = calc.attendanceBuckets(state, { mode: 'week', count: 1, anchor: '2026-11-27' });
  assert.equal(buckets[0].present, 1);
  assert.equal(buckets[0].total, 1);
});

test('trend compares weighted weekly averages', () => {
  const t = calc.trend([
    { pctNum: 50, total: 10 },
    { pctNum: 50, total: 10 },
    { pctNum: 80, total: 10 },
    { pctNum: 90, total: 10 }
  ], 2);
  assert.equal(t.direction, 'up');
  assert.equal(t.delta, 35);
  assert.equal(calc.trend([{ pctNum: 80, total: 10 }], 2).direction, 'unknown');
});

test('trend falls back to two halves when history is short', () => {
  const short = calc.trend([
    { pctNum: 50, total: 4 },
    { pctNum: 90, total: 4 }
  ], 4);
  assert.equal(short.window, 1);
  assert.equal(short.direction, 'up');
  assert.equal(short.delta, 40);
});
test('recentActivity resolves subject names and sorts newest first', () => {
  const rows = calc.recentActivity({
    subjects: [{ id: 'a', name: 'Physics' }],
    history: [
      { id: 'h1', subId: 'a', date: '2026-11-20', status: 'present', timestamp: 100 },
      { id: 'h2', subId: 'a', date: '2026-11-21', status: 'absent', timestamp: 200 },
      { id: 'h3', subId: 'gone', date: '2026-11-19', status: 'present', timestamp: 50 }
    ]
  }, 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].subject, 'Physics');
  assert.equal(rows[0].status, 'absent');
  assert.equal(rows[1].date, '2026-11-20');
});

test('timetable entries are validated and ordered', () => {
  const subjects = [{ id: 'a', name: 'Maths' }];
  assert.equal(calc.normalizeTimetableEntry({ day: 1, subjectName: 'X', start: '10:00', end: '09:00' }, subjects), null);
  assert.equal(calc.normalizeTimetableEntry({ day: 1, subjectName: 'X', start: 'bad' }, subjects), null);
  const ok = calc.normalizeTimetableEntry({ day: 1, subjectId: 'a', start: '9:00', end: '10:00', room: 'B12' }, subjects);
  assert.equal(ok.subjectName, 'Maths');
  assert.equal(ok.start, '09:00');

  const day = calc.timetableForDay([
    { day: 1, start: '11:00', subjectName: 'Later' },
    { day: 1, start: '09:00', subjectName: 'Early' },
    { day: 2, start: '08:00', subjectName: 'Other day' }
  ], 1);
  assert.deepEqual(day.map((e) => e.subjectName), ['Early', 'Later']);
});

test('upcomingClasses marks past, current and tomorrow', () => {
  const timetable = calc.sanitizeState({
    subjects: [{ id: 'a', name: 'Maths' }],
    timetable: [
      { day: 5, subjectId: 'a', start: '09:00', end: '10:00' },
      { day: 5, subjectId: 'a', start: '11:00', end: '12:00' },
      { day: 6, subjectId: 'a', start: '09:00', end: '10:00' }
    ]
  }).timetable;
  const now = new Date(2026, 10, 27, 10, 30); // Friday 27 Nov 2026, 10:30
  const view = calc.upcomingClasses(timetable, now);
  assert.equal(view.today.length, 2);
  assert.equal(view.today[0].isPast, true);
  assert.equal(view.today[1].minutesUntil, 30);
  assert.equal(view.upcoming[0].start, '11:00');
  assert.equal(view.upcoming[1].dayLabel, 'Tomorrow');
});

test('sanitizeState strips markup and clamps hostile values', () => {
  const st = calc.sanitizeState({
    studentName: '<img src=x onerror=alert(1)>Ravi',
    globalTarget: 500,
    subjects: [{
      id: 'a b', name: '<script>alert(1)</script>DBMS',
      category: 'nonsense', attended: -20, total: 5, target: 12
    }],
    calendar: { '2026-02-30': { entries: {} }, '2026-11-24': { entries: { '<b>x</b>': 'present', ok: 'absent', hidden: 'none' } } },
    history: [{ id: 'h1', subId: 'a', date: 'nope', status: 'present' }],
    timetable: [
      { day: 9, subjectName: 'Class', start: '10:00', end: '11:00' },
      { day: 1, subjectName: 'Broken', start: '11:00', end: '10:00' }
    ],
    notifPrefs: { enabled: 'yes' }
  });
  assert.equal(st.globalTarget, 100);
  assert.equal(st.studentName, 'Ravi');
  assert.equal(st.subjects[0].name, 'DBMS');
  assert.equal(st.subjects[0].category, 'theory');
  assert.equal(st.subjects[0].attended, 0);
  assert.equal(st.subjects[0].total, 5);
  assert.equal(st.subjects[0].target, 12); // targets are clamped to 1-100, not rewritten
  assert.ok(!('2026-02-30' in st.calendar));
  assert.deepEqual(st.calendar['2026-11-24'].entries, { ok: 'absent' });
  assert.equal(st.history[0].date, calc.todayISO());
  assert.equal(st.timetable.length, 1);
  assert.equal(st.timetable[0].day, 6);
  assert.equal(st.notifPrefs.enabled, true);
});

test('sanitizeState rejects invalid roots and oversized imports', () => {
  assert.throws(() => calc.sanitizeState(null), /valid JSON object/);
  assert.throws(() => calc.sanitizeState([]), /valid JSON object/);
  assert.throws(() => calc.sanitizeState({ subjects: new Array(51).fill({ name: 'x' }) }), /safe maximum/);
});

test('sanitizeState keeps credentials and settings for existing users', () => {
  const st = calc.sanitizeState({
    syncCode: 'ATN-ABCD-EFGH-JKLM',
    syncAuthKey: 'a'.repeat(32),
    accountEmail: 'Student@College.edu',
    authChoice: 'account',
    isSetupCompleted: true,
    lastSyncedAt: 123456,
    activeTheme: 'violet',
    themeMode: 'light',
    subjects: []
  });
  assert.equal(st.syncCode, 'ATN-ABCD-EFGH-JKLM');
  assert.equal(st.syncAuthKey, 'a'.repeat(32));
  assert.equal(st.accountEmail, 'student@college.edu');
  assert.equal(st.authChoice, 'account');
  assert.equal(st.activeTheme, 'sapphire');
  assert.equal(st.themeMode, 'light');
});

test('mergeStates never drops local data and skips duplicates', () => {
  const local = {
    subjects: [{ id: 'a', name: 'Maths', attended: 5, total: 10 }],
    history: [{ id: 'h1', subId: 'a', date: '2026-11-01', status: 'present', timestamp: 1 }],
    calendar: { '2026-11-01': { isHoliday: false, entries: { a: 'present' } } }
  };
  const incoming = {
    subjects: [
      { id: 'a', name: 'Maths', attended: 9, total: 12 },
      { id: 'b', name: 'Physics', attended: 1, total: 2 }
    ],
    history: [
      { id: 'h1', subId: 'a', date: '2026-11-01', status: 'present', timestamp: 1 },
      { id: 'h2', subId: 'b', date: '2026-11-02', status: 'absent', timestamp: 2 }
    ],
    calendar: { '2026-11-02': { isHoliday: false, entries: { b: 'absent' } } }
  };
  const { state, added } = calc.mergeStates(local, incoming);
  assert.equal(state.subjects.length, 2);
  assert.equal(state.subjects.find((s) => s.id === 'a').total, 12);
  assert.equal(state.history.length, 2);
  assert.equal(Object.keys(state.calendar).length, 2);
  assert.equal(added.subjects, 1);
  assert.equal(added.history, 1);
});

test('CSV export/import round-trips names with commas and quotes', () => {
  const csv = calc.subjectsToCSV([
    { id: 'a', name: 'Maths, "Advanced"', category: 'theory', attended: 15, total: 20, target: 75 },
    { id: 'b', name: 'DBMS Lab', category: 'lab', attended: 0, total: 0, target: 80 }
  ], 75);
  const rows = calc.csvToSubjects(csv, 75);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'Maths, "Advanced"');
  assert.equal(rows[0].attended, 15);
  assert.equal(rows[1].category, 'lab');
  assert.equal(rows[1].target, 80);
});

test('CSV import rejects empty and malformed input', () => {
  assert.throws(() => calc.csvToSubjects('', 75), /empty/);
  assert.throws(() => calc.csvToSubjects('Subject Name\nOnly Header', 75), /Attended/);
  assert.throws(() => calc.csvToSubjects('Foo,Bar\n1,2', 75), /Subject Name/i);
});

test('decideSync detects remote changes without silent overwrite', () => {
  const local = {
    subjects: [{ id: 'a', name: 'Maths', attended: 5, total: 10 }],
    history: [],
    lastSyncedAt: 1000
  };
  assert.equal(calc.decideSync(local, { hasRemote: false }).action, 'push');
  assert.equal(calc.decideSync(local, { hasRemote: true, data: local, updatedAt: 5000 }).action, 'push');

  const remoteChanged = {
    subjects: [{ id: 'a', name: 'Maths', attended: 9, total: 10 }],
    history: []
  };
  const decision = calc.decideSync(local, { hasRemote: true, data: remoteChanged, updatedAt: 5000 });
  assert.equal(decision.action, 'conflict');
  assert.equal(decision.reason, 'remote-newer');

  const localNewer = calc.decideSync(
    Object.assign({}, local, { lastSyncedAt: 9000 }),
    { hasRemote: true, data: remoteChanged, updatedAt: 5000 }
  );
  assert.equal(localNewer.action, 'push');
});

test('trend and comparison only use subjects with logged classes', () => {
  const rows = calc.subjectComparison([
    { id: 'a', name: 'A', attended: 9, total: 10 },
    { id: 'b', name: 'B', attended: 5, total: 10 },
    { id: 'c', name: 'C', attended: 0, total: 0 }
  ], 75);
  assert.deepEqual(rows.map((r) => r.id), ['b', 'a']);
});
