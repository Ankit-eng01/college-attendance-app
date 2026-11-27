'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const calc = require('../calc.js');

const state = {
  subjects: [
    { id: 'math', name: 'Mathematics', category: 'theory', attended: 20, total: 30, target: 75 },
    { id: 'mal', name: 'MAL, Lab "A"', category: 'lab', attended: 15, total: 20, target: 80 }
  ],
  history: [
    { id: 'h1', subId: 'math', date: '2026-11-23', status: 'present', timestamp: 1 },
    { id: 'h2', subId: 'math', date: '2026-11-24', status: 'absent', timestamp: 2 },
    { id: 'h3', subId: 'mal', date: '2026-11-25', status: 'present', timestamp: 3 },
    { id: 'h4', subId: 'mal', date: '2026-11-25', status: 'present', timestamp: 4 },
    { id: 'h5', subId: 'math', date: '2026-11-30', status: 'absent', timestamp: 5 },
    { id: 'h6', subId: 'math', date: '2025-01-05', status: 'present', timestamp: 6 },
    { id: 'h7', subId: 'math', date: '2026-11-26', status: 'off', timestamp: 7 }
  ],
  calendar: {
    '2026-11-23': { isHoliday: false, entries: { math: 'present' } },
    '2026-11-27': { isHoliday: false, entries: { mal: 'absent' } }
  }
};

test('report windows use Monday weeks, calendar months and real semester halves', () => {
  const now = new Date(2026, 10, 27, 12, 0); // Friday 27 Nov 2026
  const week = calc.reportWindow('week', now);
  assert.equal(week.from, '2026-11-23');
  assert.equal(week.to, '2026-11-29');

  const month = calc.reportWindow('month', now);
  assert.equal(month.from, '2026-11-01');
  assert.equal(month.to, '2026-11-30');

  const semester = calc.reportWindow('semester', now);
  assert.equal(semester.from, '2026-07-01');
  assert.equal(semester.to, '2026-12-31');
  assert.match(semester.label, /Semester 2 2026/);

  const firstHalf = calc.reportWindow('semester', new Date(2026, 1, 10));
  assert.equal(firstHalf.from, '2026-01-01');
  assert.equal(firstHalf.to, '2026-06-30');

  const custom = calc.reportWindow('custom', now, { from: '2026-11-30', to: '2026-11-20' });
  assert.equal(custom.from, '2026-11-20');
  assert.equal(custom.to, '2026-11-30');
});

test('range report counts only recorded classes inside the window', () => {
  const report = calc.rangeReport(state, '2026-11-23', '2026-11-29', 75);
  // math present+absent, mal present+absent; duplicate history/calendar ignored.
  assert.equal(report.present, 2);
  assert.equal(report.absent, 2);
  assert.equal(report.total, 4);
  assert.equal(report.activeDays, 4);
  assert.equal(report.pctNum, 50);
  assert.equal(report.percentage, '50.0');
  assert.equal(report.subjects.length, 2);
  assert.deepEqual(report.subjects.map((r) => r.id), ['math', 'mal']);
  assert.equal(report.subjects[0].present, 1);
  assert.equal(report.subjects[0].absent, 1);
  assert.equal(report.subjects[0].target, 75);
  assert.equal(report.subjects[1].target, 80);
  // "off" is acknowledged but never counted as a class.
  assert.equal(report.total, calc.ledgerSummary(state, '2026-11-23', '2026-11-29').total);
  assert.equal(calc.buildDailyLedger(state)['2026-11-26'], undefined);
});

test('range report boundary dates are inclusive and older records are excluded', () => {
  const exact = calc.rangeReport(state, '2026-11-25', '2026-11-25', 75);
  assert.equal(exact.total, 1, 'duplicate mal entries on the same date count once');
  assert.equal(exact.present, 1);

  const older = calc.rangeReport(state, '2025-01-01', '2025-01-31', 75);
  assert.equal(older.total, 1);
  assert.equal(older.present, 1);
  assert.equal(older.subjects[0].name, 'Mathematics');
});

test('missing data produces an explicit empty report, never invented numbers', () => {
  const report = calc.rangeReport({ subjects: state.subjects, history: [], calendar: {} }, '2026-11-01', '2026-11-30', 75);
  assert.equal(report.hasData, false);
  assert.equal(report.total, 0);
  assert.equal(report.pctNum, null);
  assert.equal(report.percentage, '--');
  assert.deepEqual(report.subjects, []);
  const insights = calc.reportInsights(report, 75);
  assert.equal(insights.length, 1);
  assert.equal(insights[0].kind, 'empty');
});

test('insights derive from raw report values and flag real absence streaks', () => {
  const report = calc.rangeReport(state, '2026-11-23', '2026-11-30', 75);
  // 2 present / 5 classes = 40%; one absence on 24th and one on 30th (not consecutive).
  assert.equal(report.pctNum, 40);
  assert.equal(report.longestAbsentStreak, 1);
  const insights = calc.reportInsights(report, 75);
  assert.ok(insights.some((i) => i.kind === 'target' && i.tone === 'danger'));
  assert.ok(insights.some((i) => i.kind === 'weakest'));
  assert.ok(!insights.some((i) => i.kind === 'streak'));

  const streakState = {
    subjects: [{ id: 'a', name: 'A', attended: 0, total: 3, target: 75 }],
    history: [
      { subId: 'a', date: '2026-11-23', status: 'absent' },
      { subId: 'a', date: '2026-11-24', status: 'absent' },
      { subId: 'a', date: '2026-11-25', status: 'absent' }
    ],
    calendar: {}
  };
  const streakReport = calc.rangeReport(streakState, '2026-11-23', '2026-11-25', 75);
  assert.equal(streakReport.longestAbsentStreak, 3);
  assert.ok(calc.reportInsights(streakReport, 75).some((i) => i.kind === 'streak'));
});

test('CSV report quotes hostile names and includes a real total row', () => {
  const report = calc.rangeReport(state, '2026-11-23', '2026-11-29', 75);
  const csv = calc.reportToCSV(report);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], 'Subject,Present,Absent,Total,Percentage,Target');
  assert.ok(lines[2].includes('"MAL, Lab ""A"""'), 'commas and quotes are escaped safely');
  assert.equal(lines[3], 'TOTAL,2,2,4,50.0,75%');
  assert.ok(!/<script/i.test(csv));
});

test('weekly and monthly buckets keep empty periods so charts show real gaps', () => {
  const weekly = calc.attendanceBuckets(state, { mode: 'week', count: 4, anchor: '2026-11-27' });
  assert.equal(weekly.length, 4);
  assert.equal(weekly[weekly.length - 1].key, '2026-11-23');
  assert.ok(weekly.some((b) => b.total === 0));

  const monthly = calc.attendanceBuckets(state, { mode: 'month', count: 3, anchor: '2026-11-27' });
  assert.deepEqual(monthly.map((b) => b.key), ['2026-09', '2026-10', '2026-11']);
  assert.equal(monthly[2].total, calc.ledgerSummary(state, '2026-11-01', '2026-11-30').total);
});
