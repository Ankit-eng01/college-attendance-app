# -*- coding: utf-8 -*-
"""Add the v3.0 UI: nav entries, dashboard insights, analytics + timetable views,
notification/sync settings cards, conflict/merge modals and the component CSS."""
import io, sys

PATH = 'index.html'

def read(p):
    with io.open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read().replace('\r\n', '\n')

def write(p, s):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(s.replace('\n', '\r\n'))

def insert_before(text, anchor, block, label):
    if text.count(anchor) != 1:
        sys.exit('anchor %s found %d times: %r' % (label, text.count(anchor), anchor[:80]))
    return text.replace(anchor, block + anchor)

def replace_once(text, old, new, label):
    if text.count(old) != 1:
        sys.exit('replace %s found %d times: %r' % (label, text.count(old), old[:80]))
    return text.replace(old, new)

t = read(PATH)

# ---------------------------------------------------------------------------
# 1. CSS layer
# ---------------------------------------------------------------------------
CSS = r'''
    /* ===================================================================
       ATTENDIFY v3 — INSIGHTS, ANALYTICS, TIMETABLE & SYNC SURFACES
       Additive layer. New components only; existing rules stay untouched.
       =================================================================== */
    .nav-inner { grid-template-columns: repeat(6, minmax(0, 1fr)); }
    .bottom-nav .nav-item span { font-size: 9.5px; }

    .kpi-row {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 10px;
      margin-top: 14px;
    }
    .mini-stat {
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding: 15px 16px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 14px;
      min-width: 0;
    }
    .mini-stat-val {
      font-size: 21px;
      font-weight: 800;
      letter-spacing: -0.02em;
      color: var(--text-strong);
      font-variant-numeric: tabular-nums;
    }
    .mini-stat-lbl {
      font-size: 11.5px;
      font-weight: 600;
      color: var(--text-muted);
      line-height: 1.35;
    }
    .tone-success { color: var(--success-text); }
    .tone-danger { color: var(--danger-text); }
    .tone-neutral { color: var(--text-strong); }

    .insight-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
      margin-top: 14px;
    }
    .insight-card {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 18px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--card-shadow);
      min-width: 0;
    }
    .insight-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
    }
    .insight-head h3 {
      margin: 0;
      font-size: 14px;
      font-weight: 700;
      color: var(--text-strong);
      letter-spacing: -0.01em;
    }
    .insight-subhead {
      margin: 10px 0 6px;
      font-size: 12px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-dim);
      font-weight: 700;
    }
    .insight-meta { font-size: 11px; color: var(--text-dim); font-weight: 600; }
    .empty-inline {
      margin: 0;
      font-size: 12.5px;
      line-height: 1.55;
      color: var(--text-muted);
    }
    .link-btn {
      background: none;
      border: none;
      padding: 0;
      font: inherit;
      font-weight: 700;
      color: var(--brand);
      cursor: pointer;
      text-decoration: underline;
      text-underline-offset: 2px;
    }

    .risk-row, .below-row, .recent-row, .upcoming-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 9px 0;
      border-bottom: 1px solid var(--border);
      min-width: 0;
    }
    .risk-row:last-child, .below-row:last-child,
    .recent-row:last-child, .upcoming-row:last-child { border-bottom: none; padding-bottom: 2px; }
    .risk-copy, .recent-copy, .below-copy {
      display: flex;
      flex-direction: column;
      gap: 2px;
      flex: 1 1 auto;
      min-width: 0;
    }
    .risk-name {
      font-size: 13px;
      font-weight: 700;
      color: var(--text-strong);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .risk-meta {
      font-size: 11.5px;
      color: var(--text-muted);
      line-height: 1.4;
    }
    .risk-dot {
      width: 9px;
      height: 9px;
      border-radius: 50%;
      flex: 0 0 auto;
      background: var(--text-dim);
    }
    .risk-safe { background: var(--success); }
    .risk-watch { background: var(--warning, #e0a82e); }
    .risk-danger { background: var(--danger); }
    .risk-none { background: var(--border); }
    .risk-pct {
      font-size: 13px;
      font-weight: 800;
      font-variant-numeric: tabular-nums;
      color: var(--text-strong);
      padding: 3px 8px;
      border-radius: 999px;
      background: var(--bg-input, rgba(255,255,255,0.05));
    }
    .below-badge {
      font-size: 11px;
      font-weight: 700;
      color: var(--danger-text);
      background: var(--danger-soft, rgba(220,60,60,0.14));
      border-radius: 999px;
      padding: 4px 9px;
      white-space: nowrap;
    }
    .recent-badge {
      width: 22px;
      height: 22px;
      border-radius: 7px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 12px;
      font-weight: 800;
      flex: 0 0 auto;
    }
    .recent-badge.is-present { background: var(--success-soft, rgba(24,190,120,0.16)); color: var(--success-text); }
    .recent-badge.is-absent { background: var(--danger-soft, rgba(220,60,60,0.16)); color: var(--danger-text); }
    .upcoming-time {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 1px;
      min-width: 66px;
      font-size: 12px;
      font-weight: 800;
      color: var(--text-strong);
      font-variant-numeric: tabular-nums;
    }

    /* Charts */
    .bar-chart { min-width: 0; }
    .bar-chart-inner {
      display: flex;
      align-items: flex-end;
      gap: 8px;
      height: 150px;
      padding-top: 6px;
    }
    .bar-col {
      flex: 1 1 0;
      min-width: 0;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 5px;
      height: 100%;
    }
    .bar-value { font-size: 10.5px; font-weight: 700; color: var(--text-muted); font-variant-numeric: tabular-nums; }
    .bar-track {
      position: relative;
      flex: 1 1 auto;
      width: 100%;
      max-width: 34px;
      background: var(--bg-input, rgba(255,255,255,0.06));
      border-radius: 7px;
      overflow: hidden;
      display: flex;
      align-items: flex-end;
    }
    .bar-track.wide { max-width: none; height: 8px; border-radius: 999px; }
    .bar-fill {
      display: block;
      width: 100%;
      border-radius: 6px 6px 0 0;
      background: var(--brand);
      transition: height 0.35s var(--ease-out, ease);
    }
    .bar-track.wide .bar-fill { border-radius: 999px; }
    .bar-fill.is-empty { background: transparent; }
    .bar-label {
      font-size: 9.5px;
      color: var(--text-dim);
      font-weight: 600;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }
    .chart-caption { margin: 8px 0 0; font-size: 10.5px; color: var(--text-dim); line-height: 1.45; }

    .subject-bars { display: flex; flex-direction: column; gap: 13px; }
    .subject-bar-row { display: flex; flex-direction: column; gap: 5px; }
    .subject-bar-head { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
    .subject-bar-val { font-size: 12px; font-weight: 800; font-variant-numeric: tabular-nums; }
    .subject-bar-meta {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      font-size: 10.5px;
      color: var(--text-dim);
    }
    .bar-target {
      position: absolute;
      top: -2px;
      bottom: -2px;
      width: 2px;
      background: var(--text-dim);
      opacity: 0.8;
      border-radius: 2px;
    }

    .trend-block {
      display: flex;
      gap: 12px;
      align-items: flex-start;
      padding: 12px 14px;
      border-radius: 12px;
      background: var(--bg-input, rgba(255,255,255,0.05));
      border: 1px solid var(--border);
    }
    .trend-block.is-up { border-color: var(--success-soft, rgba(24,190,120,0.35)); }
    .trend-block.is-down { border-color: var(--danger-soft-strong, rgba(220,60,60,0.4)); }
    .trend-arrow { font-size: 20px; line-height: 1; font-weight: 800; color: var(--text-strong); }
    .trend-block strong { font-size: 13px; color: var(--text-strong); }
    .trend-block p { margin: 3px 0 0; font-size: 11.5px; color: var(--text-muted); line-height: 1.5; }

    .semester-grid {
      display: grid;
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: 14px;
    }
    .semester-grid > div { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
    .semester-grid strong { font-size: 13.5px; color: var(--text-strong); }

    /* Analytics layout */
    .analytics-grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 14px;
      margin: 14px 0;
    }

    /* Timetable */
    .tt-layout {
      display: grid;
      grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr) minmax(0, 1fr);
      gap: 14px;
      margin-top: 14px;
    }
    .tt-layout[hidden] { display: none !important; }
    .tt-form { display: flex; flex-direction: column; gap: 10px; }
    .tt-form .form-group { margin: 0; }
    .tt-time-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
    .tt-form-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
    .form-hint { margin: 0; font-size: 11.5px; color: var(--text-muted); min-height: 1em; }

    .tt-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 0;
      border-bottom: 1px solid var(--border);
      min-width: 0;
    }
    .tt-row:last-child { border-bottom: none; }
    .tt-row.is-now { background: var(--brand-soft, rgba(60,130,250,0.12)); border-radius: 10px; padding: 10px 8px; }
    .tt-time { display: flex; flex-direction: column; gap: 1px; min-width: 78px; font-size: 11.5px; color: var(--text-strong); }
    .tt-actions { display: flex; gap: 5px; flex-wrap: wrap; justify-content: flex-end; }
    .tt-week { display: flex; flex-direction: column; gap: 14px; }
    .tt-day-group { display: flex; flex-direction: column; gap: 2px; }
    .tt-day-title {
      font-size: 10.5px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      font-weight: 700;
      color: var(--brand);
      padding-top: 4px;
    }

    /* Simulator scenarios */
    .sim-compare { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
    .scenario-card {
      display: flex;
      flex-direction: column;
      gap: 3px;
      padding: 13px 14px;
      border: 1px solid var(--border);
      border-radius: 13px;
      background: var(--bg-surface);
    }
    .scenario-card.is-live { border-color: var(--brand); }
    .scenario-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: var(--text-dim); font-weight: 700; }
    .scenario-pct { font-size: 20px; font-weight: 800; font-variant-numeric: tabular-nums; }
    .scenario-note { font-size: 11px; color: var(--text-muted); line-height: 1.4; }
    .scenario-actions { grid-column: 1 / -1; display: flex; gap: 8px; flex-wrap: wrap; }

    /* Calendar filter + summary */
    .cal-filter-row { display: flex; align-items: center; gap: 10px; margin: 4px 0 10px; }
    .cal-filter-row .form-lbl { margin: 0; white-space: nowrap; }
    .cal-filter-select { flex: 1 1 auto; min-width: 0; }
    .cal-summary { margin: 6px 0 2px; font-size: 11.5px; color: var(--text-muted); font-weight: 600; }
    .cal-cell.cal-filter-empty { opacity: 0.45; }
    .cal-dot.dot-none { background: var(--border); }

    /* Notification preferences */
    .notif-list { display: flex; flex-direction: column; gap: 2px; }
    .notif-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 10px 0;
      border-bottom: 1px solid var(--border);
      cursor: pointer;
    }
    .notif-row:last-child { border-bottom: none; }
    .notif-row > span:first-child { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
    .notif-row strong { font-size: 12.5px; color: var(--text-strong); font-weight: 700; }
    .switch {
      appearance: none;
      -webkit-appearance: none;
      width: 40px;
      height: 23px;
      border-radius: 999px;
      background: var(--bg-input, rgba(255,255,255,0.12));
      border: 1px solid var(--border);
      position: relative;
      cursor: pointer;
      flex: 0 0 auto;
      transition: background 0.18s var(--ease-out, ease);
    }
    .switch::after {
      content: "";
      position: absolute;
      top: 2px;
      left: 2px;
      width: 17px;
      height: 17px;
      border-radius: 50%;
      background: var(--text-strong);
      transition: transform 0.18s var(--ease-out, ease);
    }
    .switch:checked { background: var(--brand); border-color: var(--brand); }
    .switch:checked::after { transform: translateX(17px); background: #fff; }
    .switch:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }

    /* Sync status + modals */
    .sync-actions { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
    .modal-choice-list { display: flex; flex-direction: column; gap: 8px; margin-top: 4px; }
    .modal-choice-list .btn-primary, .modal-choice-list .btn-quiet { width: 100%; justify-content: center; }
    .modal-copy { margin: 0; font-size: 12.5px; line-height: 1.55; color: var(--text-muted); }

    /* Offline banner */
    .offline-banner {
      position: fixed;
      left: 50%;
      transform: translateX(-50%);
      top: calc(8px + var(--safe-top, 0px));
      z-index: 90;
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 14px;
      border-radius: 999px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      box-shadow: var(--card-shadow);
      font-size: 11.5px;
      font-weight: 700;
      color: var(--text-strong);
      max-width: calc(100vw - 24px);
    }
    .offline-banner[hidden] { display: none !important; }

    /* Loading skeleton for the subject list before first paint */
    #subjectsList:empty {
      min-height: 168px;
      border-radius: var(--radius-lg);
      background-image: linear-gradient(100deg,
        var(--bg-surface) 20%, var(--bg-input, rgba(255,255,255,0.07)) 42%, var(--bg-surface) 64%);
      background-size: 220% 100%;
      animation: attendifyShimmer 1.35s linear infinite;
      border: 1px solid var(--border);
    }
    @keyframes attendifyShimmer {
      0% { background-position: 140% 0; }
      100% { background-position: -40% 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      #subjectsList:empty { animation: none; }
      .bar-fill { transition: none; }
    }

    @media (max-width: 1100px) {
      .tt-layout { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .tt-layout > .insight-card:first-child { grid-column: 1 / -1; }
    }
    @media (max-width: 900px) {
      .insight-grid, .analytics-grid { grid-template-columns: minmax(0, 1fr); }
      .kpi-row { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .semester-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .sim-compare { grid-template-columns: minmax(0, 1fr); }
    }
    @media (max-width: 760px) {
      .tt-layout { grid-template-columns: minmax(0, 1fr); }
      .tt-layout > .insight-card:first-child { grid-column: auto; }
      .insight-card { padding: 15px; }
      .bar-chart-inner { height: 132px; gap: 5px; }
      .bar-col:nth-child(even) .bar-label { visibility: hidden; }
      .bottom-nav .nav-item { padding: 5px 1px; }
      .bottom-nav .nav-item span { font-size: 8.5px; letter-spacing: -0.01em; }
      .modal-choice-list { gap: 7px; }
    }
'''

t = insert_before(t, '  </style>\n</head>', CSS, 'css')

# ---------------------------------------------------------------------------
# 2. Navigation entries
# ---------------------------------------------------------------------------
SIDEBAR_NAV = '''          <button type="button" class="nav-item sidebar-link" data-action="switchTab" data-tab="analytics">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 3v18h18"></path>
              <rect x="7" y="12" width="3" height="6"></rect>
              <rect x="12" y="8" width="3" height="10"></rect>
              <rect x="17" y="4" width="3" height="14"></rect>
            </svg>
            <span>Analytics</span>
          </button>
          <button type="button" class="nav-item sidebar-link" data-action="switchTab" data-tab="timetable">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="9"></circle>
              <path d="M12 7v5l3 2"></path>
            </svg>
            <span>Timetable</span>
          </button>
'''
t = insert_before(
    t,
    '          <button type="button" class="nav-item sidebar-link" data-action="switchTab" data-tab="settings">',
    SIDEBAR_NAV, 'sidebar nav')

BOTTOM_NAV = '''      <button type="button" class="nav-item" data-action="switchTab" data-tab="analytics">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 3v18h18"></path>
          <rect x="7" y="12" width="3" height="6"></rect>
          <rect x="12" y="8" width="3" height="10"></rect>
          <rect x="17" y="4" width="3" height="14"></rect>
        </svg>
        <span>Analytics</span>
      </button>

      <button type="button" class="nav-item" data-action="switchTab" data-tab="timetable">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9"></circle>
          <path d="M12 7v5l3 2"></path>
        </svg>
        <span>Timetable</span>
      </button>

'''
t = insert_before(
    t,
    '      <button type="button" class="nav-item" data-action="switchTab" data-tab="settings">',
    BOTTOM_NAV, 'bottom nav')
t = replace_once(t, '<!-- BOTTOM NAVIGATION BAR (Dashboard, Calendar, Simulator, Settings) -->',
                 '<!-- BOTTOM NAVIGATION BAR (Dashboard, Calendar, Simulator, Analytics, Timetable, Settings) -->',
                 'bottom nav comment')

# ---------------------------------------------------------------------------
# 3. Dashboard insight cards
# ---------------------------------------------------------------------------
DASH = '''      <div class="kpi-row" id="dashKpiRow" aria-label="Semester totals">
        <div class="mini-stat"><span class="mini-stat-val" id="miniSubjects">0</span><span class="mini-stat-lbl">Subjects tracked</span></div>
        <div class="mini-stat"><span class="mini-stat-val" id="miniSafeBunks">—</span><span class="mini-stat-lbl">Safe bunks left</span></div>
        <div class="mini-stat"><span class="mini-stat-val" id="miniNeeded">—</span><span class="mini-stat-lbl">Classes to reach target</span></div>
        <div class="mini-stat"><span class="mini-stat-val" id="miniRisk">0</span><span class="mini-stat-lbl">Subjects at risk</span></div>
      </div>

      <div class="insight-grid">
        <div class="insight-card">
          <div class="insight-head">
            <h3>Attendance risk</h3>
            <span class="criteria-pill pill-neutral" id="riskCountPill">0</span>
          </div>
          <div id="dashRiskList"></div>
        </div>

        <div class="insight-card">
          <div class="insight-head">
            <h3>Below target</h3>
            <button type="button" class="link-btn" data-action="openTargetModal">Target <span id="dashTargetLabel">75%</span></button>
          </div>
          <div id="dashBelowList"></div>
        </div>

        <div class="insight-card">
          <div class="insight-head">
            <h3>Recent activity</h3>
            <button type="button" class="link-btn" data-action="switchTab" data-tab="calendar">Open calendar</button>
          </div>
          <div id="dashRecentList"></div>
        </div>

        <div class="insight-card">
          <div class="insight-head">
            <h3>Upcoming classes</h3>
            <button type="button" class="link-btn" data-action="switchTab" data-tab="timetable">Manage timetable</button>
          </div>
          <div id="dashUpcomingList"></div>
        </div>
      </div>

'''
t = insert_before(t, '      <!-- FILTER CHIPS ROW -->', DASH, 'dashboard insights')

# ---------------------------------------------------------------------------
# 4. Calendar filter + day summary
# ---------------------------------------------------------------------------
CAL_FILTER = '''          <div class="cal-filter-row">
            <label class="form-lbl" for="calSubjectFilter">Subject</label>
            <select id="calSubjectFilter" class="form-sel cal-filter-select" aria-label="Filter calendar by subject">
              <option value="all">All subjects</option>
            </select>
          </div>

'''
t = insert_before(t, '          <div class="cal-grid-weekdays" aria-hidden="true">', CAL_FILTER, 'calendar filter')
t = insert_before(
    t,
    '          <div id="calDailySubjectsList" style="display:flex; flex-direction:column; gap:8px;"></div>',
    '          <p class="cal-summary" id="calDaySummary" role="status" aria-live="polite"></p>\n',
    'calendar summary')

# ---------------------------------------------------------------------------
# 5. Analytics + timetable views
# ---------------------------------------------------------------------------
VIEWS = '''    <!-- TAB: SMART ANALYTICS -->
    <section id="viewAnalytics" class="view-content">

      <div class="page-heading">
        <div>
          <p class="eyebrow">Analytics</p>
          <h2 class="page-title">Attendance analytics</h2>
          <p class="page-sub">Weekly and monthly trends, subject comparison, and the semester report — all from your own records.</p>
        </div>
      </div>

      <div id="anaEmpty" class="subjects-empty-state" style="display:none;" role="region" aria-label="No analytics data yet">
        <div class="subjects-empty-inner">
          <div class="subjects-empty-icon" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <path d="M3 3v18h18"></path>
              <rect x="7" y="12" width="3" height="6"></rect>
              <rect x="12" y="8" width="3" height="10"></rect>
              <rect x="17" y="4" width="3" height="14"></rect>
            </svg>
          </div>
          <div class="subjects-empty-copy">
            <p class="subjects-empty-title">No attendance history yet</p>
            <p class="subjects-empty-text">Charts appear as soon as you mark a class present or absent. Analytics never uses placeholder data.</p>
          </div>
          <button type="button" class="btn-primary subjects-empty-cta" data-action="switchTab" data-tab="calendar">
            Log attendance in the calendar
          </button>
        </div>
      </div>

      <div id="anaContent">
        <div class="kpi-row" id="anaKpis" aria-live="polite"></div>

        <div class="analytics-grid">
          <div class="insight-card">
            <div class="insight-head"><h3>Weekly attendance</h3><span class="insight-meta" id="anaWeeklyNote"></span></div>
            <div id="anaWeeklyChart" class="bar-chart" role="group" aria-label="Weekly attendance chart"></div>
          </div>

          <div class="insight-card">
            <div class="insight-head"><h3>Monthly attendance</h3><span class="insight-meta">Last 6 months</span></div>
            <div id="anaMonthlyChart" class="bar-chart" role="group" aria-label="Monthly attendance chart"></div>
          </div>

          <div class="insight-card">
            <div class="insight-head"><h3>Subject comparison</h3><span class="insight-meta">Lowest first</span></div>
            <div id="anaSubjectBars" class="subject-bars"></div>
          </div>

          <div class="insight-card">
            <div class="insight-head"><h3>Improvement trend</h3><span class="insight-meta">4-week windows</span></div>
            <div id="anaTrend"></div>
            <div id="anaAtRisk"></div>
          </div>
        </div>

        <div class="insight-card">
          <div class="insight-head"><h3>Semester report</h3><span class="insight-meta">Live from your records</span></div>
          <div id="anaSemester"></div>
        </div>
      </div>

    </section>

    <!-- TAB: WEEKLY TIMETABLE -->
    <section id="viewTimetable" class="view-content">

      <div class="page-heading">
        <div>
          <p class="eyebrow">Timetable</p>
          <h2 class="page-title">Weekly timetable</h2>
          <p class="page-sub">Add your weekly classes, then mark today&rsquo;s attendance in one tap.</p>
        </div>
      </div>

      <div id="ttEmpty" class="subjects-empty-state" style="display:none;" role="region" aria-label="No subjects for the timetable">
        <div class="subjects-empty-inner">
          <div class="subjects-empty-icon" aria-hidden="true">
            <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2"></path>
            </svg>
          </div>
          <div class="subjects-empty-copy">
            <p class="subjects-empty-title">Add subjects first</p>
            <p class="subjects-empty-text">Timetable classes are linked to your subjects so attendance stays consistent.</p>
          </div>
          <button type="button" class="btn-primary subjects-empty-cta" data-action="openAddSingleModal">Add a subject</button>
        </div>
      </div>

      <div id="ttBody" class="tt-layout">
        <div class="insight-card">
          <div class="insight-head"><h3 id="ttFormTitle">Add a class</h3><span class="insight-meta">Repeat weekly</span></div>
          <form id="ttForm" class="tt-form" novalidate>
            <input type="hidden" id="ttEditId">
            <div class="form-group">
              <label class="form-lbl" for="ttSubject">Subject</label>
              <select id="ttSubject" class="form-sel" required></select>
            </div>
            <div class="form-group">
              <label class="form-lbl" for="ttDay">Weekday</label>
              <select id="ttDay" class="form-sel">
                <option value="1">Monday</option>
                <option value="2">Tuesday</option>
                <option value="3">Wednesday</option>
                <option value="4">Thursday</option>
                <option value="5">Friday</option>
                <option value="6">Saturday</option>
                <option value="0">Sunday</option>
              </select>
            </div>
            <div class="tt-time-grid">
              <div class="form-group">
                <label class="form-lbl" for="ttStart">Start time</label>
                <input type="time" id="ttStart" class="form-inp" required>
              </div>
              <div class="form-group">
                <label class="form-lbl" for="ttEnd">End time</label>
                <input type="time" id="ttEnd" class="form-inp">
              </div>
            </div>
            <div class="form-group">
              <label class="form-lbl" for="ttRoom">Room number</label>
              <input type="text" id="ttRoom" class="form-inp" maxlength="40" placeholder="e.g. B-204" autocomplete="off">
            </div>
            <div class="form-group">
              <label class="form-lbl" for="ttFaculty">Faculty name</label>
              <input type="text" id="ttFaculty" class="form-inp" maxlength="60" placeholder="e.g. Dr. Rao" autocomplete="off">
            </div>
            <div class="tt-form-actions">
              <button type="submit" class="btn-primary">Save class</button>
              <button type="button" class="btn-quiet" id="ttCancelEdit" data-action="ttCancelEdit" hidden>Cancel edit</button>
            </div>
            <p class="form-hint" id="ttFormMsg" role="status" aria-live="polite"></p>
          </form>
        </div>

        <div class="insight-card">
          <div class="insight-head"><h3>Today</h3><span class="insight-meta">Local time</span></div>
          <div id="ttToday"></div>
        </div>

        <div class="insight-card">
          <div class="insight-head"><h3>Upcoming</h3><span class="insight-meta">Next 7 days</span></div>
          <div id="ttUpcoming"></div>
        </div>
      </div>

      <div class="insight-card" id="ttWeekCard" style="margin-top:14px;">
        <div class="insight-head"><h3>Weekly timetable</h3><span class="insight-meta">Edit or delete any class</span></div>
        <div id="ttWeek" class="tt-week"></div>
      </div>

    </section>

'''
t = insert_before(t, '    <!-- TAB 4: SETTINGS, ACCOUNT, CLOUD & DATA -->', VIEWS, 'analytics/timetable views')

# ---------------------------------------------------------------------------
# 6. Settings: notifications + sync status
# ---------------------------------------------------------------------------
SETTINGS = '''        <!-- NOTIFICATIONS & REMINDERS -->
        <div class="settings-card">
          <div class="settings-card-head">
            <div class="settings-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>
            </div>
            <div class="settings-head-copy">
              <h2>Notifications &amp; reminders</h2>
              <p>Optional alerts computed on this device from your real attendance. Nothing is sent to a server.</p>
            </div>
            <span class="criteria-pill pill-neutral">Optional</span>
          </div>

          <div class="notif-list">
            <label class="notif-row">
              <span><strong>All reminders</strong><span class="risk-meta">Master switch for every alert below</span></span>
              <input type="checkbox" class="switch" id="notifEnabled" data-notif-key="enabled" role="switch">
            </label>
            <label class="notif-row">
              <span><strong>Below-target alerts</strong><span class="risk-meta">When a subject drops under your target</span></span>
              <input type="checkbox" class="switch" data-notif-key="belowTarget" role="switch">
            </label>
            <label class="notif-row">
              <span><strong>Danger-zone alerts</strong><span class="risk-meta">When attendance is 10+ points under target</span></span>
              <input type="checkbox" class="switch" data-notif-key="danger" role="switch">
            </label>
            <label class="notif-row">
              <span><strong>Before-class reminder</strong><span class="risk-meta">Warns about a class when that subject is short</span></span>
              <input type="checkbox" class="switch" data-notif-key="classReminder" role="switch">
            </label>
            <label class="notif-row">
              <span><strong>Weekly summary</strong><span class="risk-meta">Present / absent recap for the current week</span></span>
              <input type="checkbox" class="switch" data-notif-key="weekly" role="switch">
            </label>
            <label class="notif-row">
              <span><strong>Milestones</strong><span class="risk-meta">Celebrate 75%, 80% and 85% overall</span></span>
              <input type="checkbox" class="switch" data-notif-key="milestones" role="switch">
            </label>
          </div>

          <p class="form-hint" id="notifPermissionStatus" role="status"></p>
          <div class="tt-form-actions">
            <button type="button" class="btn-quiet" id="notifEnableBtn" data-action="notifEnable" hidden>Allow device notifications</button>
            <button type="button" class="btn-quiet" data-action="notifTest">Run check now</button>
          </div>
        </div>

        <!-- CLOUD SYNC STATUS -->
        <div class="settings-card">
          <div class="settings-card-head">
            <div class="settings-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.5 19a4.5 4.5 0 0 0 .5-8.97A6 6 0 0 0 6.2 10.2 4 4 0 0 0 7 18h10.5Z"></path><path d="M12 12v5"></path><path d="m9.5 14.5 2.5-2.5 2.5 2.5"></path></svg>
            </div>
            <div class="settings-head-copy">
              <h2>Cloud sync status</h2>
              <p>Queued changes retry automatically. Conflicts are never resolved without asking you.</p>
            </div>
            <span class="criteria-pill pill-neutral" id="syncStatusPill">Not synced yet</span>
          </div>

          <p class="risk-meta" id="syncQueueNote" role="status" aria-live="polite"></p>
          <div class="sync-actions">
            <button type="button" class="btn-quiet" data-action="triggerManualSync">Sync now</button>
            <button type="button" class="btn-quiet" id="syncRetryBtn" data-action="syncRetry" hidden>Retry queued changes</button>
          </div>
        </div>

'''
t = insert_before(t, '        <!-- 5. DATA MANAGEMENT -->', SETTINGS, 'settings cards')

# Import accepts CSV too.
t = replace_once(t, '<span>Import &amp; validate backup</span>',
                 '<span>Import backup (JSON) or subjects (CSV)</span>', 'import label')
t = replace_once(t, '<input type="file" id="importFileInput" accept=".json" style="display:none;">',
                 '<input type="file" id="importFileInput" accept=".json,.csv,application/json,text/csv" style="display:none;">',
                 'import accept')

# ---------------------------------------------------------------------------
# 7. Modals + offline banner
# ---------------------------------------------------------------------------
MODALS = '''  <!-- OFFLINE INDICATOR -->
  <div id="offlineBanner" class="offline-banner" role="status" aria-live="polite" hidden>
    <span class="pill-dot dot-green" aria-hidden="true"></span>
    Offline — changes are saved on this device and will sync later.
  </div>

  <!-- SYNC CONFLICT RESOLUTION -->
  <div id="syncConflictModal" class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="syncConflictTitle">
    <div class="modal-sheet">
      <div class="sheet-handle"></div>
      <div class="sheet-title">
        <span id="syncConflictTitle">Cloud backup conflict</span>
        <button type="button" class="close-btn" data-action="closeSyncConflict" aria-label="Close">✕</button>
      </div>
      <p class="modal-copy">Another device changed this sync code after your last sync. Your local data has <strong>not</strong> been overwritten.</p>
      <p class="modal-copy" id="syncConflictSummary"></p>
      <div class="modal-choice-list">
        <button type="button" class="btn-primary" data-action="syncMergeBoth">Merge both copies (keep everything)</button>
        <button type="button" class="btn-quiet" data-action="syncUseRemote">Use the cloud copy on this device</button>
        <button type="button" class="btn-quiet" data-action="syncKeepLocal">Keep this device and overwrite the cloud</button>
        <button type="button" class="btn-quiet" data-action="closeSyncConflict">Decide later</button>
      </div>
    </div>
  </div>

  <!-- IMPORT: MERGE OR REPLACE -->
  <div id="mergeModal" class="modal-backdrop" role="dialog" aria-modal="true" aria-labelledby="mergeTitle">
    <div class="modal-sheet">
      <div class="sheet-handle"></div>
      <div class="sheet-title">
        <span id="mergeTitle">Import data</span>
        <button type="button" class="close-btn" data-action="closeMergeModal" aria-label="Close">✕</button>
      </div>
      <p class="modal-copy">This device already has attendance data. Choose how to apply the file — nothing is replaced until you pick an option.</p>
      <p class="modal-copy" id="mergeSummary"></p>
      <div class="modal-choice-list">
        <button type="button" class="btn-primary" data-action="mergeImport">Merge into my data (recommended)</button>
        <button type="button" class="btn-quiet" data-action="replaceImport">Replace all data on this device</button>
        <button type="button" class="btn-quiet" data-action="closeMergeModal">Cancel</button>
      </div>
    </div>
  </div>

'''
t = insert_before(t, '  <!-- GLOBAL TOAST NOTIFICATIONS -->', MODALS, 'modals')

# ---------------------------------------------------------------------------
# 8. Scripts
# ---------------------------------------------------------------------------
t = replace_once(t, '  <script src="app.js?v=20261127r11" defer></script>',
                 '  <script src="calc.js?v=20261127r12" defer></script>\n'
                 '  <script src="app.js?v=20261127r12" defer></script>\n'
                 '  <script src="features.js?v=20261127r12" defer></script>',
                 'scripts')

write(PATH, t)
print('index.html patched')
