/*
 * Attendify feature layer.
 *
 * Loaded after app.js so it can reuse the app's state, toast and rendering
 * helpers. Everything added here reads from the same single source of truth
 * (appState in localStorage['attendify_state_v6']) — no demo or mock numbers.
 *
 * Sections:
 *   1. helpers
 *   2. dashboard insights
 *   3. analytics
 *   4. timetable
 *   5. simulator scenario comparison
 *   6. calendar filtering + daily summary
 *   7. notifications
 *   8. sync queue / conflict resolution
 *   9. backup export + JSON/CSV import
 */
(function () {
  'use strict';

  const C = window.AttendifyCalc;
  if (!C) {
    console.warn('[Attendify] calc.js did not load; advanced features are disabled.');
    return;
  }

  const $ = (id) => document.getElementById(id);
  const esc = (value) => C.escapeHtml(value === null || value === undefined ? '' : value);
  const liveState = () => (typeof appState !== 'undefined' ? appState : null);

  function toast(message, type, timeout) {
    if (typeof showToast === 'function') showToast(message, type || 'info', timeout || 4200);
    else console.log('[Attendify]', message);
  }

  function persist(sync) {
    if (typeof saveStateOnly !== 'function') return;
    if (sync && typeof saveState === 'function') saveState();
    else saveStateOnly();
  }

  function target() {
    const state = liveState();
    return C.clampTarget(state && state.globalTarget, 75);
  }

  function riskClass(risk) {
    return risk === 'danger' ? 'risk-danger' : risk === 'watch' ? 'risk-watch' : risk === 'safe' ? 'risk-safe' : 'risk-none';
  }

  function riskLabel(risk) {
    if (risk === 'danger') return 'Below target';
    if (risk === 'watch') return 'Close to target';
    if (risk === 'safe') return 'Safe';
    return 'No classes yet';
  }

  function dateLabel(iso) {
    const d = C.parseISODate(iso);
    if (!d) return iso || '—';
    return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  }

  // ===============================================================
  // 2. Dashboard insights
  // ===============================================================
  function renderDashboard() {
    const state = liveState();
    if (!state) return;
    const agg = C.aggregate(state.subjects, target());

    setText('miniSubjects', agg.subjects);
    setText('miniSafeBunks', agg.hasData ? agg.safeBunks : '—');
    setText('miniNeeded', agg.hasData ? (agg.classesNeeded === null ? '—' : agg.classesNeeded) : '—');
    setText('miniRisk', agg.atRisk);

    renderRiskList(agg);
    renderBelowTarget(agg);
    renderRecentActivity();
    renderUpcoming();
  }

  function setText(id, value) {
    const el = $(id);
    if (el) el.textContent = String(value);
  }

  function renderRiskList(agg) {
    const host = $('dashRiskList');
    const pill = $('riskCountPill');
    if (!host) return;
    if (pill) {
      pill.textContent = String(agg.atRisk);
      pill.className = 'criteria-pill ' + (agg.atRisk ? 'pill-short' : 'pill-safe');
    }
    if (!agg.subjects) {
      host.innerHTML = '<p class="empty-inline">Add subjects to see attendance risk.</p>';
      return;
    }
    const risky = agg.rows
      .filter((row) => row.hasData && (row.risk === 'danger' || row.risk === 'watch'))
      .sort((a, b) => a.pctNum - b.pctNum)
      .slice(0, 4);

    if (!risky.length) {
      const noData = agg.rows.every((row) => !row.hasData);
      host.innerHTML = `<p class="empty-inline">${noData
        ? 'Mark your first class to start risk tracking.'
        : 'Every subject is comfortably above your target.'}</p>`;
      return;
    }

    host.innerHTML = risky.map((row) => `
      <div class="risk-row">
        <span class="risk-dot ${riskClass(row.risk)}" aria-hidden="true"></span>
        <div class="risk-copy">
          <span class="risk-name">${esc(row.name)}</span>
          <span class="risk-meta">${row.isShort
            ? `Attend ${row.classesNeeded === null ? '—' : row.classesNeeded} in a row to reach ${row.target}%`
            : `Only ${Math.max(0, Math.round(row.pctNum - row.target))} points above target`}</span>
        </div>
        <span class="risk-pct ${riskClass(row.risk)}">${row.percentage}%</span>
      </div>
    `).join('');
  }

  function renderBelowTarget(agg) {
    const host = $('dashBelowList');
    if (!host) return;
    setText('dashTargetLabel', `${agg.target}%`);
    if (!agg.subjects) {
      host.innerHTML = '<p class="empty-inline">No subjects yet.</p>';
      return;
    }
    const short = agg.rows.filter((row) => row.isShort).sort((a, b) => a.pctNum - b.pctNum);
    if (!short.length) {
      host.innerHTML = `<p class="empty-inline">Nothing below ${agg.target}%. Keep logging classes to stay safe.</p>`;
      return;
    }
    host.innerHTML = short.slice(0, 4).map((row) => `
      <div class="below-row">
        <div class="below-copy">
          <span class="risk-name">${esc(row.name)}</span>
          <span class="risk-meta">${row.attended}/${row.total} attended · short by ${row.shortagePct}%</span>
        </div>
        <span class="below-badge">+${row.classesNeeded === null ? '∞' : row.classesNeeded} classes</span>
      </div>
    `).join('');
  }

  function renderRecentActivity() {
    const host = $('dashRecentList');
    const state = liveState();
    if (!host || !state) return;
    const rows = C.recentActivity(state, 5);
    if (!rows.length) {
      host.innerHTML = '<p class="empty-inline">No attendance logged yet. Mark a class as present or absent to see it here.</p>';
      return;
    }
    host.innerHTML = rows.map((row) => `
      <div class="recent-row">
        <span class="recent-badge ${row.status === 'present' ? 'is-present' : 'is-absent'}" aria-hidden="true">${row.status === 'present' ? '✓' : '✕'}</span>
        <div class="recent-copy">
          <span class="risk-name">${esc(row.subject)}</span>
          <span class="risk-meta">${esc(dateLabel(row.date))} · ${esc(row.label)}</span>
        </div>
      </div>
    `).join('');
  }

  function renderUpcoming() {
    const host = $('dashUpcomingList');
    const state = liveState();
    if (!host || !state) return;
    if (!Array.isArray(state.timetable) || state.timetable.length === 0) {
      host.innerHTML = '<p class="empty-inline">No timetable yet. <button type="button" class="link-btn" data-action="switchTab" data-tab="timetable">Add your weekly classes</button></p>';
      return;
    }
    const view = C.upcomingClasses(state.timetable, new Date());
    const rows = view.upcoming.slice(0, 4);
    if (!rows.length) {
      host.innerHTML = '<p class="empty-inline">No more classes scheduled this week.</p>';
      return;
    }
    host.innerHTML = rows.map((entry) => `
      <div class="upcoming-row">
        <div class="upcoming-time">
          <span>${esc(C.formatTime12(entry.start))}</span>
          <span class="risk-meta">${esc(entry.dayLabel)}</span>
        </div>
        <div class="recent-copy">
          <span class="risk-name">${esc(entry.subjectName)}</span>
          <span class="risk-meta">${esc([entry.room, entry.faculty].filter(Boolean).join(' · ') || 'No room set')}</span>
        </div>
        ${entry.isNow ? '<span class="criteria-pill pill-safe">Now</span>' : ''}
      </div>
    `).join('');
  }

  // ===============================================================
  // 3. Analytics
  // ===============================================================
  function renderAnalytics() {
    const state = liveState();
    if (!state) return;
    const host = $('anaContent');
    const empty = $('anaEmpty');
    const weekly = C.attendanceBuckets(state, { mode: 'week', count: 8 });
    const monthly = C.attendanceBuckets(state, { mode: 'month', count: 6 });
    const hasHistory = weekly.some((b) => b.total > 0) ||
      (state.history || []).some((h) => h.status === 'present' || h.status === 'absent');

    if (host) host.hidden = !hasHistory;
    if (empty) empty.style.display = hasHistory ? 'none' : 'flex';
    if (!hasHistory) return;

    const agg = C.aggregate(state.subjects, target());
    const trend = C.trend(weekly, 4);

    const kpis = $('anaKpis');
    if (kpis) {
      kpis.innerHTML = [
        { label: 'Overall attendance', value: agg.hasData ? `${agg.percentage}%` : '—', tone: agg.hasData && agg.isShort ? 'danger' : agg.hasData ? 'success' : 'neutral', subtitle: `${agg.attended} / ${agg.conducted}` },
        { label: 'Classes attended', value: `${agg.attended}/${agg.conducted}`, tone: 'neutral', subtitle: `of ${agg.conducted} total` },
        { label: `${trend.window ? trend.window * 2 : 4}-week trend`, value: trend.direction === 'unknown' ? '—' : `${trend.delta > 0 ? '+' : ''}${C.round1(trend.delta)}%`, tone: trend.direction === 'down' ? 'danger' : trend.direction === 'up' ? 'success' : 'neutral', subtitle: `(${C.round1(trend.current)}% vs ${C.round1(trend.previous)}% prior)` },
        { label: 'Subjects at risk', value: String(agg.atRisk), tone: agg.atRisk ? 'danger' : 'success' }
      ].map((k) => `
        <div class="mini-stat">
          <span class="mini-stat-val tone-${k.tone}">${esc(k.value)}</span>
          <span class="mini-stat-lbl">${esc(k.label)}</span>
        </div>
      `).join('');
    }

    const weeklyHost = $('anaWeeklyChart');
    if (weeklyHost) {
      weeklyHost.innerHTML = barChart(weekly, agg.target);
      setText('anaWeeklyNote', `${weekly.filter((b) => b.total).length} active weeks`);
    }
    const monthlyHost = $('anaMonthlyChart');
    if (monthlyHost) monthlyHost.innerHTML = barChart(monthly, agg.target);

    const compareHost = $('anaSubjectBars');
    if (compareHost) {
      const rows = C.subjectComparison(state.subjects, target());
      compareHost.innerHTML = rows.length ? rows.map((row) => `
        <div class="subject-bar-row">
          <div class="subject-bar-head">
            <span class="risk-name">${esc(row.name)}</span>
            <span class="subject-bar-val ${riskClass(row.risk)}">${row.percentage}%</span>
          </div>
          <div class="bar-track wide" role="img" aria-label="${esc(row.name)}: ${row.percentage}% (${row.attended} of ${row.total} classes)">
            <span class="bar-target" style="left:${row.target}%"></span>
            <span class="bar-fill ${riskClass(row.risk)}" style="width:${Math.min(100, Math.max(0, row.pctNum))}%"></span>
          </div>
          <div class="subject-bar-meta">
            <span>${row.attended}/${row.total} attended</span>
            <span>${row.isShort ? `Need ${row.classesNeeded === null ? '—' : row.classesNeeded} more` : `${row.safeBunks} safe bunks`}</span>
          </div>
        </div>
      `).join('') : '<p class="empty-inline">Log a few classes to compare subjects.</p>';
    }

    const trendHost = $('anaTrend');
    if (trendHost) {
      if (trend.direction === 'unknown') {
        trendHost.innerHTML = '<p class="empty-inline">Log attendance across at least two weeks to see a trend.</p>';
      } else {
        const word = trend.direction === 'up' ? 'improving' : trend.direction === 'down' ? 'declining' : 'steady';
        trendHost.innerHTML = `
          <div class="trend-block ${trend.direction === 'down' ? 'is-down' : trend.direction === 'up' ? 'is-up' : ''}">
            <span class="trend-arrow" aria-hidden="true">${trend.direction === 'up' ? '↑' : trend.direction === 'down' ? '↓' : '→'}</span>
            <div>
              <strong>Attendance is ${word}</strong>
              <p>Last ${trend.window} weeks ${C.round1(trend.current)}% vs the previous ${trend.window} weeks ${C.round1(trend.previous)}% (${trend.delta > 0 ? '+' : ''}${C.round1(trend.delta)} points).</p>
            </div>
          </div>`;
      }
    }

    const riskHost = $('anaAtRisk');
    if (riskHost) {
      const risky = C.aggregate(state.subjects, target()).rows
        .filter((row) => row.hasData && (row.risk === 'danger' || row.risk === 'watch'))
        .sort((a, b) => a.pctNum - b.pctNum);
      riskHost.innerHTML = `
        <h4 class="insight-subhead">Subjects at risk</h4>
        ${risky.length ? risky.map((row) => `
          <div class="risk-row">
            <span class="risk-dot ${riskClass(row.risk)}" aria-hidden="true"></span>
            <div class="risk-copy">
              <span class="risk-name">${esc(row.name)}</span>
              <span class="risk-meta">${riskLabel(row.risk)} · target ${row.target}%</span>
            </div>
            <span class="risk-pct ${riskClass(row.risk)}">${row.percentage}%</span>
          </div>`).join('') : '<p class="empty-inline">No subjects currently at risk.</p>'}
      `;
    }

    const semester = $('anaSemester');
    if (semester) {
      const rows = agg.rows.filter((r) => r.hasData);
      const best = rows.slice().sort((a, b) => b.pctNum - a.pctNum)[0];
      const worst = rows.slice().sort((a, b) => a.pctNum - b.pctNum)[0];
      semester.innerHTML = `
        <div class="semester-grid">
          <div><span class="mini-stat-lbl">Semester attendance</span><strong>${agg.hasData ? agg.percentage + '%' : '—'}</strong></div>
          <div><span class="mini-stat-lbl">Classes attended / held</span><strong>${agg.attended} / ${agg.conducted}</strong></div>
          <div><span class="mini-stat-lbl">Classes missed</span><strong>${agg.missed}</strong></div>
          <div><span class="mini-stat-lbl">Safe bunks remaining</span><strong>${agg.hasData ? agg.safeBunks : '—'}</strong></div>
          <div><span class="mini-stat-lbl">Best subject</span><strong>${best ? `${esc(best.name)} · ${best.percentage}%` : '—'}</strong></div>
          <div><span class="mini-stat-lbl">Weakest subject</span><strong>${worst ? `${esc(worst.name)} · ${worst.percentage}%` : '—'}</strong></div>
        </div>`;
    }
  }

  function barChart(buckets, targetPct) {
    if (!buckets.some((b) => b.total > 0)) {
      return '<p class="empty-inline">No classes logged in this period.</p>';
    }
    const cols = buckets.map((bucket) => {
      const pct = bucket.pctNum;
      const height = pct === null ? 0 : Math.max(4, Math.min(100, pct));
      const level = pct === null ? 'is-empty' : pct < targetPct ? 'risk-danger' : pct < targetPct + 5 ? 'risk-watch' : 'risk-safe';
      const aria = pct === null
        ? `${bucket.label}: no classes`
        : `${bucket.label}: ${pct}% attendance (${bucket.present} present, ${bucket.absent} absent)`;
      return `
        <div class="bar-col" role="img" aria-label="${esc(aria)}">
          <span class="bar-value">${pct === null ? '–' : Math.round(pct) + '%'}</span>
          <span class="bar-track"><span class="bar-fill ${level}" style="height:${height}%"></span></span>
          <span class="bar-label">${esc(bucket.label)}</span>
        </div>`;
    }).join('');
    return `<div class="bar-chart-inner">${cols}</div>
      <p class="chart-caption">Bars show present ÷ (present + absent) per period. Gaps mean no classes were logged.</p>`;
  }

  // ===============================================================
  // 4. Timetable
  // ===============================================================
  let ttWeekOffset = 0;
  const SUBJECT_COLORS = ['#5b8cff', '#3ecf8e', '#f5a524', '#b57bff', '#f0657b', '#22c7d8'];

  function ensureTimetable() {
    const state = liveState();
    if (!state) return [];
    if (!Array.isArray(state.timetable)) state.timetable = [];
    return state.timetable;
  }

  function subjectColor(subjectId) {
    const state = liveState();
    const index = state && Array.isArray(state.subjects)
      ? state.subjects.findIndex((s) => s.id === subjectId)
      : -1;
    return SUBJECT_COLORS[(index < 0 ? 0 : index) % SUBJECT_COLORS.length];
  }

  function shiftDate(iso, days) {
    const d = C.parseISODate(iso);
    if (!d) return iso;
    d.setDate(d.getDate() + days);
    return C.formatISO(d);
  }

  function renderTimetable() {
    const state = liveState();
    if (!state) return;
    const hasSubjects = Array.isArray(state.subjects) && state.subjects.length > 0;
    const empty = $('ttEmpty');
    const body = $('ttBody');
    const weekCard = $('ttWeekCard');
    if (empty) empty.style.display = hasSubjects ? 'none' : 'flex';
    if (body) body.hidden = !hasSubjects;
    if (weekCard) weekCard.hidden = !hasSubjects;

    const select = $('ttSubject');
    if (select) {
      const previous = select.value;
      select.innerHTML = state.subjects
        .map((sub) => `<option value="${esc(sub.id)}">${esc(sub.name)}</option>`)
        .join('');
      if (previous && state.subjects.some((s) => s.id === previous)) select.value = previous;
    }
    if (!hasSubjects) return;

    const now = new Date();
    const todayIso = C.todayISO(now);
    const view = C.upcomingClasses(ensureTimetable(), now);
    const daily = C.timetableStats(ensureTimetable(), state, now);

    const dateEl = $('ttTodayDate');
    if (dateEl) {
      dateEl.textContent = now.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' });
    }
    const statsEl = $('ttDayStats');
    if (statsEl) {
      const next = daily.nextClass;
      const current = daily.currentClass;
      statsEl.innerHTML = `
        <span class="tt-stat"><strong>${daily.total}</strong> scheduled</span>
        <span class="tt-stat"><strong>${daily.completed}</strong> recorded</span>
        <span class="tt-stat"><strong>${daily.upcoming}</strong> upcoming</span>
        <span class="tt-stat"><strong>${current ? esc(C.formatTime12(current.start)) : '—'}</strong> current</span>
        <span class="tt-stat"><strong>${next ? esc(C.formatTime12(next.start)) : '—'}</strong> next</span>`;
    }

    const todayHost = $('ttToday');
    if (todayHost) {
      todayHost.innerHTML = daily.rows.length
        ? daily.rows.map((entry) => timetableRow(entry, true, todayIso)).join('')
        : '<p class="empty-inline">No classes scheduled for today. Add one below or in the weekly grid.</p>';
    }

    const upcomingHost = $('ttUpcoming');
    if (upcomingHost) {
      const rows = view.upcoming.filter((entry) => entry.dayLabel !== 'Today').slice(0, 5);
      upcomingHost.innerHTML = rows.length
        ? rows.map((entry) => timetableRow(entry, false, '')).join('')
        : '<p class="empty-inline">Nothing else scheduled this week.</p>';
    }

    renderWeekGrid(todayIso);
    const overlapNote = $('ttOverlapNote');
    if (overlapNote) {
      const clashes = C.timetableConflicts(ensureTimetable());
      overlapNote.textContent = clashes.length
        ? `${clashes.length} overlapping class pair${clashes.length === 1 ? '' : 's'} on the weekly schedule. Overlaps are only kept when explicitly accepted in the form.`
        : 'Class colours follow your subject list. Tap a class to edit, duplicate or mark attendance.';
    }
  }

  function renderWeekGrid(todayIso) {
    const host = $('ttWeek');
    if (!host) return;
    const monday = shiftDate(C.startOfWeekISO(todayIso), ttWeekOffset * 7);
    const label = $('ttWeekLabel');
    if (label) {
      label.textContent = ttWeekOffset === 0
        ? `Week of ${esc(C.shortDateLabel(monday))}`
        : `${esc(C.shortDateLabel(monday))} · ${ttWeekOffset > 0 ? '+' : ''}${ttWeekOffset} week${Math.abs(ttWeekOffset) === 1 ? '' : 's'}`;
    }

    const entries = ensureTimetable();
    const columns = [];
    for (let index = 0; index < 7; index++) {
      const day = (index + 1) % 7; // Monday first
      const iso = shiftDate(monday, index);
      const isToday = iso === todayIso;
      const dayEntries = C.timetableForDay(entries, day)
        .filter((entry) => entry.recurrence !== 'once' || !entry.date || entry.date === iso || ttWeekOffset !== 0);
      const blocks = dayEntries.map((entry) => {
        const start = C.timeToMinutes(entry.start);
        const end = entry.end ? C.timeToMinutes(entry.end) : start + 45;
        const top = Math.max(0, ((start - 6 * 60) / 60) * 44);
        const height = Math.max(38, ((end - start) / 60) * 44);
        const color = subjectColor(entry.subjectId);
        const classes = ['tt-grid-block', entry.cancelled ? 'is-cancelled' : '', entry.holiday ? 'is-holiday' : ''].filter(Boolean).join(' ');
        return `
          <button type="button" class="${classes}" style="top:${top}px;height:${height}px;--tt-color:${color};"
            data-action="ttEdit" data-id="${esc(entry.id)}"
            aria-label="${esc(entry.subjectName)} at ${esc(C.formatTime12(entry.start))}${entry.cancelled ? ', cancelled' : ''}${entry.holiday ? ', holiday' : ''}">
            <strong>${esc(entry.subjectName)}</strong>
            <span>${esc(C.formatTime12(entry.start))}</span>
            ${entry.cancelled ? '<em>Cancelled</em>' : ''}${entry.holiday ? '<em>Holiday</em>' : ''}
          </button>`;
      }).join('');
      columns.push(`
        <div class="tt-grid-day ${isToday ? 'is-today' : ''}">
          <div class="tt-grid-head"><span>${esc(C.dayName(day).slice(0, 3))}</span><strong>${Number(iso.slice(8, 10))}</strong></div>
          <div class="tt-grid-body">${blocks || '<span class="tt-grid-empty">No class</span>'}</div>
        </div>`);
    }
    host.innerHTML = columns.join('');
  }

  function timetableRow(entry, isToday, dateIso) {
    const time = entry.end
      ? `${C.formatTime12(entry.start)} – ${C.formatTime12(entry.end)}`
      : C.formatTime12(entry.start);
    const meta = [entry.room, entry.faculty, entry.classType && entry.classType !== 'theory' ? entry.classType : '']
      .filter(Boolean).join(' · ') || 'Room / faculty not set';
    const note = entry.notes ? `<span class="risk-meta">${esc(entry.notes)}</span>` : '';
    const flag = entry.cancelled ? '<span class="criteria-pill pill-short">Cancelled</span>'
      : entry.holiday ? '<span class="criteria-pill pill-neutral">Holiday</span>' : '';
    const recordable = isToday && entry.subjectId && !entry.cancelled && !entry.holiday;
    const status = entry.status && entry.status !== 'none'
      ? `<span class="criteria-pill ${entry.status === 'present' ? 'pill-safe' : entry.status === 'absent' ? 'pill-short' : 'pill-neutral'}">${esc(entry.status)}</span>`
      : '';
    return `
      <div class="tt-row ${entry.isNow ? 'is-now' : ''}" style="--tt-color:${subjectColor(entry.subjectId)}">
        <div class="tt-time">
          <strong>${esc(time)}</strong>
          <span class="risk-meta">${esc(entry.dayLabel || C.dayName(entry.day))}</span>
        </div>
        <div class="recent-copy">
          <span class="risk-name">${esc(entry.subjectName)} ${flag}${status}</span>
          <span class="risk-meta">${esc(meta)}</span>
          ${note}
        </div>
        <div class="tt-actions">
          ${recordable ? `
            <button type="button" class="act-btn act-present" data-action="ttMark" data-status="present" data-id="${esc(entry.id)}" title="Mark present">✓</button>
            <button type="button" class="act-btn act-absent" data-action="ttMark" data-status="absent" data-id="${esc(entry.id)}" title="Mark absent">✕</button>
            <button type="button" class="act-btn" data-action="ttMark" data-status="off" data-id="${esc(entry.id)}" title="Mark cancelled class (does not count)">Off</button>
          ` : ''}
          ${isToday && entry.subjectId ? `<button type="button" class="act-btn" data-action="ttHistory" data-id="${esc(entry.id)}" title="View attendance history">History</button>` : ''}
          <button type="button" class="act-btn" data-action="ttDuplicate" data-id="${esc(entry.id)}" title="Duplicate class">Copy</button>
          <button type="button" class="act-btn" data-action="ttEdit" data-id="${esc(entry.id)}" title="Edit class">Edit</button>
          <button type="button" class="act-btn act-absent" data-action="ttDelete" data-id="${esc(entry.id)}" title="Delete class">✕</button>
        </div>
      </div>`;
  }

  function resetTimetableForm() {
    const form = $('ttForm');
    if (form) form.reset();
    setText('ttFormTitle', 'Add a class');
    setText('ttFormMeta', 'Repeats weekly');
    const idInput = $('ttEditId');
    if (idInput) idInput.value = '';
    const cancel = $('ttCancelEdit');
    if (cancel) cancel.hidden = true;
    const msg = $('ttFormMsg');
    if (msg) msg.textContent = '';
    syncRecurrenceFields();
  }

  function syncRecurrenceFields() {
    const recurrence = $('ttRecurrence');
    const group = $('ttDateGroup');
    const day = $('ttDay');
    const isOnce = Boolean(recurrence && recurrence.value === 'once');
    if (group) group.hidden = !isOnce;
    if (day) day.disabled = isOnce;
    if (isOnce) {
      const dateInput = $('ttDate');
      if (dateInput && !dateInput.value) dateInput.value = C.todayISO();
    }
  }

  function handleTimetableSubmit(event) {
    event.preventDefault();
    const state = liveState();
    if (!state) return;
    const idInput = $('ttEditId');
    const subjectSelect = $('ttSubject');
    const dayInput = $('ttDay');
    const startInput = $('ttStart');
    const endInput = $('ttEnd');
    const roomInput = $('ttRoom');
    const facultyInput = $('ttFaculty');
    const msg = $('ttFormMsg');
    if (!subjectSelect || !dayInput || !startInput) return;

    const entry = C.normalizeTimetableEntry({
      id: (idInput && idInput.value) || undefined,
      day: dayInput.value,
      subjectId: subjectSelect.value,
      start: startInput.value,
      end: endInput ? endInput.value : '',
      room: roomInput ? roomInput.value : '',
      faculty: facultyInput ? facultyInput.value : '',
      classType: ($('ttClassType') || {}).value || 'theory',
      notes: ($('ttNotes') || {}).value || '',
      recurrence: ($('ttRecurrence') || {}).value || 'weekly',
      date: ($('ttDate') || {}).value || '',
      cancelled: Boolean(($('ttCancelled') || {}).checked),
      holiday: Boolean(($('ttHoliday') || {}).checked),
      allowOverlap: Boolean(($('ttAllowOverlap') || {}).checked)
    }, state.subjects);

    if (!entry) {
      if (msg) msg.textContent = 'Enter a valid start time (and an end time after it), and a valid date for one-off classes.';
      toast('Could not save the class: check the time and date fields.', 'error');
      return;
    }
    if (entry.recurrence === 'once' && !entry.date) {
      if (msg) msg.textContent = 'Choose the date for this one-off class.';
      toast('Choose a date for the one-off class.', 'warning');
      return;
    }

    const timetable = ensureTimetable();
    const clash = timetable.find((other) => other.id !== entry.id && C.timetableOverlap(other, entry));
    if (clash && !entry.allowOverlap) {
      const warning = `This overlaps "${clash.subjectName}" at ${C.formatTime12(clash.start)}. Tick “allow overlap” to save it anyway.`;
      if (msg) msg.textContent = warning;
      toast(warning, 'warning');
      return;
    }

    const existingIndex = timetable.findIndex((item) => item.id === entry.id);
    if (existingIndex >= 0) timetable[existingIndex] = entry;
    else timetable.push(entry);

    state.localUpdatedAt = Date.now();
    persist(true);
    resetTimetableForm();
    renderTimetable();
    renderDashboard();
    toast(existingIndex >= 0 ? 'Class updated.' : 'Class added to your timetable.', 'success');
  }

  function editTimetableEntry(id) {
    const state = liveState();
    if (!state) return;
    const entry = ensureTimetable().find((item) => item.id === id);
    if (!entry) return;
    const idInput = $('ttEditId');
    if (idInput) idInput.value = entry.id;
    const subject = $('ttSubject');
    if (subject) subject.value = entry.subjectId || '';
    const day = $('ttDay');
    if (day) day.value = String(entry.day);
    const start = $('ttStart');
    if (start) start.value = entry.start;
    const end = $('ttEnd');
    if (end) end.value = entry.end || '';
    const room = $('ttRoom');
    if (room) room.value = entry.room || '';
    const faculty = $('ttFaculty');
    if (faculty) faculty.value = entry.faculty || '';
    const type = $('ttClassType');
    if (type) type.value = entry.classType || 'theory';
    const notes = $('ttNotes');
    if (notes) notes.value = entry.notes || '';
    const recurrence = $('ttRecurrence');
    if (recurrence) recurrence.value = entry.recurrence || 'weekly';
    const date = $('ttDate');
    if (date) date.value = entry.date || C.todayISO();
    const cancelled = $('ttCancelled');
    if (cancelled) cancelled.checked = Boolean(entry.cancelled);
    const holiday = $('ttHoliday');
    if (holiday) holiday.checked = Boolean(entry.holiday);
    const overlap = $('ttAllowOverlap');
    if (overlap) overlap.checked = Boolean(entry.allowOverlap);
    syncRecurrenceFields();
    setText('ttFormTitle', 'Edit class');
    setText('ttFormMeta', entry.recurrence === 'once' ? `One-off · ${entry.date}` : 'Repeats weekly');
    const cancelBtn = $('ttCancelEdit');
    if (cancelBtn) cancelBtn.hidden = false;
    const form = $('ttForm');
    if (form && form.scrollIntoView) form.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function deleteTimetableEntry(id) {
    const state = liveState();
    if (!state) return;
    const timetable = ensureTimetable();
    const entry = timetable.find((item) => item.id === id);
    if (!entry) return;
    if (!window.confirm(`Delete ${entry.subjectName} on ${C.dayName(entry.day)} at ${C.formatTime12(entry.start)}?`)) return;
    state.timetable = timetable.filter((item) => item.id !== id);
    state.localUpdatedAt = Date.now();
    persist(true);
    renderTimetable();
    renderDashboard();
    toast('Class removed from the timetable.', 'success');
  }

  function duplicateTimetableEntry(id) {
    const state = liveState();
    if (!state) return;
    const entry = ensureTimetable().find((item) => item.id === id);
    if (!entry) return;
    const copy = Object.assign({}, entry, {
      id: 'tt_' + Date.now() + '_' + Math.floor(Math.random() * 1e6),
      subjectName: entry.subjectName,
      allowOverlap: true
    });
    // A straight duplicate overlaps the original; keep it explicit and warn.
    ensureTimetable().push(copy);
    state.localUpdatedAt = Date.now();
    persist(true);
    renderTimetable();
    toast('Class duplicated. Move its time to avoid an overlap.', 'warning');
  }

  function markTimetableAttendance(id, status) {
    const state = liveState();
    if (!state || !['present', 'absent', 'off'].includes(status)) return;
    const entry = ensureTimetable().find((item) => item.id === id);
    if (!entry || !entry.subjectId || entry.cancelled || entry.holiday) return;
    if (typeof recordAttendanceEntry !== 'function') return;
    const dateIso = C.todayISO();
    // recordAttendanceEntry deduplicates by date + subject id and adjusts
    // subject totals itself, so repeated taps never create duplicate records.
    recordAttendanceEntry(dateIso, entry.subjectId, status);
    renderTimetable();
    renderDashboard();
    renderAnalytics();
    toast(`${entry.subjectName}: marked ${status === 'off' ? 'off (not counted)' : status} for today.`, status === 'absent' ? 'error' : 'success');
  }

  function viewTimetableHistory(id) {
    const entry = ensureTimetable().find((item) => item.id === id);
    if (!entry || !entry.subjectId) return;
    if (typeof openSubjectHistoryDrawer === 'function') {
      openSubjectHistoryDrawer(entry.subjectId);
      return;
    }
    toast('Open My Subjects and choose this subject to see its full history.', 'info');
  }

  function shiftTimetableWeek(delta) {
    ttWeekOffset = C.clampInt(ttWeekOffset + delta, -260, 260);
    renderTimetable();
  }

  // ===============================================================
  // 5. Simulator scenario comparison
  // ===============================================================
  function renderSimulatorExtras() {
    const state = liveState();
    const host = $('simCompare');
    const targetRow = $('simTargetRow');
    if (!state) return;

    if (targetRow) {
      targetRow.innerHTML = [75, 80, 85].map((pct) => `
        <button type="button" class="filter-chip ${target() === pct ? 'active' : ''}" data-action="setTarget" data-target="${pct}">${pct}%</button>
      `).join('') + `<button type="button" class="filter-chip" data-action="openTargetModal">Custom · ${target()}%</button>`;
    }

    if (!host) return;
    const select = $('calcSubjectSelect');
    const subject = state.subjects.find((sub) => sub.id === (select && select.value)) || state.subjects[0];
    if (!subject) {
      host.innerHTML = '<p class="empty-inline">Add a subject to compare scenarios.</p>';
      return;
    }

    const attendInput = $('calcAttendNext');
    const missInput = $('calcBunkNext');
    const live = {
      label: 'Current plan',
      attend: C.clampInt(attendInput && attendInput.value, 0, 500, 0),
      miss: C.clampInt(missInput && missInput.value, 0, 500, 0)
    };
    const saved = (Array.isArray(state.simScenarios) ? state.simScenarios : [])
      .map((sc) => ({ label: 'Saved plan', attend: sc.attend, miss: sc.miss, subjectId: sc.subjectId }))
      .filter((sc) => !sc.subjectId || sc.subjectId === subject.id);

    const scenarios = [live].concat(saved).slice(0, 3);
    host.innerHTML = scenarios.map((scenario, index) => {
      const projection = C.project(subject, scenario, target());
      const tone = projection.pctNum < target() ? 'danger' : 'success';
      return `
        <div class="scenario-card ${index === 0 ? 'is-live' : ''}">
          <span class="scenario-label">${esc(scenario.label)}${index > 0 ? ' ' + index : ''}</span>
          <span class="scenario-pct tone-${tone}">${projection.percentage}%</span>
          <span class="risk-meta">+${scenario.attend} attended · +${scenario.miss} missed</span>
          <span class="scenario-note">${projection.meets
            ? `${projection.safeBunksAfter} safe bunks left`
            : `Needs ${projection.neededAfter === null ? 'an unreachable' : projection.neededAfter} more present ${projection.neededAfter === 1 ? 'class' : 'classes'}`}</span>
        </div>`;
    }).join('') + `
      <div class="scenario-actions">
        <button type="button" class="btn-quiet" data-action="simSaveScenario">Save this plan</button>
        ${saved.length ? '<button type="button" class="btn-quiet" data-action="simClearScenarios">Clear saved</button>' : ''}
      </div>`;
  }

  function saveSimScenario() {
    const state = liveState();
    if (!state) return;
    const select = $('calcSubjectSelect');
    const attendInput = $('calcAttendNext');
    const missInput = $('calcBunkNext');
    const attend = C.clampInt(attendInput && attendInput.value, 0, 500, 0);
    const miss = C.clampInt(missInput && missInput.value, 0, 500, 0);
    if (attend === 0 && miss === 0) {
      toast('Set how many classes you plan to attend or miss first.', 'warning');
      return;
    }
    state.simScenarios = (Array.isArray(state.simScenarios) ? state.simScenarios : []).slice(-2);
    state.simScenarios.push({ subjectId: select ? select.value : '', attend, miss });
    state.localUpdatedAt = Date.now();
    persist(true);
    renderSimulatorExtras();
    toast('Scenario saved for comparison.', 'success');
  }

  function clearSimScenarios() {
    const state = liveState();
    if (!state) return;
    state.simScenarios = [];
    persist(true);
    renderSimulatorExtras();
    toast('Saved scenarios cleared.', 'info');
  }

  // ===============================================================
  // 6. Calendar filter + daily summary
  // ===============================================================
  let calendarFilter = 'all';

  function renderCalendarFilter() {
    const select = $('calSubjectFilter');
    const state = liveState();
    if (!select || !state) return;
    const previous = calendarFilter;
    select.innerHTML = '<option value="all">All subjects</option>' + state.subjects
      .map((sub) => `<option value="${esc(sub.id)}">${esc(sub.name)}</option>`)
      .join('');
    if (previous !== 'all' && state.subjects.some((s) => s.id === previous)) select.value = previous;
    else {
      calendarFilter = 'all';
      select.value = 'all';
    }
  }

  function applyCalendarFilter() {
    const state = liveState();
    if (!state) return;

    const summary = $('calDaySummary');
    if (summary) {
      const day = state.calendar[calSelectedDate] || { isHoliday: false, entries: {} };
      const counts = { present: 0, absent: 0, off: 0, none: 0 };
      state.subjects.forEach((sub) => {
        const status = (day.entries && day.entries[sub.id]) || 'none';
        counts[status] = (counts[status] || 0) + 1;
      });
      summary.textContent = day.isHoliday
        ? `Holiday · ${counts.present} present · ${counts.absent} absent`
        : `${counts.present} present · ${counts.absent} absent · ${counts.off} cancelled · ${counts.none} not marked`;
    }

    const list = $('calDailySubjectsList');
    if (list && calendarFilter !== 'all') {
      Array.prototype.forEach.call(list.children, (row) => {
        const actions = row.querySelectorAll('[data-subid]');
        const subId = actions.length ? actions[0].getAttribute('data-subid') : null;
        if (!subId) return;
        row.style.display = calendarFilter === 'all' || subId === calendarFilter ? '' : 'none';
      });
    }

    const grid = $('calGridDays');
    if (grid) {
      Array.prototype.forEach.call(grid.querySelectorAll('.cal-cell[data-date]'), (cell) => {
        const date = cell.getAttribute('data-date');
        const day = state.calendar[date];
        const dotRow = cell.querySelector('.cal-dot-row');
        if (!day || !day.entries) return;
        let present = 0;
        let absent = 0;
        Object.keys(day.entries).forEach((subId) => {
          if (calendarFilter !== 'all' && subId !== calendarFilter) return;
          if (day.entries[subId] === 'present') present++;
          if (day.entries[subId] === 'absent') absent++;
        });
        const dot = dotRow && dotRow.querySelector('.cal-dot');
        if (!dot || day.isHoliday) return;
        dot.className = 'cal-dot ' + (present && absent ? 'dot-mix' : present ? 'dot-pres' : absent ? 'dot-abs' : 'dot-none');
        cell.classList.toggle('cal-filter-empty', calendarFilter !== 'all' && !present && !absent);
      });
    }
  }

  function setCalendarFilter(value) {
    calendarFilter = value || 'all';
    if (typeof renderCalendar === 'function') renderCalendar();
    else applyCalendarFilter();
  }

  // ===============================================================
  // 7. Notifications
  // ===============================================================
  const notified = new Set();

  function prefs() {
    const state = liveState();
    if (!state) return null;
    if (!state.notifPrefs || typeof state.notifPrefs !== 'object') state.notifPrefs = C.sanitizeNotifPrefs({});
    return state.notifPrefs;
  }

  function renderNotificationSettings() {
    const p = prefs();
    if (!p) return;
    const enabled = $('notifEnabled');
    if (enabled) enabled.checked = p.enabled !== false;
    ['belowTarget', 'danger', 'classReminder', 'weekly', 'milestones'].forEach((key) => {
      const input = document.querySelector(`[data-notif-key="${key}"]`);
      if (input) input.checked = p[key] !== false;
    });
    const status = $('notifPermissionStatus');
    if (status) {
      const permission = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
      status.textContent = permission === 'granted'
        ? 'Device notifications allowed.'
        : permission === 'denied'
          ? 'Device notifications blocked in browser settings — in-app toasts still work.'
          : 'In-app toasts are on. Allow device notifications for background reminders.';
    }
    const permBtn = $('notifEnableBtn');
    if (permBtn) {
      permBtn.hidden = typeof Notification === 'undefined' || Notification.permission === 'granted';
    }
  }

  function handleNotifToggle(input) {
    const p = prefs();
    if (!p || !input) return;
    const key = input.getAttribute('data-notif-key');
    if (key === 'enabled') p.enabled = input.checked;
    else if (key) p[key] = input.checked;
    const state = liveState();
    state.localUpdatedAt = Date.now();
    persist(true);
    renderNotificationSettings();
    toast(`${input.checked ? 'Enabled' : 'Disabled'} ${labelForPref(key)}.`, 'info', 2400);
  }

  function labelForPref(key) {
    const labels = {
      enabled: 'notifications',
      belowTarget: 'below-target alerts',
      danger: 'danger-zone alerts',
      classReminder: 'class reminders',
      weekly: 'weekly summary',
      milestones: 'milestone alerts'
    };
    return labels[key] || 'notifications';
  }

  function requestNotificationPermission() {
    if (typeof Notification === 'undefined') {
      toast('This browser does not support device notifications. In-app toasts still work.', 'warning');
      return;
    }
    Notification.requestPermission().then((result) => {
      renderNotificationSettings();
      toast(result === 'granted'
        ? 'Device notifications enabled.'
        : 'Device notifications were not enabled. In-app toasts still work.', result === 'granted' ? 'success' : 'info');
    }).catch(() => {
      toast('Could not request notification permission.', 'error');
    });
  }

  function pushNotification(title, body) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
      new Notification(title, { body, tag: 'attendify-' + title.replace(/\s+/g, '-').toLowerCase() });
    } catch (err) {
      /* Some browsers only allow notifications from a service worker. */
    }
  }

  function alertOnce(key, message, type, title) {
    if (notified.has(key)) return;
    notified.add(key);
    toast(message, type || 'warning', 6000);
    pushNotification(title || 'Attendify', message);
  }

  function checkNotifications() {
    const state = liveState();
    const p = prefs();
    if (!state || !p || p.enabled === false) return;
    if (!state.subjects.length) return;
    const tg = target();

    if (p.belowTarget !== false) {
      state.subjects.forEach((sub) => {
        const st = C.stats(sub, tg);
        if (st.hasData && st.isShort) {
          alertOnce(`below:${sub.id}`, `${sub.name} is at ${st.percentage}% — attend ${st.classesNeeded === null ? 'every remaining class' : st.classesNeeded + ' in a row'} to reach ${tg}%.`, 'warning', 'Attendance below target');
        }
      });
    }

    if (p.danger !== false) {
      state.subjects.forEach((sub) => {
        const st = C.stats(sub, tg);
        if (st.hasData && st.pctNum < tg - 10) {
          alertOnce(`danger:${sub.id}`, `${sub.name} is in the danger zone at ${st.percentage}%.`, 'error', 'Attendance danger zone');
        }
      });
    }

    if (p.classReminder !== false && Array.isArray(state.timetable)) {
      const view = C.upcomingClasses(state.timetable, new Date());
      view.today.filter((entry) => !entry.isPast && entry.minutesUntil !== null && entry.minutesUntil <= 120).forEach((entry) => {
        const sub = state.subjects.find((s) => s.id === entry.subjectId);
        if (!sub) return;
        const st = C.stats(sub, tg);
        if (st.hasData && st.isShort) {
          alertOnce(`before:${entry.id}:${C.todayISO()}`, `${sub.name} starts at ${C.formatTime12(entry.start)} — you are at ${st.percentage}%.`, 'warning', 'Class reminder');
        }
      });
    }

    if (p.milestones !== false) {
      const agg = C.aggregate(state.subjects, tg);
      if (agg.hasData) {
        const bucket = agg.pctNum >= 85 ? 85 : agg.pctNum >= 80 ? 80 : agg.pctNum >= 75 ? 75 : 0;
        if (!p.lastMilestone && bucket) {
          p.lastMilestone = bucket;
          persist();
        } else if (bucket > (p.lastMilestone || 0)) {
          p.lastMilestone = bucket;
          persist();
          toast(`Milestone: overall attendance reached ${bucket}%.`, 'success', 6000);
          pushNotification('Attendance milestone', `You are now at ${bucket}% overall.`);
        }
      }
    }

    if (p.weekly !== false) {
      const weekStart = C.startOfWeekISO(C.todayISO());
      if (p.lastWeeklyISO !== weekStart) {
        const summary = C.ledgerSummary(state, weekStart, C.addDaysISO(weekStart, 6));
        if (summary.total > 0) {
          p.lastWeeklyISO = weekStart;
          persist();
          const weekPct = summary.pctNum === null ? '—' : C.round1(summary.pctNum);
          toast(`This week: ${summary.present} present, ${summary.absent} absent (${weekPct}%).`, 'info', 6000);
          pushNotification('Weekly attendance summary', `${summary.present} present · ${summary.absent} absent · ${weekPct}%.`);
        }
      }
    }
  }

  // ===============================================================
  // 8. Sync queue + conflict resolution
  // ===============================================================
  let pendingConflict = null;
  let pendingImport = null;
  let lastRemoteCheckAt = 0;
  let forceRemoteCheck = false;

  function syncMeta() {
    const state = liveState();
    if (!state) return { pending: false, retries: 0, lastError: '', queuedAt: 0 };
    if (!state.syncMeta || typeof state.syncMeta !== 'object') state.syncMeta = C.sanitizeSyncMeta({});
    return state.syncMeta;
  }

  function renderSyncStatus() {
    const pill = $('syncStatusPill');
    const note = $('syncQueueNote');
    const retry = $('syncRetryBtn');
    const meta = syncMeta();
    const online = typeof navigator === 'undefined' || navigator.onLine !== false;
    const state = liveState();

    let label = 'Not synced yet';
    let tone = 'pill-neutral';
    if (!online) { label = 'Offline'; tone = 'pill-neutral'; }
    else if (meta.pending) { label = 'Pending upload'; tone = 'pill-short'; }
    else if (meta.lastError) { label = 'Sync failed'; tone = 'pill-short'; }
    else if (state && state.lastSyncedAt) { label = 'Synced'; tone = 'pill-safe'; }
    if (pill) {
      pill.textContent = label;
      pill.className = 'criteria-pill ' + tone;
    }
    if (note) {
      note.textContent = !online
        ? 'You are offline. Every change is saved on this device and uploads automatically when the connection returns.'
        : meta.pending
          ? `Queued ${meta.queuedAt ? 'at ' + new Date(meta.queuedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'changes'} — will retry automatically.`
          : meta.lastError
            ? `Last attempt failed: ${meta.lastError}`
            : state && state.lastSyncedAt
              ? `Last synced ${new Date(state.lastSyncedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.`
              : 'Cloud backup starts once you add a subject.';
    }
    if (retry) retry.hidden = !(meta.pending || meta.lastError || !online === false && false);
  }

  function markSyncPending(reason) {
    const meta = syncMeta();
    meta.pending = true;
    meta.queuedAt = Date.now();
    if (reason) meta.lastError = reason;
    persist();
    renderSyncStatus();
  }

  function clearSyncPending() {
    const meta = syncMeta();
    meta.pending = false;
    meta.lastError = '';
    meta.retries = 0;
    persist();
    renderSyncStatus();
  }

  /**
   * Pull first, then push, so a second device writing to the same code is
   * never overwritten silently. The remote probe is throttled because the
   * app pushes on every save.
   */
  function installSyncGuard() {
    if (typeof window.syncToCloudStorage !== 'function' || window.syncToCloudStorage.__attendifyGuarded) return;
    const original = window.syncToCloudStorage;

    const guarded = function () {
      const state = liveState();
      const meta = syncMeta();
      if (!state) return original.apply(this, arguments);

      if (typeof navigator !== 'undefined' && navigator.onLine === false) {
        markSyncPending('Offline');
        return Promise.resolve({ ok: false, queued: true, error: 'offline' });
      }
      if (!state.syncCode || !state.syncAuthKey || !state.isSetupCompleted || !state.subjects.length) {
        return original.apply(this, arguments);
      }

      const shouldProbe = forceRemoteCheck || (Date.now() - lastRemoteCheckAt > 120000);
      forceRemoteCheck = false;
      if (!shouldProbe) return original.apply(this, arguments);

      return (async () => {
        try {
          const response = await syncApiRequest('/pull', {
            sync_code: state.syncCode,
            auth_token: state.syncAuthKey
          });
          lastRemoteCheckAt = Date.now();
          if (response.ok) {
            const json = await response.json().catch(() => ({}));
            const decision = C.decideSync(state, {
              hasRemote: true,
              data: json.data,
              updatedAt: (json.data && Date.parse(json.data.lastUpdated)) || Date.parse(json.updated_at || json.lastUpdated || '') || 0
            });
            if (decision.action === 'conflict') {
              openSyncConflict(json.data);
              return { ok: false, conflict: true };
            }
          }
        } catch (err) {
          /* Offline or server unreachable: fall through to a normal push attempt. */
        }
        const result = await original.apply(this, arguments);
        if (result && result.ok) clearSyncPending();
        else if (result && !result.busy) markSyncPending((result && result.error) || 'Sync failed');
        return result;
      })();
    };
    guarded.__attendifyGuarded = true;
    window.syncToCloudStorage = guarded;
  }

  function openSyncConflict(remoteData) {
    const state = liveState();
    if (!state) return;
    pendingConflict = remoteData;
    const summary = $('syncConflictSummary');
    if (summary) {
      let remoteSubjects = 0;
      try {
        remoteSubjects = C.sanitizeState(remoteData).subjects.length;
      } catch (err) {
        remoteSubjects = 0;
      }
      const remoteUpdated = (remoteData && Date.parse(remoteData.lastUpdated)) || 0;
      summary.textContent = `The cloud backup has ${remoteSubjects} subjects and was updated ${
        remoteUpdated ? new Date(remoteUpdated).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'recently'
      }. This device has ${state.subjects.length}. Nothing has been overwritten.`;
    }
    const modal = $('syncConflictModal');
    if (modal) modal.classList.add('open');
    else toast('Cloud backup differs from this device. Open Settings → Cloud sync to resolve it.', 'warning', 8000);
  }

  function resolveSyncConflict(mode) {
    const state = liveState();
    if (!state) return;
    const remote = pendingConflict;
    pendingConflict = null;
    const modal = $('syncConflictModal');
    if (modal) modal.classList.remove('open');

    if (mode === 'local') {
      forceRemoteCheck = false;
      lastRemoteCheckAt = Date.now() + 600000;
      const doPush = window.syncToCloudStorage;
      if (typeof doPush === 'function') doPush();
      toast('Keeping this device. Uploading it as the cloud backup.', 'success');
      return;
    }
    if (!remote) return;

    if (mode === 'merge') {
      try {
        const merged = C.mergeStates(state, remote);
        const creds = { syncCode: state.syncCode, syncAuthKey: state.syncAuthKey, accountEmail: state.accountEmail, authChoice: state.authChoice };
        appState = merged.state;
        appState.syncCode = creds.syncCode;
        appState.syncAuthKey = creds.syncAuthKey;
        appState.accountEmail = creds.accountEmail;
        appState.authChoice = creds.authChoice;
        appState.isSetupCompleted = true;
        persist(false);
        if (typeof renderApp === 'function') renderApp();
        renderAll();
        toast(`Merged both copies: +${merged.added.subjects} subjects, +${merged.added.history} log entries.`, 'success', 6000);
      } catch (err) {
        toast('Could not merge the cloud backup: ' + err.message, 'error');
      }
      return;
    }

    // mode === 'remote'
    try {
      const restored = C.sanitizeState(remote);
      const email = state.accountEmail;
      const choice = state.authChoice;
      appState = restored;
      appState.accountEmail = restored.accountEmail || email;
      appState.authChoice = restored.authChoice || choice || 'guest';
      appState.syncCode = state.syncCode;
      appState.syncAuthKey = state.syncAuthKey;
      appState.lastSyncedAt = Date.now();
      appState.isSetupCompleted = true;
      persist(false);
      if (typeof applyThemeUI === 'function') applyThemeUI(appState.activeTheme || 'graphite');
      if (typeof renderApp === 'function') renderApp();
      renderAll();
      toast(`Restored the cloud copy (${appState.subjects.length} subjects).`, 'success');
    } catch (err) {
      toast('The cloud backup could not be validated: ' + err.message, 'error');
    }
  }

  function retrySync() {
    if (!syncMeta().pending && !syncMeta().lastError) {
      toast('Everything is already synced.', 'info', 2400);
      return;
    }
    forceRemoteCheck = true;
    const sync = window.syncToCloudStorage;
    if (typeof sync !== 'function') return;
    toast('Retrying cloud sync…', 'info', 2000);
    Promise.resolve(sync()).then((res) => {
      if (res && res.ok) {
        clearSyncPending();
        toast('Cloud sync succeeded.', 'success');
      } else if (res && res.conflict) {
        renderSyncStatus();
      } else if (res && !res.busy && !res.queued) {
        const meta = syncMeta();
        meta.retries = (meta.retries || 0) + 1;
        persist();
        renderSyncStatus();
        toast('Sync still failing. Your data stays safe on this device.', 'warning');
      }
    }).catch(() => {});
  }

  // ===============================================================
  // 9. Backup export + imports
  // ===============================================================
  function installExportWrapper() {
    if (typeof window.exportData !== 'function' || window.exportData.__attendifyGuarded) return;
    const original = window.exportData;
    const wrapped = function () {
      const state = liveState();
      if (!state) return original.apply(this, arguments);
      const payload = {
        app: 'Attendify',
        version: C.VERSION,
        exportDate: new Date().toISOString(),
        globalTarget: state.globalTarget,
        activeTheme: state.activeTheme,
        themeMode: state.themeMode,
        privacyMode: state.privacyMode,
        studentName: state.studentName,
        subjects: state.subjects,
        calendar: state.calendar,
        history: state.history,
        timetable: state.timetable || [],
        notifPrefs: state.notifPrefs || {},
        simScenarios: state.simScenarios || []
      };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `attendify_backup_${C.todayISO()}.json`;
      link.click();
      URL.revokeObjectURL(link.href);
      toast('Backup downloaded (subjects, logs, calendar, timetable and preferences).', 'success');
    };
    wrapped.__attendifyGuarded = true;
    window.exportData = wrapped;
  }

  function installImportWrapper() {
    if (typeof window.importData !== 'function' || window.importData.__attendifyGuarded) return;
    const wrapped = function (event) {
      const input = event && event.target;
      const file = input && input.files && input.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) {
        toast('File is larger than the 5 MB limit.', 'error');
        input.value = '';
        return;
      }
      if (/\.csv$/i.test(file.name)) {
        input.value = '';
        importCsvFile(file);
        return;
      }
      input.value = '';
      importJsonFile(file);
    };
    wrapped.__attendifyGuarded = true;
    window.importData = wrapped;
  }

  function applyIncomingStates(incoming, mode, sourceLabel) {
    const state = liveState();
    if (!state) return;
    try {
      if (mode === 'merge') {
        const merged = C.mergeStates(state, incoming);
        const creds = { syncCode: state.syncCode, syncAuthKey: state.syncAuthKey, accountEmail: state.accountEmail, authChoice: state.authChoice };
        appState = merged.state;
        appState.syncCode = creds.syncCode;
        appState.syncAuthKey = creds.syncAuthKey;
        appState.accountEmail = creds.accountEmail;
        appState.authChoice = creds.authChoice;
        appState.isSetupCompleted = true;
        persist(true);
        if (typeof renderApp === 'function') renderApp();
        renderAll();
        toast(`Merged ${sourceLabel}: ${merged.added.subjects} subjects added, ${merged.added.history} log entries added.`, 'success', 6000);
      } else {
        const restored = C.sanitizeState(incoming);
        const creds = { syncCode: state.syncCode, syncAuthKey: state.syncAuthKey, accountEmail: state.accountEmail, authChoice: state.authChoice, studentName: state.studentName };
        appState = restored;
        appState.syncCode = creds.syncCode;
        appState.syncAuthKey = creds.syncAuthKey;
        appState.accountEmail = restored.accountEmail || creds.accountEmail;
        appState.authChoice = appState.accountEmail ? 'account' : (restored.authChoice || creds.authChoice || 'guest');
        appState.isSetupCompleted = true;
        appState.studentName = restored.studentName || creds.studentName;
        persist(true);
        if (typeof applyThemeUI === 'function') applyThemeUI(appState.activeTheme || 'graphite');
        if (typeof applyPrivacyModeUI === 'function') applyPrivacyModeUI();
        if (typeof renderApp === 'function') renderApp();
        renderAll();
        toast(`Replaced local data with ${sourceLabel} (${appState.subjects.length} subjects).`, 'success', 6000);
      }
    } catch (err) {
      toast('Import failed: ' + err.message, 'error', 6000);
    }
  }

  function offerMerge(incoming, sourceLabel) {
    const state = liveState();
    if (!state) return;
    const hasLocalData = state.subjects.length > 0 || (state.history || []).length > 0;
    if (!hasLocalData) {
      applyIncomingStates(incoming, 'replace', sourceLabel);
      return;
    }
    pendingImport = { incoming, sourceLabel };
    const summary = $('mergeSummary');
    if (summary) {
      const subjectCount = Array.isArray(incoming.subjects) ? incoming.subjects.length : 0;
      const historyCount = Array.isArray(incoming.history) ? incoming.history.length : 0;
      summary.textContent = `${sourceLabel} has ${subjectCount} subjects and ${historyCount} log entries. This device has ${state.subjects.length} subjects and ${(state.history || []).length} entries.`;
    }
    const modal = $('mergeModal');
    if (modal) modal.classList.add('open');
    else applyIncomingStates(incoming, 'merge', sourceLabel);
  }

  function importJsonFile(file) {
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target.result);
        const validated = C.sanitizeState(parsed);
        if (!validated.subjects.length && !validated.history.length) {
          toast('That backup contains no subjects or attendance records.', 'warning');
          return;
        }
        offerMerge(validated, 'the backup');
      } catch (err) {
        toast('Backup validation failed: ' + err.message, 'error', 6000);
      }
    };
    reader.onerror = () => toast('Could not read that file.', 'error');
    reader.readAsText(file);
  }

  function importCsvFile(file) {
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const subjects = C.csvToSubjects(String(event.target.result), target());
        offerMerge({ subjects, history: [], calendar: {} }, 'the CSV file');
      } catch (err) {
        toast('CSV import failed: ' + err.message, 'error', 6000);
      }
    };
    reader.onerror = () => toast('Could not read that CSV file.', 'error');
    reader.readAsText(file);
  }

  function resolveImport(mode) {
    const modal = $('mergeModal');
    if (modal) modal.classList.remove('open');
    if (!pendingImport) return;
    const { incoming, sourceLabel } = pendingImport;
    pendingImport = null;
    applyIncomingStates(incoming, mode, sourceLabel);
  }

  // ===============================================================
  // Networking banner
  // ===============================================================
  function updateNetworkBanner() {
    const banner = $('offlineBanner');
    if (!banner) return;
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    banner.hidden = !offline;
    renderSyncStatus();
  }

  // ===============================================================
  // Wiring
  // ===============================================================
  function renderAll() {
    renderDashboard();
    renderAnalytics();
    renderTimetable();
    renderCalendarFilter();
    renderNotificationSettings();
    renderSyncStatus();
    renderSimulatorExtras();
  }

  function onTab(tab) {
    if (tab === 'analytics') renderAnalytics();
    if (tab === 'timetable') renderTimetable();
    if (tab === 'calendar') {
      renderCalendarFilter();
      applyCalendarFilter();
    }
    if (tab === 'calculator') renderSimulatorExtras();
    if (tab === 'settings') {
      renderNotificationSettings();
      renderSyncStatus();
    }
  }

  document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action]');
    if (!el) return;
    const action = el.getAttribute('data-action');
    switch (action) {
      case 'ttEdit': editTimetableEntry(el.getAttribute('data-id')); break;
      case 'ttDelete': deleteTimetableEntry(el.getAttribute('data-id')); break;
      case 'ttDuplicate': duplicateTimetableEntry(el.getAttribute('data-id')); break;
      case 'ttMark': markTimetableAttendance(el.getAttribute('data-id'), el.getAttribute('data-status')); break;
      case 'ttHistory': viewTimetableHistory(el.getAttribute('data-id')); break;
      case 'ttPrevWeek': shiftTimetableWeek(-1); break;
      case 'ttNextWeek': shiftTimetableWeek(1); break;
      case 'ttThisWeek': ttWeekOffset = 0; renderTimetable(); break;
      case 'ttCancelEdit': resetTimetableForm(); break;
      case 'simSaveScenario': saveSimScenario(); break;
      case 'simClearScenarios': clearSimScenarios(); break;
      case 'notifEnable': requestNotificationPermission(); break;
      case 'notifTest': checkNotifications(); toast('Reminder check complete. Alerts appear only for real risks.', 'info'); break;
      case 'syncRetry': retrySync(); break;
      case 'syncKeepLocal': resolveSyncConflict('local'); break;
      case 'syncUseRemote': resolveSyncConflict('remote'); break;
      case 'syncMergeBoth': resolveSyncConflict('merge'); break;
      case 'closeSyncConflict': {
        pendingConflict = null;
        const modal = $('syncConflictModal');
        if (modal) modal.classList.remove('open');
        break;
      }
      case 'mergeImport': resolveImport('merge'); break;
      case 'replaceImport': resolveImport('replace'); break;
      case 'closeMergeModal': {
        pendingImport = null;
        const modal = $('mergeModal');
        if (modal) modal.classList.remove('open');
        break;
      }
      default: break;
    }
  });

  document.addEventListener('change', (event) => {
    const targetEl = event.target;
    if (!targetEl) return;
    if (targetEl.id === 'calSubjectFilter') {
      setCalendarFilter(targetEl.value);
      return;
    }
    if (targetEl.matches('[data-notif-key]')) {
      handleNotifToggle(targetEl);
    }
    if (targetEl.id === 'ttRecurrence') syncRecurrenceFields();
  });

  window.addEventListener('online', () => {
    updateNetworkBanner();
    if (syncMeta().pending) {
      setTimeout(() => retrySync(), 1200);
    }
  });
  window.addEventListener('offline', () => {
    markSyncPending('Offline');
    updateNetworkBanner();
  });

  // Wrap the app's calendar renderers so the subject filter survives every
  // re-render (date selection, marking a class, month navigation).
  if (typeof window.renderCalendar === 'function') {
    const originalCalendar = window.renderCalendar;
    window.renderCalendar = function () {
      const result = originalCalendar.apply(this, arguments);
      applyCalendarFilter();
      return result;
    };
  }
  if (typeof window.renderCalendarDateDetail === 'function') {
    const originalDetail = window.renderCalendarDateDetail;
    window.renderCalendarDateDetail = function () {
      const result = originalDetail.apply(this, arguments);
      applyCalendarFilter();
      return result;
    };
  }

  window.AttendifyFeatures = {
    render: renderAll,
    onTab: onTab,
    refreshTimetable: renderTimetable,
    checkNotifications: checkNotifications,
    openSyncConflict: openSyncConflict,
    _state: liveState
  };

  document.addEventListener('DOMContentLoaded', () => {
    installSyncGuard();
    installExportWrapper();
    installImportWrapper();

    const form = $('ttForm');
    if (form) form.addEventListener('submit', handleTimetableSubmit);
    syncRecurrenceFields();

    updateNetworkBanner();
    renderAll();
    setTimeout(checkNotifications, 1500);
    setInterval(() => {
      renderSyncStatus();
      checkNotifications();
    }, 60000);
  });
})();
