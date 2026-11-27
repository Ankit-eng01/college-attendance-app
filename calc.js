/*
 * Attendify calculation engine (pure, dependency-free, DOM-free).
 *
 * Loaded as a classic script in the browser (window.AttendifyCalc) and
 * required directly by the Node test-suite (module.exports).
 *
 * Every function here is deterministic: no DOM, no localStorage, no fetch.
 * That makes the attendance maths and data-validation rules testable.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AttendifyCalc = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const VERSION = '3.0.0';
  const MAX_CLASSES = 100000;
  const MAX_SUBJECTS = 50;
  const MAX_HISTORY = 5000;
  const VALID_CATEGORIES = ['theory', 'lab', 'elective', 'tutorial', 'other'];
  const VALID_STATUSES = ['present', 'absent', 'off', 'none'];
  const THEME_IDS = ['graphite', 'sapphire', 'obsidian'];
  const LEGACY_THEMES = { 'navy-purple': 'graphite', 'violet': 'sapphire', 'amoled': 'obsidian' };

  // ---------------------------------------------------------------
  // Numbers
  // ---------------------------------------------------------------
  function toNumber(value, fallback) {
    const fb = typeof fallback === 'number' ? fallback : 0;
    if (value === null || value === undefined || value === '') return fb;
    const n = typeof value === 'number' ? value : Number(String(value).replace(/,/g, '').trim());
    return Number.isFinite(n) ? n : fb;
  }

  function clampInt(value, min, max, fallback) {
    const n = Math.trunc(toNumber(value, fallback === undefined ? min : fallback));
    if (!Number.isFinite(n)) return min;
    return Math.min(max, Math.max(min, n));
  }

  function clampTarget(value, fallback) {
    const n = toNumber(value, fallback === undefined ? 75 : fallback);
    if (!Number.isFinite(n)) return 75;
    if (n < 1) return 1;
    if (n > 100) return 100;
    // Targets are whole percentages: the UI only offers integers.
    return Math.round(n);
  }

  function round1(n) {
    return Math.round(n * 10) / 10;
  }

  function percentage(attended, total) {
    const a = Math.max(0, toNumber(attended, 0));
    const t = Math.max(0, toNumber(total, 0));
    if (t <= 0) return null;
    return (a / t) * 100;
  }

  // ---------------------------------------------------------------
  // Core attendance maths
  //
  // A student at a/t who attends x more classes and misses y more ends at
  // (a + x) / (t + x + y). Solving that for the target gives the formulas
  // below; they are exact for non-integer percentages and targets.
  // ---------------------------------------------------------------
  function safeBunks(attended, total, target) {
    const a = Math.max(0, toNumber(attended, 0));
    const t = Math.max(a, toNumber(total, 0));
    const tg = clampTarget(target);
    if (tg <= 0) return 0;
    // Largest total T with a/T >= tg/100  ->  T <= 100a/tg.
    const maxAllowedTotal = Math.floor((100 * a) / tg);
    return Math.max(0, maxAllowedTotal - t);
  }

  /**
   * Consecutive present classes needed to reach `target`.
   * Returns 0 when already at/above target, or null when unreachable
   * (only possible when target is 100 and a class was already missed).
   */
  function classesNeeded(attended, total, target) {
    const a = Math.max(0, toNumber(attended, 0));
    const t = Math.max(a, toNumber(total, 0));
    const tg = clampTarget(target);
    if (t <= 0) return 0;
    if ((a / t) * 100 >= tg) return 0;
    if (tg >= 100) return null;
    const numerator = tg * t - 100 * a;
    const denominator = 100 - tg;
    if (denominator <= 0) return null;
    return Math.max(1, Math.ceil(numerator / denominator));
  }

  function riskLevel(pctNum, target, hasData) {
    if (!hasData || pctNum === null || !Number.isFinite(pctNum)) return 'nodata';
    const tg = clampTarget(target);
    if (pctNum < tg) return 'danger';
    if (pctNum < tg + 5) return 'watch';
    return 'safe';
  }

  function stats(subject, globalTarget) {
    const s = subject || {};
    const attended = Math.max(0, Math.trunc(toNumber(s.attended, 0)));
    let total = Math.max(0, Math.trunc(toNumber(s.total, 0)));
    if (total < attended) total = attended;
    const target = clampTarget(s.target === undefined ? globalTarget : s.target, clampTarget(globalTarget));
    const missed = Math.max(0, total - attended);
    const hasData = total > 0;
    const pctNum = percentage(attended, total);
    const isShort = hasData && pctNum < target;

    const needed = classesNeeded(attended, total, target);
    const bunks = safeBunks(attended, total, target);

    return {
      attended,
      total,
      missed,
      target,
      hasData,
      percentage: hasData ? pctNum.toFixed(1) : '--',
      pctNum: hasData ? pctNum : 0,
      exactPct: hasData ? pctNum : null,
      isShort,
      classesNeeded: needed,
      minNeededToReach75: needed, // legacy field name kept for existing callers
      safeBunks: bunks,
      maxCanMiss: bunks, // legacy field name kept for existing callers
      shortagePct: isShort ? round1(target - pctNum).toFixed(1) : '0.0',
      surplusPct: hasData && !isShort ? round1(pctNum - target).toFixed(1) : '0.0',
      risk: riskLevel(hasData ? pctNum : null, target, hasData),
      status: !hasData ? 'nodata' : (isShort ? 'short' : 'safe')
    };
  }

  /**
   * Projection without touching real records: attending `attend` and
   * missing `miss` future classes.
   */
  function project(subject, scenario, globalTarget) {
    const s = subject || {};
    const sc = scenario || {};
    const attended = Math.max(0, Math.trunc(toNumber(s.attended, 0)));
    const total = Math.max(attended, Math.trunc(toNumber(s.total, 0)));
    const target = clampTarget(s.target === undefined ? globalTarget : s.target, clampTarget(globalTarget));

    const attend = Math.min(MAX_CLASSES, Math.max(0, Math.trunc(toNumber(sc.attend, 0))));
    const miss = Math.min(MAX_CLASSES, Math.max(0, Math.trunc(toNumber(sc.miss, 0))));

    const newAttended = attended + attend;
    const newTotal = total + attend + miss;
    const pctNum = percentage(newAttended, newTotal);
    const current = stats(s, target);

    return {
      attended: newAttended,
      total: newTotal,
      pctNum: pctNum === null ? 0 : pctNum,
      percentage: pctNum === null ? '--' : pctNum.toFixed(1),
      hasData: newTotal > 0,
      meets: pctNum !== null && pctNum >= target,
      delta: pctNum === null ? 0 : pctNum - (current.exactPct || 0),
      target,
      neededAfter: classesNeeded(newAttended, newTotal, target),
      safeBunksAfter: safeBunks(newAttended, newTotal, target),
      risk: riskLevel(pctNum, target, newTotal > 0)
    };
  }

  function aggregate(subjects, globalTarget) {
    const list = Array.isArray(subjects) ? subjects : [];
    const target = clampTarget(globalTarget);
    let attended = 0;
    let conducted = 0;
    let belowTarget = 0;
    let nearTarget = 0;
    let onTrack = 0;

    const rows = list.map((sub) => {
      const st = stats(sub, target);
      attended += st.attended;
      conducted += st.total;
      if (st.hasData) {
        if (st.isShort) belowTarget++;
        else {
          onTrack++;
          if (st.risk === 'watch') nearTarget++;
        }
      }
      return Object.assign({ id: sub && sub.id, name: (sub && sub.name) || '', category: (sub && sub.category) || 'theory' }, st);
    });

    const pctNum = percentage(attended, conducted);
    return {
      subjects: list.length,
      attended,
      conducted,
      missed: Math.max(0, conducted - attended),
      hasData: conducted > 0,
      pctNum: pctNum === null ? null : pctNum,
      percentage: pctNum === null ? '--' : pctNum.toFixed(1),
      target,
      belowTarget,
      nearTarget,
      onTrack,
      // Only subjects strictly below target count as at risk; above-target
      // subjects are tracked separately in nearTarget / onTrack.
      atRisk: belowTarget,
      safeBunks: safeBunks(attended, conducted, target),
      classesNeeded: classesNeeded(attended, conducted, target),
      risk: riskLevel(pctNum, target, conducted > 0),
      rows
    };
  }

  // ---------------------------------------------------------------
  // Dates — always local-time, never Date.parse('YYYY-MM-DD') (UTC bug)
  // ---------------------------------------------------------------
  const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function formatISO(date) {
    const d = date instanceof Date ? date : new Date(date);
    if (isNaN(d.getTime())) return '';
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }

  function todayISO(now) {
    return formatISO(now instanceof Date ? now : new Date());
  }

  function parseISODate(value) {
    if (typeof value !== 'string') return null;
    const m = ISO_RE.exec(value.trim());
    if (!m) return null;
    const year = Number(m[1]);
    const month = Number(m[2]);
    const day = Number(m[3]);
    if (year < 1900 || year > 2200 || month < 1 || month > 12 || day < 1 || day > 31) return null;
    const d = new Date(year, month - 1, day);
    if (d.getFullYear() !== year || d.getMonth() !== month - 1 || d.getDate() !== day) return null;
    return d;
  }

  function isValidISODate(value) {
    return parseISODate(value) !== null;
  }

  function addDaysISO(iso, days) {
    const d = parseISODate(iso);
    if (!d) return '';
    d.setDate(d.getDate() + Math.trunc(toNumber(days, 0)));
    return formatISO(d);
  }

  // Monday-based week start (ISO 8601) computed in local time.
  function startOfWeekISO(iso) {
    const d = parseISODate(iso);
    if (!d) return '';
    const offset = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - offset);
    return formatISO(d);
  }

  function monthKey(iso) {
    return typeof iso === 'string' && iso.length >= 7 ? iso.slice(0, 7) : '';
  }

  function shortDateLabel(iso) {
    const d = parseISODate(iso);
    if (!d) return iso || '';
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  function monthLabel(key) {
    const parts = String(key || '').split('-');
    if (parts.length !== 2) return String(key || '');
    const d = new Date(Number(parts[0]), Number(parts[1]) - 1, 1);
    if (isNaN(d.getTime())) return String(key || '');
    return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
  }

  function dayName(dayIndex) {
    return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
      clampInt(dayIndex, 0, 6, 0)
    ];
  }

  function timeToMinutes(value) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(value || '').trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h < 0 || h > 23 || min < 0 || min > 59) return null;
    return h * 60 + min;
  }

  function normalizeTime(value) {
    const mins = timeToMinutes(value);
    if (mins === null) return '';
    return `${pad2(Math.floor(mins / 60))}:${pad2(mins % 60)}`;
  }

  function formatTime12(value) {
    const mins = timeToMinutes(value);
    if (mins === null) return '';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    const suffix = h < 12 ? 'AM' : 'PM';
    const hour12 = h % 12 === 0 ? 12 : h % 12;
    return `${hour12}:${pad2(m)} ${suffix}`;
  }

  // ---------------------------------------------------------------
  // Attendance log handling (history + calendar produce one daily ledger)
  // ---------------------------------------------------------------
  function buildDailyLedger(state) {
    const ledger = {}; // date -> { present, absent, entries: {subId: status} }
    const st = state || {};
    const calendar = st.calendar && typeof st.calendar === 'object' ? st.calendar : {};
    const holidayDates = new Set();
    const offPairs = new Set();

    Object.keys(calendar).forEach((date) => {
      const day = calendar[date];
      if (!day || !isValidISODate(date)) return;
      if (day.isHoliday) holidayDates.add(date);
      if (day.entries && typeof day.entries === 'object') {
        Object.keys(day.entries).forEach((subId) => {
          if (day.entries[subId] === 'off') offPairs.add(`${date}:${subId}`);
        });
      }
    });

    const ensure = (date) => {
      if (!ledger[date]) ledger[date] = { present: 0, absent: 0, entries: {} };
      return ledger[date];
    };

    (Array.isArray(st.history) ? st.history : []).forEach((h) => {
      if (!h || !isValidISODate(h.date) || holidayDates.has(h.date)) return;
      if (h.status !== 'present' && h.status !== 'absent') return;
      const subId = String(h.subId || '');
      if (subId && offPairs.has(`${h.date}:${subId}`)) return;
      const bucket = ensure(h.date);
      if (subId && bucket.entries[subId]) return; // duplicate entry: keep the first
      if (subId) bucket.entries[subId] = h.status;
      if (h.status === 'present') bucket.present++;
      else bucket.absent++;
    });

    Object.keys(calendar).forEach((date) => {
      if (holidayDates.has(date)) return;
      const day = calendar[date];
      if (!day || !isValidISODate(date) || !day.entries) return;
      Object.keys(day.entries).forEach((subId) => {
        const status = day.entries[subId];
        if (status !== 'present' && status !== 'absent') return;
        const bucket = ensure(date);
        if (bucket.entries[subId]) return; // history already counted this class
        bucket.entries[subId] = status;
        if (status === 'present') bucket.present++;
        else bucket.absent++;
      });
    });

    return ledger;
  }

  function ledgerSummary(state, fromISO, toISO) {
    const ledger = buildDailyLedger(state);
    let present = 0;
    let absent = 0;
    Object.keys(ledger).forEach((date) => {
      if (fromISO && date < fromISO) return;
      if (toISO && date > toISO) return;
      present += ledger[date].present;
      absent += ledger[date].absent;
    });
    const total = present + absent;
    return {
      present,
      absent,
      total,
      pctNum: total > 0 ? (present / total) * 100 : null
    };
  }

  /**
   * Buckets attendance into the last `count` ISO weeks or calendar months.
   * Weeks/months with no classes are kept so charts show real gaps.
   */
  function attendanceBuckets(state, options) {
    const opts = options || {};
    const mode = opts.mode === 'month' ? 'month' : 'week';
    const count = clampInt(opts.count, 1, 52, mode === 'week' ? 8 : 6);
    const anchor = isValidISODate(opts.anchor) ? opts.anchor : todayISO();
    const ledger = buildDailyLedger(state);
    const buckets = [];

    if (mode === 'week') {
      const thisWeek = startOfWeekISO(anchor);
      for (let i = count - 1; i >= 0; i--) {
        const start = addDaysISO(thisWeek, -7 * i);
        buckets.push({
          key: start,
          label: shortDateLabel(start),
          present: 0,
          absent: 0,
          total: 0,
          pctNum: null
        });
      }
      const byKey = {};
      buckets.forEach((b) => { byKey[b.key] = b; });
      Object.keys(ledger).forEach((date) => {
        const key = startOfWeekISO(date);
        const bucket = byKey[key];
        if (!bucket) return;
        bucket.present += ledger[date].present;
        bucket.absent += ledger[date].absent;
      });
    } else {
      const parts = monthKey(anchor).split('-');
      let year = Number(parts[0]);
      let month = Number(parts[1]) - 1;
      for (let i = 0; i < count; i++) {
        const d = new Date(year, month - i, 1);
        buckets.unshift({
          key: `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`,
          label: monthLabel(`${d.getFullYear()}-${pad2(d.getMonth() + 1)}`),
          present: 0,
          absent: 0,
          total: 0,
          pctNum: null
        });
      }
      const byKey = {};
      buckets.forEach((b) => { byKey[b.key] = b; });
      Object.keys(ledger).forEach((date) => {
        const bucket = byKey[monthKey(date)];
        if (!bucket) return;
        bucket.present += ledger[date].present;
        bucket.absent += ledger[date].absent;
      });
    }

    buckets.forEach((b) => {
      b.total = b.present + b.absent;
      b.pctNum = b.total > 0 ? (b.present / b.total) * 100 : null;
    });
    return buckets;
  }

  /**
   * Compare the most recent `windowSize` buckets with the ones before them.
   * Returns { direction: 'up'|'down'|'flat'|'unknown', delta }.
   */
  function trend(buckets, windowSize) {
    const list = (Array.isArray(buckets) ? buckets : []).filter((b) => b && b.total > 0);
    const requested = clampInt(windowSize, 1, 12, 4);
    if (list.length < 2) {
      return {
        direction: 'unknown', delta: 0, current: null, previous: null,
        window: 0, activeWeeks: list.length, recentTotal: 0, previousTotal: 0
      };
    }
    const size = Math.min(requested, Math.floor(list.length / 2));
    const recent = list.slice(-size);
    const earlier = list.slice(-2 * size, -size);
    if (!recent.length || !earlier.length) {
      return {
        direction: 'unknown', delta: 0, current: null, previous: null,
        window: 0, activeWeeks: list.length, recentTotal: 0, previousTotal: 0
      };
    }
    const sumTotal = (rows) => rows.reduce((sum, b) => sum + b.total, 0);
    const avg = (rows) => {
      const tot = sumTotal(rows);
      if (tot <= 0) return 0;
      const weighted = rows.reduce((sum, b) => {
        const p = typeof b.present === 'number' ? b.present * 100 : b.pctNum * b.total;
        return sum + p;
      }, 0);
      return weighted / tot;
    };
    const current = avg(recent);
    const previous = avg(earlier);
    const delta = current - previous;
    return {
      direction: delta > 0.5 ? 'up' : delta < -0.5 ? 'down' : 'flat',
      delta,
      current,
      previous,
      window: size,
      activeWeeks: list.length,
      recentTotal: sumTotal(recent),
      previousTotal: sumTotal(earlier)
    };
  }

  function subjectComparison(subjects, globalTarget) {
    return aggregate(subjects, globalTarget).rows
      .filter((row) => row.hasData)
      .sort((a, b) => a.pctNum - b.pctNum);
  }

  function recentActivity(state, limit) {
    const st = state || {};
    const names = {};
    (Array.isArray(st.subjects) ? st.subjects : []).forEach((s) => {
      if (s && s.id) names[s.id] = s.name || 'Subject';
    });
    const rows = (Array.isArray(st.history) ? st.history : [])
      .filter((h) => h && isValidISODate(h.date) && (h.status === 'present' || h.status === 'absent'))
      .slice()
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(0, clampInt(limit, 1, 50, 6))
      .map((h) => ({
        id: h.id,
        subId: h.subId,
        subject: names[h.subId] || 'Deleted subject',
        date: h.date,
        status: h.status,
        timestamp: h.timestamp || 0,
        label: h.status === 'present' ? 'Present' : 'Absent'
      }));

    if (rows.length) return rows;

    // Fallback for imports that only contain calendar data.
    const ledger = buildDailyLedger(st);
    const out = [];
    Object.keys(ledger)
      .sort()
      .reverse()
      .forEach((date) => {
        Object.keys(ledger[date].entries).forEach((subId) => {
          out.push({
            id: `${date}_${subId}`,
            subId,
            subject: names[subId] || 'Deleted subject',
            date,
            status: ledger[date].entries[subId],
            timestamp: parseISODate(date) ? parseISODate(date).getTime() : 0,
            label: ledger[date].entries[subId] === 'present' ? 'Present' : 'Absent'
          });
        });
      });
    return out.slice(0, clampInt(limit, 1, 50, 6));
  }

  // ---------------------------------------------------------------
  // Advanced analytics: real-date windows, range reports and insights
  // ---------------------------------------------------------------
  /** Resolve a named or custom reporting window. All dates are local ISO strings. */
  function reportWindow(preset, now, custom) {
    const current = now instanceof Date ? now : new Date();
    const anchor = todayISO(current);
    const c = custom || {};
    let from = '';
    let to = '';
    let label = '';

    if (preset === 'week') {
      from = startOfWeekISO(anchor);
      to = addDaysISO(from, 6);
      label = `Week of ${shortDateLabel(from)}`;
    } else if (preset === 'month') {
      from = `${monthKey(anchor)}-01`;
      const [year, month] = monthKey(anchor).split('-').map(Number);
      to = formatISO(new Date(year, month, 0));
      label = monthLabel(monthKey(anchor));
    } else if (preset === 'semester') {
      const year = current.getFullYear();
      const firstHalf = current.getMonth() < 6;
      from = `${year}-${firstHalf ? '01' : '07'}-01`;
      to = `${year}-${firstHalf ? '06' : '12'}-${firstHalf ? '30' : '31'}`;
      label = `Semester ${firstHalf ? '1' : '2'} ${year}`;
    } else {
      from = isValidISODate(c.from) ? c.from : anchor;
      to = isValidISODate(c.to) ? c.to : anchor;
      if (from > to) {
        const swap = from;
        from = to;
        to = swap;
      }
      label = `${shortDateLabel(from)} – ${shortDateLabel(to)}`;
    }
    return { from, to, label, preset: preset === 'custom' ? 'custom' : preset };
  }

  /**
   * Aggregate only the classes actually recorded inside [from, to].
   * "off" and timetable metadata never contribute to these numbers.
   */
  function rangeReport(state, from, to, globalTarget) {
    const st = state || {};
    const ledger = buildDailyLedger(st);
    const names = {};
    const targets = {};
    (Array.isArray(st.subjects) ? st.subjects : []).forEach((s) => {
      if (!s || !s.id) return;
      names[s.id] = cleanText(s.name, 80) || 'Subject';
      targets[s.id] = clampTarget(s.target, clampTarget(globalTarget));
    });

    const perSubject = {};
    let present = 0;
    let absent = 0;
    let activeDays = 0;
    let streak = 0;
    let longestAbsentStreak = 0;
    let previousAbsentDate = '';
    const dates = Object.keys(ledger).sort();

    dates.forEach((date) => {
      if (from && date < from) return;
      if (to && date > to) return;
      const day = ledger[date];
      present += day.present;
      absent += day.absent;
      if (day.present + day.absent > 0) activeDays++;
      if (day.absent > 0) {
        // Only consecutive calendar days count; gaps in the ledger break the run.
        streak = previousAbsentDate && addDaysISO(previousAbsentDate, 1) === date ? streak + 1 : 1;
        previousAbsentDate = date;
        longestAbsentStreak = Math.max(longestAbsentStreak, streak);
      } else {
        streak = 0;
        previousAbsentDate = '';
      }
      Object.keys(day.entries).forEach((subId) => {
        if (!perSubject[subId]) perSubject[subId] = { present: 0, absent: 0 };
        if (day.entries[subId] === 'present') perSubject[subId].present++;
        else perSubject[subId].absent++;
      });
    });

    const target = clampTarget(globalTarget);
    const subjects = Object.keys(perSubject).map((subId) => {
      const p = perSubject[subId].present;
      const a = perSubject[subId].absent;
      const total = p + a;
      const pctNum = percentage(p, total);
      const subTarget = targets[subId] === undefined ? target : targets[subId];
      return {
        id: subId,
        name: names[subId] || 'Deleted subject',
        present: p,
        absent: a,
        total,
        pctNum,
        percentage: pctNum === null ? '--' : pctNum.toFixed(1),
        target: subTarget,
        isShort: total > 0 && pctNum < subTarget,
        classesNeeded: total > 0 && pctNum < subTarget ? classesNeeded(p, total, subTarget) : 0,
        safeBunks: total > 0 && pctNum >= subTarget ? safeBunks(p, total, subTarget) : 0
      };
    }).sort((a, b) => a.pctNum - b.pctNum);

    const total = present + absent;
    const pctNum = percentage(present, total);
    return {
      from: from || '',
      to: to || '',
      present,
      absent,
      total,
      pctNum,
      percentage: pctNum === null ? '--' : pctNum.toFixed(1),
      hasData: total > 0,
      activeDays,
      longestAbsentStreak,
      target,
      subjects
    };
  }

  /** Plain-text insights derived exclusively from the supplied report. */
  function reportInsights(report, globalTarget) {
    const r = report || {};
    if (!r.hasData) {
      return [{
        kind: 'empty',
        tone: 'neutral',
        title: 'No classes recorded in this period',
        detail: 'Choose another date range or mark attendance in the calendar. Nothing is estimated.'
      }];
    }
    const target = clampTarget(globalTarget === undefined ? r.target : globalTarget);
    const out = [];
    const rows = r.subjects || [];
    if (rows.length) {
      const worst = rows[0];
      const best = rows[rows.length - 1];
      out.push({
        kind: 'weakest',
        tone: worst.isShort ? 'danger' : 'neutral',
        title: `Lowest: ${worst.name} · ${worst.percentage}%`,
        detail: worst.isShort
          ? `${worst.absent} missed of ${worst.total}; needs ${worst.classesNeeded} more present class${worst.classesNeeded === 1 ? '' : 'es'} to reach ${worst.target}%.`
          : `${worst.present}/${worst.total} attended, above its ${worst.target}% target.`
      });
      if (rows.length > 1) {
        out.push({
          kind: 'best',
          tone: 'success',
          title: `Highest: ${best.name} · ${best.percentage}%`,
          detail: `${best.present}/${best.total} attended in this period.`
        });
      }
    }
    if (r.pctNum !== null && r.pctNum < target) {
      const needed = classesNeeded(r.present, r.total, target);
      out.push({
        kind: 'target',
        tone: 'danger',
        title: `Overall ${r.percentage}% is below ${target}%`,
        detail: `${r.absent} classes missed. Attend the next ${needed} class${needed === 1 ? '' : 'es'} in this period to reach the target.`
      });
    } else {
      out.push({
        kind: 'target',
        tone: 'success',
        title: `Overall ${r.percentage}% meets ${target}%`,
        detail: `${safeBunks(r.present, r.total, target)} further classes could be missed while staying on track.`
      });
    }
    if (r.longestAbsentStreak >= 2) {
      out.push({
        kind: 'streak',
        tone: 'warning',
        title: `${r.longestAbsentStreak} consecutive days with absences`,
        detail: 'Check the calendar for those dates before planning the next week.'
      });
    }
    return out;
  }

  /** CSV for a real range report. No placeholder or derived sample rows. */
  function reportToCSV(report) {
    const r = report || {};
    const quote = (value) => {
      const text = String(value === null || value === undefined ? '' : value);
      return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    const rows = [
      ['Subject', 'Present', 'Absent', 'Total', 'Percentage', 'Target'],
      ...(Array.isArray(r.subjects) ? r.subjects : []).map((s) => [
        s.name, s.present, s.absent, s.total, s.percentage, `${s.target}%`
      ]),
      ['TOTAL', r.present || 0, r.absent || 0, r.total || 0, r.percentage || '--', `${r.target || 75}%`]
    ];
    return rows.map((row) => row.map(quote).join(',')).join('\r\n');
  }

  // ---------------------------------------------------------------
  // Timetable helpers
  // ---------------------------------------------------------------
  const VALID_CLASS_TYPES = ['theory', 'lab', 'tutorial', 'other'];
  const VALID_RECURRENCE = ['weekly', 'once'];

  function normalizeTimetableEntry(raw, subjects) {
    if (!raw || typeof raw !== 'object') return null;
    const start = normalizeTime(raw.start);
    const end = normalizeTime(raw.end);
    if (!start) return null;
    const startMins = timeToMinutes(start);
    const endMins = end ? timeToMinutes(end) : null;
    if (endMins !== null && endMins <= startMins) return null;

    const recurrence = VALID_RECURRENCE.includes(raw.recurrence) ? raw.recurrence : 'weekly';
    const date = isValidISODate(raw.date) ? raw.date : '';
    let day = clampInt(raw.day, 0, 6, 0);
    if (recurrence === 'once' && date) {
      const parsedDate = parseISODate(date);
      if (!parsedDate) return null;
      day = parsedDate.getDay();
    }

    const subjectId = safeId(raw.subjectId, '');
    const known = Array.isArray(subjects) ? subjects.find((s) => s && s.id === subjectId) : null;
    let subjectName = cleanText(raw.subjectName, 80);
    if (known) subjectName = known.name;
    if (!subjectName && !known) return null;

    const classType = VALID_CLASS_TYPES.includes(String(raw.classType || '').toLowerCase())
      ? String(raw.classType).toLowerCase()
      : 'theory';

    return {
      id: safeId(raw.id, 'tt_' + Date.now() + '_' + Math.floor(Math.random() * 1e6)),
      day,
      subjectId: known ? known.id : '',
      subjectName: subjectName || 'Class',
      start,
      end: end || '',
      room: cleanText(raw.room, 40),
      faculty: cleanText(raw.faculty, 60),
      classType,
      notes: cleanText(raw.notes, 200),
      recurrence,
      date: recurrence === 'once' ? date : '',
      cancelled: Boolean(raw.cancelled),
      holiday: Boolean(raw.holiday),
      // Overlaps are only allowed after the user explicitly accepts a warning.
      allowOverlap: Boolean(raw.allowOverlap)
    };
  }

  function timetableForDay(timetable, dayIndex) {
    return (Array.isArray(timetable) ? timetable : [])
      .filter((e) => e && Number(e.day) === Number(dayIndex))
      .sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
  }

  function timetableOccurrenceKey(entry, isoDate) {
    return `${entry && entry.id || 'unknown'}|${isoDate || ''}`;
  }

  function entryEndMinutes(entry) {
    const start = timeToMinutes(entry && entry.start);
    if (start === null) return null;
    return entry && entry.end ? (timeToMinutes(entry.end) || start + 45) : start + 45;
  }

  function timetableOverlap(a, b) {
    if (!a || !b || Number(a.day) !== Number(b.day)) return false;
    if (a.cancelled || b.cancelled || a.holiday || b.holiday) return false;
    if (a.recurrence === 'once' && a.date && b.recurrence === 'once' && b.date && a.date !== b.date) return false;
    const aStart = timeToMinutes(a.start);
    const bStart = timeToMinutes(b.start);
    const aEnd = entryEndMinutes(a);
    const bEnd = entryEndMinutes(b);
    if (aStart === null || bStart === null || aEnd === null || bEnd === null) return false;
    return aStart < bEnd && bStart < aEnd;
  }

  function timetableConflicts(timetable) {
    const list = Array.isArray(timetable) ? timetable : [];
    const conflicts = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        if (timetableOverlap(list[i], list[j])) conflicts.push([list[i], list[j]]);
      }
    }
    return conflicts;
  }

  /** Daily schedule state built from real attendance records — never inferred. */
  function timetableStats(timetable, state, now) {
    const current = now instanceof Date ? now : new Date();
    const iso = todayISO(current);
    const day = current.getDay();
    const minutes = current.getHours() * 60 + current.getMinutes();
    const ledger = buildDailyLedger(state || {});
    // buildDailyLedger deliberately tracks only present/absent. Include "off"
    // records from the calendar so a cancelled class is visibly acknowledged.
    const logged = Object.assign({}, (ledger[iso] && ledger[iso].entries) || {});
    const st = state || {};
    const calEntries = (st.calendar && st.calendar[iso] && st.calendar[iso].entries) || {};
    Object.keys(calEntries).forEach((subId) => {
      if (calEntries[subId] === 'off' && !logged[subId]) logged[subId] = 'off';
    });

    const rows = timetableForDay(timetable, day)
      .filter((e) => !e.cancelled && !e.holiday && (e.recurrence !== 'once' || !e.date || e.date === iso))
      .map((e) => {
        const startMins = timeToMinutes(e.start);
        const endMins = entryEndMinutes(e);
        const status = e.subjectId ? logged[e.subjectId] : '';
        return Object.assign({}, e, {
          status: status || 'none',
          isNow: startMins <= minutes && minutes < endMins,
          isPast: endMins !== null && endMins <= minutes,
          minutesUntil: startMins - minutes
        });
      });

    // Attendance is stored once per subject per date. When a subject appears in
    // multiple slots on the same day, all its rows share that one real record;
    // counting rows would overstate the number of recorded classes.
    const rowKey = (row) => row.subjectId || `name:${row.subjectName}`;
    const tracked = new Set(rows.map(rowKey));
    const recorded = new Set(rows.filter((row) => row.status !== 'none').map(rowKey));
    const completed = recorded.size;
    const upcoming = tracked.size - completed;
    const currentClass = rows.find((row) => row.isNow) || null;
    const nextClass = rows
      .filter((row) => row.minutesUntil > 0)
      .sort((a, b) => a.minutesUntil - b.minutesUntil)[0] || null;

    return {
      date: iso,
      day,
      total: tracked.size,
      slots: rows.length,
      completed,
      upcoming,
      currentClass,
      nextClass,
      rows
    };
  }

  /** Today's/upcoming classes with a "starts in" hint, computed in local time. */
  function upcomingClasses(timetable, now) {
    const current = now instanceof Date ? now : new Date();
    const today = current.getDay();
    const minutes = current.getHours() * 60 + current.getMinutes();
    const entries = Array.isArray(timetable) ? timetable : [];
    const todayList = timetableForDay(entries, today)
      .filter((e) => !e.cancelled && !e.holiday)
      .map((e) => {
        const startMins = timeToMinutes(e.start);
        const endMins = entryEndMinutes(e);
        return Object.assign({}, e, {
          dayLabel: 'Today',
          isNow: startMins <= minutes && minutes < endMins,
          isPast: endMins !== null && endMins <= minutes,
          minutesUntil: startMins - minutes
        });
      });

    const upcomingToday = todayList.filter((e) => !e.isPast);
    const later = [];
    for (let offset = 1; offset <= 7 && upcomingToday.length + later.length < 6; offset++) {
      const day = (today + offset) % 7;
      timetableForDay(entries, day)
        .filter((e) => !e.cancelled && !e.holiday)
        .forEach((e) => {
          later.push(Object.assign({}, e, { dayLabel: offset === 1 ? 'Tomorrow' : dayName(day), isNow: false, isPast: false, minutesUntil: null }));
        });
    }
    return { today: todayList, upcoming: upcomingToday.concat(later).slice(0, 6) };
  }

  // ---------------------------------------------------------------
  // Text + data validation
  // ---------------------------------------------------------------
  function cleanText(value, maxLength) {
    if (value === null || value === undefined) return '';
    return String(value)
      // Drop scripting elements together with their content before stripping tags.
      .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
      .replace(/<[^>]*>?/gm, '')
      .replace(/[\u0000-\u001F\u007F]/g, ' ')
      .trim()
      .slice(0, maxLength || 120);
  }

  function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function safeId(value, fallback) {
    const str = typeof value === 'string' ? value.trim() : '';
    if (/^[A-Za-z0-9_-]{1,64}$/.test(str)) return str;
    return fallback;
  }

  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const SYNC_CODE_RE = /^[A-Za-z0-9_-]{6,64}$/;
  const AUTH_KEY_RE = /^[A-Za-z0-9_-]{16,128}$/;

  const VALID_NOTIF_CATEGORIES = ['belowTarget', 'danger', 'classReminder', 'weekly', 'milestones', 'system'];

  function sanitizeNotifPrefs(raw) {
    const p = raw && typeof raw === 'object' ? raw : {};
    const categories = p.categories && typeof p.categories === 'object' ? p.categories : {};
    const categoryPrefs = {};
    VALID_NOTIF_CATEGORIES.forEach((key) => {
      const legacy = p[key];
      categoryPrefs[key] = categories[key] !== undefined ? categories[key] !== false : legacy !== false;
    });
    const q = p.quietHours && typeof p.quietHours === 'object' ? p.quietHours : {};
    return {
      enabled: p.enabled !== false,
      // Legacy flat keys remain so older backups and existing UI keep working.
      belowTarget: categoryPrefs.belowTarget,
      danger: categoryPrefs.danger,
      classReminder: categoryPrefs.classReminder,
      weekly: categoryPrefs.weekly,
      milestones: categoryPrefs.milestones,
      categories: categoryPrefs,
      quietHoursEnabled: p.quietHoursEnabled !== undefined ? Boolean(p.quietHoursEnabled) : Boolean(q.enabled),
      quietStart: normalizeTime(q.start || p.quietStart) || '22:00',
      quietEnd: normalizeTime(q.end || p.quietEnd) || '07:00',
      reminderLeadMinutes: clampInt(p.reminderLeadMinutes, 5, 240, 30),
      maxHistory: clampInt(p.maxHistory, 20, 200, 80),
      permissionDenied: Boolean(p.permissionDenied),
      lastWeeklyISO: typeof p.lastWeeklyISO === 'string' && isValidISODate(p.lastWeeklyISO) ? p.lastWeeklyISO : '',
      lastMilestone: clampInt(p.lastMilestone, 0, 100, 0)
    };
  }

  function notificationId(key) {
    let hash = 5381;
    const text = String(key || '');
    for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
    return 'n_' + (hash >>> 0).toString(36);
  }

  function sanitizeNotification(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const key = cleanText(raw.key, 160);
    if (!key) return null;
    const title = cleanText(raw.title, 100) || 'Attendify';
    const body = cleanText(raw.body, 240);
    if (!body) return null;
    return {
      id: safeId(raw.id, notificationId(key)),
      key,
      category: VALID_NOTIF_CATEGORIES.includes(raw.category) ? raw.category : 'system',
      title,
      body,
      subjectId: safeId(raw.subjectId, ''),
      timestamp: toNumber(raw.timestamp, Date.now()) || Date.now(),
      read: Boolean(raw.read)
    };
  }

  function sanitizeNotifications(raw, prefs) {
    const limit = sanitizeNotifPrefs(prefs).maxHistory;
    const seen = new Set();
    const rows = [];
    (Array.isArray(raw) ? raw : []).slice(0, limit * 2).forEach((item) => {
      const clean = sanitizeNotification(item);
      if (!clean || seen.has(clean.key)) return;
      seen.add(clean.key);
      rows.push(clean);
    });
    return rows.sort((a, b) => b.timestamp - a.timestamp).slice(0, limit);
  }

  /** True only during the configured local quiet-hours window. */
  function isQuietHour(prefs, now) {
    const p = sanitizeNotifPrefs(prefs);
    if (!p.quietHoursEnabled) return false;
    const current = now instanceof Date ? now : new Date();
    const at = current.getHours() * 60 + current.getMinutes();
    const start = timeToMinutes(p.quietStart);
    const end = timeToMinutes(p.quietEnd);
    if (start === null || end === null || start === end) return false;
    return start < end ? (at >= start && at < end) : (at >= start || at < end);
  }

  /** Class reminders use the configured lead time and never look into the past. */
  function isWithinReminderLead(entry, prefs, now) {
    const start = timeToMinutes(entry && entry.start);
    if (start === null) return false;
    const current = now instanceof Date ? now : new Date();
    const minutesUntil = start - (current.getHours() * 60 + current.getMinutes());
    const lead = sanitizeNotifPrefs(prefs).reminderLeadMinutes;
    return minutesUntil >= 0 && minutesUntil <= lead;
  }

  /**
   * Build notification records from real subject/timetable/history state.
   * `existingKeys` makes repeat checks idempotent. Pref updates (weekly and
   * milestone markers) are returned for the caller to persist.
   */
  function buildNotificationCandidates(state, now, prefs, existingKeys) {
    const st = state || {};
    const p = sanitizeNotifPrefs(prefs);
    const current = now instanceof Date ? now : new Date();
    const iso = todayISO(current);
    const seen = new Set(Array.isArray(existingKeys) ? existingKeys : []);
    const candidates = [];
    const prefUpdates = {};
    const tg = clampTarget(st.globalTarget, 75);
    const add = (candidate) => {
      if (seen.has(candidate.key)) return;
      seen.add(candidate.key);
      candidates.push(Object.assign({ timestamp: current.getTime(), read: false }, candidate));
    };

    if (p.enabled === false) return { candidates, prefUpdates };

    if (p.categories.belowTarget) {
      (Array.isArray(st.subjects) ? st.subjects : []).forEach((sub) => {
        if (!sub) return;
        const s = stats(sub, tg);
        if (!s.hasData || !s.isShort) return;
        add({
          key: `below:${sub.id}:${s.total}:${s.percentage}`,
          category: 'belowTarget',
          subjectId: sub.id || '',
          title: 'Attendance below target',
          body: `${s.name || sub.name || 'Subject'} is at ${s.percentage}% — attend ${s.classesNeeded} more in a row to reach ${s.target}%.`
        });
      });
    }

    if (p.categories.danger) {
      (Array.isArray(st.subjects) ? st.subjects : []).forEach((sub) => {
        if (!sub) return;
        const s = stats(sub, tg);
        if (!s.hasData || s.pctNum >= tg - 10) return;
        add({
          key: `danger:${sub.id}:${s.total}`,
          category: 'danger',
          subjectId: sub.id || '',
          title: 'Attendance danger zone',
          body: `${s.name || sub.name || 'Subject'} is at ${s.percentage}%, more than 10 points below the ${s.target}% target.`
        });
      });
    }

    if (p.categories.classReminder) {
      const today = timetableForDay(st.timetable, current.getDay());
      today.filter((entry) => !entry.cancelled && !entry.holiday && isWithinReminderLead(entry, p, current))
        .forEach((entry) => {
          const sub = (Array.isArray(st.subjects) ? st.subjects : []).find((s) => s && s.id === entry.subjectId);
          if (!sub) return;
          add({
            key: `class:${entry.id}:${iso}:${entry.start}`,
            category: 'classReminder',
            subjectId: sub.id || '',
            title: 'Class starting soon',
            body: `${sub.name} starts at ${formatTime12(entry.start)} · ${entry.room || 'Room not set'}.`
          });
        });
    }

    if (p.categories.milestones) {
      const agg = aggregate(st.subjects, tg);
      const bucket = agg.hasData ? (agg.pctNum >= 85 ? 85 : agg.pctNum >= 80 ? 80 : agg.pctNum >= 75 ? 75 : 0) : 0;
      if (bucket > p.lastMilestone) {
        prefUpdates.lastMilestone = bucket;
        add({
          key: `milestone:${bucket}:${monthKey(iso)}`,
          category: 'milestones',
          subjectId: '',
          title: 'Attendance milestone',
          body: `Overall attendance reached ${bucket}%.`
        });
      }
    }

    if (p.categories.weekly) {
      const weekStart = startOfWeekISO(iso);
      if (p.lastWeeklyISO !== weekStart) {
        const summary = ledgerSummary(st, weekStart, addDaysISO(weekStart, 6));
        if (summary.total > 0) {
          prefUpdates.lastWeeklyISO = weekStart;
          const weekPct = summary.pctNum === null ? '--' : round1(summary.pctNum);
          add({
            key: `weekly:${weekStart}`,
            category: 'weekly',
            subjectId: '',
            title: 'Weekly attendance summary',
            body: `${summary.present} present · ${summary.absent} absent · ${weekPct}%.`
          });
        }
      }
    }

    return { candidates, prefUpdates };
  }

  function sanitizeSyncMeta(raw) {
    const m = raw && typeof raw === 'object' ? raw : {};
    return {
      pending: Boolean(m.pending),
      retries: clampInt(m.retries, 0, 50, 0),
      lastError: cleanText(m.lastError, 160),
      queuedAt: toNumber(m.queuedAt, 0) || 0
    };
  }

  /**
   * Validate + normalise any state-shaped object (localStorage, imported
   * JSON backup, cloud pull). Throws on structurally invalid input.
   */
  function sanitizeState(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('Root data must be a valid JSON object.');
    }

    const subjects = [];
    const seenIds = new Set();
    if (!Array.isArray(raw.subjects)) raw.subjects = [];
    if (raw.subjects.length > MAX_SUBJECTS) {
      throw new Error(`Subjects count exceeds the safe maximum (${MAX_SUBJECTS}).`);
    }

    raw.subjects.forEach((s, idx) => {
      if (!s || typeof s !== 'object') return;
      let id = safeId(s.id, 'sub_' + (Date.now() + idx));
      if (seenIds.has(id)) id = `${id}_${idx}`;
      seenIds.add(id);

      let name = cleanText(s.name, 80) || `Subject ${idx + 1}`;
      const category = VALID_CATEGORIES.includes(String(s.category || '').toLowerCase())
        ? String(s.category).toLowerCase()
        : 'theory';

      const attended = clampInt(s.attended, 0, MAX_CLASSES, 0);
      const total = clampInt(s.total, attended, MAX_CLASSES, attended);

      subjects.push({
        id,
        name,
        category,
        attended,
        total,
        target: clampTarget(s.target, 75)
      });
    });

    const calendar = {};
    if (raw.calendar && typeof raw.calendar === 'object' && !Array.isArray(raw.calendar)) {
      Object.keys(raw.calendar).slice(0, 1500).forEach((dateKey) => {
        if (!isValidISODate(dateKey)) return;
        const day = raw.calendar[dateKey];
        if (!day || typeof day !== 'object') return;
        const entries = {};
        if (day.entries && typeof day.entries === 'object' && !Array.isArray(day.entries)) {
          Object.entries(day.entries).forEach(([subId, status]) => {
            if (!VALID_STATUSES.includes(status) || status === 'none') return;
            const key = safeId(subId, '');
            if (key) entries[key] = status;
          });
        }
        calendar[dateKey] = { isHoliday: Boolean(day.isHoliday), entries };
      });
    }

    const history = [];
    const seenHistory = new Set();
    if (Array.isArray(raw.history)) {
      raw.history.slice(0, MAX_HISTORY).forEach((h, i) => {
        if (!h || typeof h !== 'object') return;
        let id = safeId(h.id, 'hist_' + i);
        if (seenHistory.has(id)) id = `${id}_${i}`;
        seenHistory.add(id);
        const subId = safeId(h.subId, '');
        const date = isValidISODate(h.date) ? h.date : todayISO();
        const status = VALID_STATUSES.includes(h.status) ? h.status : 'present';
        history.push({
          id,
          subId,
          date,
          status,
          timestamp: toNumber(h.timestamp, Date.now()) || Date.now()
        });
      });
    }

    const activeTheme = LEGACY_THEMES[raw.activeTheme] || raw.activeTheme;
    const themeMode = ['dark', 'light', 'system'].includes(raw.themeMode) ? raw.themeMode : 'dark';

    const timetable = [];
    if (Array.isArray(raw.timetable)) {
      raw.timetable.slice(0, 200).forEach((entry, idx) => {
        const clean = normalizeTimetableEntry(entry, subjects);
        if (!clean) return;
        if (timetable.some((e) => e.id === clean.id)) clean.id = `${clean.id}_${idx}`;
        timetable.push(clean);
      });
    }

    const simScenarios = [];
    if (Array.isArray(raw.simScenarios)) {
      raw.simScenarios.slice(0, 3).forEach((sc) => {
        if (!sc || typeof sc !== 'object') return;
        simScenarios.push({
          subjectId: safeId(sc.subjectId, ''),
          attend: clampInt(sc.attend, 0, 500, 0),
          miss: clampInt(sc.miss, 0, 500, 0)
        });
      });
    }

    return {
      isSetupCompleted: Boolean(raw.isSetupCompleted),
      studentName: cleanText(raw.studentName, 50),
      syncCode: typeof raw.syncCode === 'string' && SYNC_CODE_RE.test(raw.syncCode.trim()) ? raw.syncCode.trim().toUpperCase() : '',
      syncAuthKey: typeof raw.syncAuthKey === 'string' && AUTH_KEY_RE.test(raw.syncAuthKey.trim()) ? raw.syncAuthKey.trim() : '',
      accountEmail: typeof raw.accountEmail === 'string' && EMAIL_RE.test(raw.accountEmail.trim())
        ? raw.accountEmail.trim().toLowerCase().slice(0, 254) : '',
      authChoice: raw.authChoice === 'guest' || raw.authChoice === 'account' ? raw.authChoice : '',
      cloudSyncEnabled: raw.cloudSyncEnabled !== false,
      lastSyncedAt: typeof raw.lastSyncedAt === 'number' || typeof raw.lastSyncedAt === 'string' ? raw.lastSyncedAt : null,
      subjects,
      calendar,
      history,
      timetable,
      notifPrefs: sanitizeNotifPrefs(raw.notifPrefs),
      notifications: sanitizeNotifications(raw.notifications, raw.notifPrefs),
      syncMeta: sanitizeSyncMeta(raw.syncMeta),
      simScenarios,
      localUpdatedAt: toNumber(raw.localUpdatedAt, 0) || 0,
      globalTarget: clampTarget(raw.globalTarget, 75),
      activeTheme: THEME_IDS.includes(activeTheme) ? activeTheme : 'graphite',
      themeMode,
      privacyMode: Boolean(raw.privacyMode),
      activeCategory: typeof raw.activeCategory === 'string' ? raw.activeCategory : 'all',
      activeTab: typeof raw.activeTab === 'string' ? raw.activeTab : 'subjects'
    };
  }

  /**
   * Non-destructive merge used when importing a backup or resolving a sync
   * conflict. Existing local records are never dropped: incoming subjects
   * with a new id are appended, matching ids keep the higher class counts,
   * and history/calendar entries are unioned.
   */
  function mergeStates(localRaw, incomingRaw) {
    const local = sanitizeState(localRaw || {});
    const incoming = sanitizeState(incomingRaw || {});
    const result = JSON.parse(JSON.stringify(local));
    const added = { subjects: 0, history: 0, calendar: 0, timetable: 0, notifications: 0 };

    incoming.subjects.forEach((inc) => {
      const existing = result.subjects.find((s) => s.id === inc.id);
      if (!existing) {
        result.subjects.push(inc);
        added.subjects++;
        return;
      }
      if (inc.total > existing.total || (inc.total === existing.total && inc.attended > existing.attended)) {
        existing.attended = inc.attended;
        existing.total = inc.total;
        existing.name = inc.name || existing.name;
        existing.category = inc.category || existing.category;
      }
    });

    const historyIds = new Set(result.history.map((h) => h.id));
    const historyKey = new Set(result.history.map((h) => `${h.date}|${h.subId}`));
    incoming.history.forEach((h) => {
      if (historyIds.has(h.id) || historyKey.has(`${h.date}|${h.subId}`)) return;
      result.history.push(h);
      historyIds.add(h.id);
      historyKey.add(`${h.date}|${h.subId}`);
      added.history++;
    });

    Object.keys(incoming.calendar).forEach((date) => {
      if (!result.calendar[date]) {
        result.calendar[date] = incoming.calendar[date];
        added.calendar++;
        return;
      }
      const target = result.calendar[date];
      target.isHoliday = target.isHoliday || incoming.calendar[date].isHoliday;
      Object.keys(incoming.calendar[date].entries).forEach((subId) => {
        if (!target.entries[subId]) {
          target.entries[subId] = incoming.calendar[date].entries[subId];
          added.calendar++;
        }
      });
    });

    incoming.timetable.forEach((entry) => {
      if (result.timetable.some((e) => e.id === entry.id)) return;
      result.timetable.push(entry);
      added.timetable++;
    });

    const notifKeys = new Set(result.notifications.map((n) => n.key));
    incoming.notifications.forEach((note) => {
      if (notifKeys.has(note.key)) return;
      result.notifications.push(note);
      notifKeys.add(note.key);
      added.notifications++;
    });
    result.notifications = sanitizeNotifications(result.notifications, result.notifPrefs);

    result.subjects.sort((a, b) => a.name.localeCompare(b.name));
    return { state: result, added };
  }

  // ---------------------------------------------------------------
  // CSV (subjects)
  // ---------------------------------------------------------------
  function csvCell(value) {
    return `"${String(value === null || value === undefined ? '' : value).replace(/"/g, '""')}"`;
  }

  const CSV_HEADERS = ['Subject Name', 'Category', 'Attended', 'Total', 'Target'];

  function subjectsToCSV(subjects, globalTarget) {
    const rows = [CSV_HEADERS.join(',')];
    (Array.isArray(subjects) ? subjects : []).forEach((s) => {
      const st = stats(s, globalTarget);
      rows.push([
        csvCell(st && s.name),
        csvCell(s.category || 'theory'),
        st.attended,
        st.total,
        st.target
      ].join(','));
    });
    return rows.join('\r\n') + '\r\n';
  }

  function parseCSVLine(line) {
    const cells = [];
    let value = '';
    let quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') {
          value += '"';
          i++;
        } else if (ch === '"') {
          quoted = false;
        } else {
          value += ch;
        }
      } else if (ch === '"') {
        quoted = true;
      } else if (ch === ',') {
        cells.push(value);
        value = '';
      } else {
        value += ch;
      }
    }
    cells.push(value);
    return cells;
  }

  function csvToSubjects(text, globalTarget) {
    if (typeof text !== 'string' || !text.trim()) throw new Error('CSV file is empty.');
    const lines = text.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim());
    if (lines.length < 2) throw new Error('CSV needs a header row and at least one subject row.');
    if (lines.length > MAX_SUBJECTS + 1) throw new Error(`CSV contains too many rows (max ${MAX_SUBJECTS}).`);

    const header = parseCSVLine(lines[0]).map((h) => h.trim().toLowerCase());
    const col = (...names) => header.findIndex((h) => names.some((n) => h === n || h.includes(n)));
    const nameIdx = col('subject name', 'subject', 'name', 'course');
    const catIdx = col('category', 'type');
    const attIdx = col('attended', 'present');
    const totIdx = col('total', 'held', 'conducted');
    const tgtIdx = col('target', 'criteria');

    if (nameIdx === -1) throw new Error('CSV is missing a "Subject Name" column.');
    if (attIdx === -1 || totIdx === -1) throw new Error('CSV is missing "Attended" and/or "Total" columns.');

    const subjects = [];
    for (let i = 1; i < lines.length; i++) {
      const cells = parseCSVLine(lines[i]);
      const name = cleanText(cells[nameIdx], 80);
      if (!name) continue;
      const attended = clampInt(cells[attIdx], 0, MAX_CLASSES, 0);
      const total = clampInt(cells[totIdx], attended, MAX_CLASSES, attended);
      const category = catIdx !== -1 && VALID_CATEGORIES.includes(String(cells[catIdx] || '').toLowerCase())
        ? String(cells[catIdx]).toLowerCase() : 'theory';
      const target = tgtIdx !== -1 && cells[tgtIdx] ? clampTarget(cells[tgtIdx]) : clampTarget(globalTarget);
      subjects.push({
        id: 'sub_' + Date.now() + '_' + i,
        name,
        category,
        attended,
        total,
        target
      });
    }
    if (!subjects.length) throw new Error('No valid subject rows were found in the CSV.');
    return subjects;
  }

  // ---------------------------------------------------------------
  // Sync conflict detection
  // ---------------------------------------------------------------
  function fingerprintState(raw) {
    const st = sanitizeState(raw || {});
    const parts = [
      st.subjects.map((s) => `${s.id}:${s.name}:${s.attended}/${s.total}:${s.target}`).sort().join('|'),
      st.history.map((h) => `${h.date}:${h.subId}:${h.status}`).sort().join('|'),
      Object.keys(st.calendar).sort().map((d) => `${d}:${JSON.stringify(st.calendar[d])}`).join('|'),
      JSON.stringify(st.notifPrefs),
      st.notifications.map((n) => `${n.key}:${n.read ? 1 : 0}`).sort().join('|'),
      String(st.globalTarget)
    ];
    let hash = 5381;
    const joined = parts.join('~');
    for (let i = 0; i < joined.length; i++) {
      hash = ((hash << 5) + hash + joined.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
  }

  /**
   * Decide what a device should do before pushing.
   * - remote missing/identical      -> 'push'
   * - remote changed by another device after our last sync and differs -> 'conflict'
   * - remote newer but identical content -> 'push'
   */
  function decideSync(localState, remoteMeta) {
    const local = localState || {};
    const remote = remoteMeta || {};
    if (!remote.hasRemote) return { action: 'push', reason: 'no-remote' };
    if (!remote.data) return { action: 'push', reason: 'remote-empty' };

    let remoteFingerprint;
    try {
      remoteFingerprint = fingerprintState(remote.data);
    } catch (err) {
      return { action: 'conflict', reason: 'remote-unreadable' };
    }
    const localFingerprint = fingerprintState(local);
    if (remoteFingerprint === localFingerprint) return { action: 'push', reason: 'in-sync' };

    const lastSynced = toNumber(local.lastSyncedAt, 0);
    const remoteUpdated = toNumber(remote.updatedAt, 0) || Date.parse(remote.lastUpdated || '') || 0;
    if (remoteUpdated && lastSynced && remoteUpdated > lastSynced + 1000) {
      return { action: 'conflict', reason: 'remote-newer', remoteUpdated, localFingerprint, remoteFingerprint };
    }
    return { action: 'push', reason: 'local-newer' };
  }

  return {
    VERSION,
    MAX_CLASSES,
    MAX_SUBJECTS,
    toNumber,
    clampInt,
    clampTarget,
    round1,
    percentage,
    stats,
    project,
    aggregate,
    safeBunks,
    classesNeeded,
    riskLevel,
    todayISO,
    formatISO,
    parseISODate,
    isValidISODate,
    addDaysISO,
    startOfWeekISO,
    monthKey,
    shortDateLabel,
    monthLabel,
    dayName,
    timeToMinutes,
    normalizeTime,
    formatTime12,
    buildDailyLedger,
    ledgerSummary,
    attendanceBuckets,
    trend,
    subjectComparison,
    recentActivity,
    reportWindow,
    rangeReport,
    reportInsights,
    reportToCSV,
    normalizeTimetableEntry,
    timetableForDay,
    timetableOccurrenceKey,
    timetableOverlap,
    timetableConflicts,
    timetableStats,
    upcomingClasses,
    cleanText,
    escapeHtml,
    sanitizeState,
    sanitizeNotifPrefs,
    sanitizeNotification,
    sanitizeNotifications,
    isQuietHour,
    isWithinReminderLead,
    buildNotificationCandidates,
    sanitizeSyncMeta,
    mergeStates,
    subjectsToCSV,
    csvToSubjects,
    fingerprintState,
    decideSync
  };
});
