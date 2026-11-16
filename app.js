
    // -------------------------------------------------------------
    // ATTENDIFY CORE ENGINE (SECURITY & PRIVACY HARDENED)
    // -------------------------------------------------------------

    const STORAGE_KEY = 'attendify_state_v6';

    // 1. SECURITY & SANITIZATION UTILITIES (XSS PREVENTION)
    function escapeHtml(str) {
      if (str == null) return '';
      return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    }

    function sanitizeText(str) {
      if (typeof str !== 'string') return '';
      return str.replace(/<[^>]*>?/gm, '').trim();
    }

    function getTodayDateStr() {
      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      const d = String(now.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }

    function getDefaultState() {
      return {
        isSetupCompleted: false,
        studentName: '',
        syncCode: generateSyncCode(),
        syncAuthKey: generateAuthToken(),
        cloudSyncEnabled: true,
        lastSyncedAt: null,
        subjects: [],
        calendar: {},
        history: [],
        globalTarget: 75,
        activeTheme: 'navy-purple',
        privacyMode: false,
        activeCategory: 'all',
        activeTab: 'subjects'
      };
    }

    let appState = loadState();

    // Calendar state
    let calCurrentYear = new Date().getFullYear();
    let calCurrentMonth = new Date().getMonth();
    let calSelectedDate = getTodayDateStr();

    // Subject history drawer state
    let currentHistorySubId = null;

    // Wizard state
    let wizardSubjectCount = 5;

    // Initialization
    window.addEventListener('DOMContentLoaded', () => {
      initDate();
      applyThemeUI(appState.activeTheme || 'navy-purple');
      applyPrivacyModeUI();
      renderApp();
      initServiceWorker();

      // Automatically launch onboarding setup wizard for new users
      if (!appState.isSetupCompleted || !appState.subjects || appState.subjects.length === 0) {
        setTimeout(() => {
          openSetupModal();
        }, 150);
      }
    });

    function initDate() {
      const now = new Date();
      const opts = { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' };
      const el = document.getElementById('topDateStr');
      if (el) el.textContent = now.toLocaleDateString(undefined, opts);
    }

    function loadState() {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return getDefaultState();
        const parsed = JSON.parse(raw);
        const st = validateAndSanitizeState(parsed);
        if (!st.syncCode) st.syncCode = generateSyncCode();
        if (!st.syncAuthKey) st.syncAuthKey = generateAuthToken();
        return st;
      } catch (e) {
        console.warn('Could not parse saved state, fallback to default:', e);
        return getDefaultState();
      }
    }

    function saveState() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
        renderApp();
        if (appState.isSetupCompleted && appState.subjects && appState.subjects.length > 0) {
          queueCloudSync();
        }
      } catch (err) {
        console.error('Failed to save state:', err);
      }
    }

    function saveStateOnly() {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
        renderApp();
      } catch (err) {
        console.error('Failed to save state locally:', err);
      }
    }

    // 2. SECURITY: SCHEMA VALIDATOR FOR IMPORTED & LOADED JSON
    function validateAndSanitizeState(raw) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Root data must be a valid JSON object.');
      }

      // Validate subjects array
      if (!Array.isArray(raw.subjects)) {
        raw.subjects = [];
      }
      if (raw.subjects.length > 50) {
        throw new Error('Subjects count exceeds safe maximum (50).');
      }

      const validCategories = ['theory', 'lab', 'elective', 'tutorial', 'other'];
      const sanitizedSubjects = [];
      const seenIds = new Set();

      raw.subjects.forEach((s, idx) => {
        if (!s || typeof s !== 'object') return;
        let id = typeof s.id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(s.id.trim()) ? s.id.trim() : 'sub_' + (Date.now() + idx);
        if (seenIds.has(id)) id = id + '_' + idx;
        seenIds.add(id);

        let name = sanitizeText(s.name);
        if (!name) name = `Subject ${idx + 1}`;
        if (name.length > 80) name = name.substring(0, 80);

        let category = typeof s.category === 'string' ? s.category.toLowerCase().trim() : 'theory';
        if (!validCategories.includes(category)) category = 'theory';

        let attended = Number.isInteger(s.attended) ? s.attended : parseInt(s.attended);
        if (isNaN(attended) || attended < 0) attended = 0;
        if (attended > 5000) attended = 5000;

        let total = Number.isInteger(s.total) ? s.total : parseInt(s.total);
        if (isNaN(total) || total < attended) total = attended;
        if (total > 5000) total = 5000;

        let target = parseInt(s.target) || 75;
        if (target < 50 || target > 100) target = 75;

        sanitizedSubjects.push({ id, name, category, attended, total, target });
      });

      // Validate calendar object
      const sanitizedCalendar = {};
      if (raw.calendar && typeof raw.calendar === 'object' && !Array.isArray(raw.calendar)) {
        const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;
        const dateKeys = Object.keys(raw.calendar).slice(0, 1000);
        for (const dateKey of dateKeys) {
          if (!isoDateRegex.test(dateKey)) continue;
          const day = raw.calendar[dateKey];
          if (!day || typeof day !== 'object') continue;
          const cleanDay = {
            isHoliday: Boolean(day.isHoliday),
            entries: {}
          };
          if (day.entries && typeof day.entries === 'object') {
            for (const [subId, status] of Object.entries(day.entries)) {
              if (['present', 'absent', 'off', 'none'].includes(status)) {
                cleanDay.entries[escapeHtml(subId.substring(0, 64))] = status;
              }
            }
          }
          sanitizedCalendar[dateKey] = cleanDay;
        }
      }

      // Validate history array
      const sanitizedHistory = [];
      if (Array.isArray(raw.history)) {
        const maxH = Math.min(raw.history.length, 2500);
        const validStatuses = ['present', 'absent', 'off', 'none'];
        for (let i = 0; i < maxH; i++) {
          const h = raw.history[i];
          if (!h || typeof h !== 'object') continue;
          const id = typeof h.id === 'string' ? escapeHtml(h.id.substring(0, 64)) : 'hist_' + i;
          const subId = typeof h.subId === 'string' ? escapeHtml(h.subId.substring(0, 64)) : '';
          const date = typeof h.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(h.date) ? h.date : getTodayDateStr();
          const status = validStatuses.includes(h.status) ? h.status : 'present';
          const timestamp = typeof h.timestamp === 'number' ? h.timestamp : Date.now();
          sanitizedHistory.push({ id, subId, date, status, timestamp });
        }
      }

      let globalTarget = parseInt(raw.globalTarget) || 75;
      if (globalTarget < 50 || globalTarget > 100) globalTarget = 75;

      let activeTheme = typeof raw.activeTheme === 'string' ? raw.activeTheme : 'navy-purple';
      if (!['navy-purple', 'violet', 'amoled'].includes(activeTheme)) activeTheme = 'navy-purple';

      const privacyMode = Boolean(raw.privacyMode);

      // Validate Setup Completion Flag
      const isSetupCompleted = Boolean(raw.isSetupCompleted);

      // Validate Student Name (max 50 chars, sanitized)
      let studentName = '';
      if (typeof raw.studentName === 'string') {
        studentName = sanitizeText(raw.studentName).substring(0, 50);
      }

      // Validate Cloud Sync Code (CSPRNG format: ATN-XXXX-XXXX-XXXX or safe alphanumeric string)
      let syncCode = '';
      if (typeof raw.syncCode === 'string' && /^[a-zA-Z0-9_-]{6,64}$/.test(raw.syncCode.trim())) {
        syncCode = raw.syncCode.trim().toUpperCase();
      }

      // Validate Secret Auth Passkey (CSPRNG 32+ hex chars or safe token string)
      let syncAuthKey = '';
      if (typeof raw.syncAuthKey === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(raw.syncAuthKey.trim())) {
        syncAuthKey = raw.syncAuthKey.trim();
      }

      // Cloud Sync Preference
      const cloudSyncEnabled = raw.cloudSyncEnabled !== false;

      // Last Synced Timestamp
      let lastSyncedAt = null;
      if (typeof raw.lastSyncedAt === 'number' || typeof raw.lastSyncedAt === 'string') {
        lastSyncedAt = raw.lastSyncedAt;
      }

      return {
        isSetupCompleted,
        studentName,
        syncCode,
        syncAuthKey,
        cloudSyncEnabled,
        lastSyncedAt,
        subjects: sanitizedSubjects,
        calendar: sanitizedCalendar,
        history: sanitizedHistory,
        globalTarget,
        activeTheme,
        privacyMode,
        activeCategory: raw.activeCategory || 'all',
        activeTab: raw.activeTab || 'subjects'
      };
    }

    // 3. DISCREET PRIVACY MODE (ANTI-SHOULDER SURFING)
    function togglePrivacyMode() {
      appState.privacyMode = !appState.privacyMode;
      applyPrivacyModeUI();
      saveState();
    }

    function applyPrivacyModeUI() {
      const isPrivate = Boolean(appState.privacyMode);
      document.body.classList.toggle('privacy-active', isPrivate);

      const headerBtn = document.getElementById('privacyToggleBtn');
      if (headerBtn) {
        headerBtn.innerHTML = isPrivate ? '<span>🙈</span>' : '<span>👁️</span>';
        headerBtn.classList.toggle('active', isPrivate);
        headerBtn.title = isPrivate ? 'Discreet Mode Active (Tap to reveal stats)' : 'Discreet Mode Off (Tap to hide stats from peers)';
      }

      const settingsBtn = document.getElementById('settingsPrivacyBtn');
      const settingsText = document.getElementById('settingsPrivacyBtnText');
      if (settingsBtn && settingsText) {
        settingsBtn.classList.toggle('active', isPrivate);
        settingsText.textContent = isPrivate ? 'Turn OFF' : 'Turn ON';
      }
    }

    // 4. THEME CONTROLLER
    function setAppTheme(theme) {
      if (!['navy-purple', 'violet', 'amoled'].includes(theme)) return;
      appState.activeTheme = theme;
      applyThemeUI(theme);
      saveState();
    }

    function applyThemeUI(theme) {
      if (document.documentElement) {
        document.documentElement.setAttribute('data-theme', theme);
      }
      const themeColors = {
        'navy-purple': '#060913',
        'violet': '#090514',
        'amoled': '#000000'
      };
      const themeColorMeta = document.querySelector('meta[name="theme-color"]');
      if (themeColorMeta) themeColorMeta.setAttribute('content', themeColors[theme] || '#060913');

      ['navy-purple', 'violet', 'amoled'].forEach(t => {
        const btn = document.getElementById(`themeBtn_${t}`);
        if (btn) btn.classList.toggle('active', t === theme);
      });
    }

    // 5. MATHEMATICAL FORMULAS FOR 75% ATTENDANCE CRITERIA
    function calcStats(sub) {
      const a = Number(sub.attended) || 0;
      const t = Number(sub.total) || 0;
      const target = Number(sub.target) || appState.globalTarget || 75;
      const missed = Math.max(0, t - a);

      const percentage = t > 0 ? ((a / t) * 100).toFixed(1) : '100.0';
      const pctNum = parseFloat(percentage);
      const isShort = pctNum < target;

      let minNeededToReach75 = 0;
      let maxCanMiss = 0;

      if (isShort) {
        const numerator = (target * t) - (100 * a);
        const denominator = 100 - target;
        minNeededToReach75 = Math.ceil(numerator / denominator);
        if (minNeededToReach75 < 0) minNeededToReach75 = 0;
      } else {
        if (target > 0) {
          const maxAllowedTotal = Math.floor((100 * a) / target);
          maxCanMiss = Math.max(0, maxAllowedTotal - t);
        }
      }

      const shortagePct = isShort ? (target - pctNum).toFixed(1) : '0.0';
      const surplusPct = !isShort ? (pctNum - target).toFixed(1) : '0.0';

      return {
        attended: a,
        total: t,
        missed,
        target,
        percentage,
        pctNum,
        isShort,
        minNeededToReach75,
        maxCanMiss,
        shortagePct,
        surplusPct
      };
    }

    // 6. MAIN RENDER ORCHESTRATOR
    function renderApp() {
      const target = appState.globalTarget || 75;
      const targetLabel = document.getElementById('topTargetVal');
      if (targetLabel) targetLabel.textContent = `${target}%`;
      const settingsTarget = document.getElementById('settingsTargetLabel');
      if (settingsTarget) settingsTarget.textContent = `${target}%`;

      // Update personalized brand greeting
      const brandTitle = document.getElementById('topBrandTitle');
      if (brandTitle) {
        brandTitle.textContent = appState.studentName ? `Hi, ${appState.studentName} 👋` : 'Attendify';
      }

      // Update Settings cloud details
      const nameDisp = document.getElementById('settingsStudentNameDisplay');
      if (nameDisp) nameDisp.textContent = appState.studentName || 'Not Set';
      const syncDisp = document.getElementById('settingsSyncCodeDisplay');
      if (syncDisp) syncDisp.textContent = appState.syncCode || '--';
      const keyDisp = document.getElementById('settingsSyncKeyDisplay');
      if (keyDisp) keyDisp.textContent = isKeyVisible ? (appState.syncAuthKey || 'Not Set') : '••••••••••••••••';
      const lastSyncEl = document.getElementById('settingsLastSyncTime');
      if (lastSyncEl) {
        if (appState.lastSyncedAt) {
          const d = new Date(appState.lastSyncedAt);
          lastSyncEl.textContent = isNaN(d.getTime()) ? 'Recently' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } else {
          lastSyncEl.textContent = 'Not synced yet';
        }
      }

      renderSmartDashboard();
      renderChips();
      renderSubjectAnalyticsList();
      const badge = document.getElementById('subjectCountBadge');
      if (badge) badge.textContent = appState.subjects.length;
    }

    // 7. COMPONENT 1: SMART DASHBOARD
    function renderSmartDashboard() {
      let totalAtt = 0;
      let totalConducted = 0;
      let shortCount = 0;

      appState.subjects.forEach(sub => {
        const a = Number(sub.attended) || 0;
        const t = Number(sub.total) || 0;
        totalAtt += a;
        totalConducted += t;
        if (calcStats(sub).isShort) shortCount++;
      });

      const totalMissed = Math.max(0, totalConducted - totalAtt);
      const overallPctNum = totalConducted > 0 ? (totalAtt / totalConducted) * 100 : 100.0;
      const overallPct = overallPctNum.toFixed(1);
      const target = appState.globalTarget || 75;
      const isOverallShort = overallPctNum < target;

      document.getElementById('dashOverallPct').textContent = `${overallPct}%`;
      document.getElementById('statAttended').textContent = totalAtt;
      document.getElementById('statMissed').textContent = totalMissed;
      document.getElementById('statTotalHeld').textContent = totalConducted;
      document.getElementById('statShortCount').textContent = shortCount;

      // Circular gauge animation
      const circle = document.getElementById('dashGaugeCircle');
      const radius = 40;
      const circumference = 2 * Math.PI * radius; // 251.2
      const offset = circumference - (Math.min(100, Math.max(0, overallPctNum)) / 100) * circumference;
      circle.style.strokeDashoffset = offset;
      circle.style.stroke = isOverallShort ? 'var(--danger)' : 'var(--brand)';

      // Overall criteria pill
      const pillWrap = document.getElementById('dashCriteriaPillWrap');
      if (appState.subjects.length === 0) {
        pillWrap.innerHTML = `<span class="criteria-pill pill-neutral"><span class="pill-dot dot-green"></span> Ready</span>`;
      } else if (isOverallShort) {
        const gap = (target - overallPctNum).toFixed(1);
        pillWrap.innerHTML = `<span class="criteria-pill pill-short"><span class="pill-dot dot-red"></span> Short by ${gap}%</span>`;
      } else {
        const lead = (overallPctNum - target).toFixed(1);
        pillWrap.innerHTML = `<span class="criteria-pill pill-safe"><span class="pill-dot dot-green"></span> +${lead}% Above Target</span>`;
      }

      // Attendance Health Indicator & Action Advice
      const healthTag = document.getElementById('dashHealthTag');
      const adviceEl = document.getElementById('dashAdviceText');
      const alertBar = document.getElementById('dashAlertBanner');

      if (appState.subjects.length === 0) {
        document.getElementById('dashOverallPct').textContent = '--%';
        circle.style.strokeDashoffset = circumference;
        healthTag.textContent = '● Setup Required';
        healthTag.className = 'health-tag health-warning';
        adviceEl.innerHTML = `Tap <strong>Setup</strong> in the top bar to enter your subjects and start tracking.`;
        alertBar.className = 'shortage-banner banner-safe';
        alertBar.style.display = 'flex';
        alertBar.innerHTML = `
          <span>👋</span>
          <div>
            <strong>Welcome to Attendify!</strong> How many subjects do you have this semester?
            <button type="button" class="btn-primary" style="margin-top:8px; padding:6px 14px; font-size:12px;" data-action="openSetupModal">⚡ Setup My Subjects Now</button>
          </div>
        `;
        return;
      }

      if (overallPctNum >= 85) {
        healthTag.textContent = '● A+ • Attendance Master';
        healthTag.className = 'health-tag health-excellent';
      } else if (overallPctNum >= target) {
        healthTag.textContent = '● B+ • Safe & On Track';
        healthTag.className = 'health-tag health-good';
      } else if (overallPctNum >= target - 8) {
        healthTag.textContent = '● C • Borderline Warning';
        healthTag.className = 'health-tag health-warning';
      } else {
        healthTag.textContent = '● Critical Detention Risk';
        healthTag.className = 'health-tag health-danger';
      }

      if (isOverallShort) {
        const needed = Math.ceil(((target * totalConducted) - (100 * totalAtt)) / (100 - target));
        adviceEl.innerHTML = `You are below criteria. Attend next <strong class="privacy-blur" style="color:#f87171;">${Math.max(1, needed)} lectures</strong> consecutively to recover.`;
        alertBar.className = 'shortage-banner banner-danger';
        alertBar.style.display = 'flex';
        alertBar.innerHTML = `
          <span>⚠️</span>
          <div>
            <strong>75% Shortage Alert:</strong> You are currently short of criteria by <span class="privacy-blur">${(target - overallPctNum).toFixed(1)}%</span>.
            Attend <span class="privacy-blur">${needed}</span> consecutive classes without absence to safely clear the threshold.
          </div>
        `;
      } else {
        const allowedTot = Math.floor((100 * totalAtt) / target);
        const bunks = Math.max(0, allowedTot - totalConducted);
        adviceEl.innerHTML = `Safe attendance zone. You can safely miss up to <strong class="privacy-blur" style="color:#34d399;">${bunks} classes</strong>.`;
        alertBar.className = 'shortage-banner banner-safe';
        alertBar.style.display = 'flex';
        alertBar.innerHTML = `
          <span>✓</span>
          <div>
            <strong>Healthy Attendance:</strong> You have a buffer of <span class="privacy-blur">${(overallPctNum - target).toFixed(1)}%</span> over the ${target}% target.
            You can afford to miss <span class="privacy-blur">${bunks} classes</span> safely.
          </div>
        `;
      }
    }

    // 8. FILTER CHIPS
    function renderChips() {
      const row = document.getElementById('filterChipsRow');
      const cats = [
        { id: 'all', label: 'All Courses' },
        { id: 'theory', label: 'Theory' },
        { id: 'lab', label: 'Labs' },
        { id: 'elective', label: 'Electives' },
        { id: 'shortage', label: '⚠️ Below 75%' }
      ];

      row.innerHTML = cats.map(c => `
        <button type="button" class="filter-chip ${appState.activeCategory === c.id ? 'active' : ''}" data-action="filterCategory" data-cat="${escapeHtml(c.id)}">
          ${escapeHtml(c.label)}
        </button>
      `).join('');
    }

    function filterCategory(cat) {
      appState.activeCategory = cat;
      renderChips();
      renderSubjectAnalyticsList(); const badge = document.getElementById('subjectCountBadge'); if(badge) badge.textContent = appState.subjects.length;
    }

    // 9. COMPONENT 2: SUBJECT-WISE ANALYTICS CARDS (XSS ESCAPED)
    function renderSubjectAnalyticsList() {
      const list = document.getElementById('subjectsList');
      const empty = document.getElementById('emptyState');

      const filtered = appState.subjects.filter(s => {
        if (appState.activeCategory === 'all') return true;
        if (appState.activeCategory === 'shortage') return calcStats(s).isShort;
        return (s.category || 'theory') === appState.activeCategory;
      });

      if (filtered.length === 0) {
        list.innerHTML = '';
        empty.style.display = 'block';
        return;
      }

      empty.style.display = 'none';
      let html = '';

      filtered.forEach(sub => {
        const stats = calcStats(sub);
        const cat = sub.category || 'theory';
        const colorVar = stats.isShort ? 'var(--danger)' : 'var(--success)';
        const safeSubName = escapeHtml(sub.name);
        const safeSubId = escapeHtml(sub.id);
        const safeCat = escapeHtml(cat);

        html += `
          <div class="subject-card ${stats.isShort ? 'is-short' : ''}">
            <div class="card-head">
              <div>
                <div class="card-meta">
                  <span class="cat-tag cat-${safeCat}">${safeCat.toUpperCase()}</span>
                  ${stats.isShort ? `
                    <span class="criteria-pill pill-short">
                      <span class="pill-dot dot-red"></span> Short by ${stats.shortagePct}%
                    </span>
                  ` : `
                    <span class="criteria-pill pill-safe">
                      <span class="pill-dot dot-green"></span> +${stats.surplusPct}% Safe
                    </span>
                  `}
                </div>
                <h3 class="card-title">${safeSubName}</h3>
              </div>

              <div class="card-score">
                <span class="score-pct privacy-blur" style="color:${colorVar}">${stats.percentage}%</span>
                <span class="score-ratio privacy-blur">${stats.attended} / ${stats.total} held (${stats.missed} missed)</span>
              </div>
            </div>

            <!-- Analytics Dual-Badges -->
            <div class="card-analytics-row">
              <div class="analytic-chip ${stats.isShort ? 'alert-chip' : ''}">
                <span class="analytic-lbl">Min to reach ${stats.target}%</span>
                <span class="analytic-val ${stats.isShort ? 'text-danger' : 'text-success'} privacy-blur">
                  ${stats.isShort ? `Attend ${stats.minNeededToReach75} in a row` : '0 (Already Safe)'}
                </span>
              </div>

              <div class="analytic-chip ${!stats.isShort ? 'safe-chip' : ''}">
                <span class="analytic-lbl">Max classes you can miss</span>
                <span class="analytic-val ${stats.maxCanMiss > 0 ? 'text-success' : 'text-danger'} privacy-blur">
                  ${stats.maxCanMiss > 0 ? `${stats.maxCanMiss} classes` : '0 bunks left'}
                </span>
              </div>
            </div>

            <!-- Progress bar with 75% target marker -->
            <div class="prog-wrapper">
              <div class="prog-marker-75" style="left:${stats.target}%;" title="${stats.target}% Target"></div>
              <div class="prog-fill" style="width:${Math.min(100, stats.pctNum)}%; background:${colorVar};"></div>
            </div>

            <!-- 1-Tap Attendance Actions + History Drawer Button -->
            <div class="card-actions">
              <button type="button" class="act-btn act-present" data-action="quickMarkToday" data-subid="${safeSubId}" data-status="present" title="Mark present today">
                ✓ Present
              </button>
              <button type="button" class="act-btn act-absent" data-action="quickMarkToday" data-subid="${safeSubId}" data-status="absent" title="Mark absent today">
                ✕ Absent
              </button>
              <button type="button" class="act-btn act-off" data-action="quickMarkToday" data-subid="${safeSubId}" data-status="off" title="Class cancelled / off">
                — Off
              </button>
              <button type="button" class="act-btn act-hist" data-action="openSubjectHistoryDrawer" data-subid="${safeSubId}" title="View attendance history">
                📜 History
              </button>
              <button type="button" class="act-btn act-more" data-action="openSingleEditModal" data-subid="${safeSubId}" title="Edit subject">
                ⋮
              </button>
            </div>
          </div>
        `;
      });

      list.innerHTML = html;
    }

    
    function triggerHaptic(duration = 14) {
      if ('vibrate' in navigator) {
        try { navigator.vibrate(duration); } catch(e) {}
      }
    }

    function quickMarkToday(subId, status) {
      triggerHaptic(18);
      recordAttendanceEntry(getTodayDateStr(), subId, status);
    }

    function recordAttendanceEntry(dateStr, subId, status) {
      if (!appState.calendar[dateStr]) {
        appState.calendar[dateStr] = { isHoliday: false, entries: {} };
      }

      const prevStatus = appState.calendar[dateStr].entries[subId];
      appState.calendar[dateStr].entries[subId] = status;

      const sub = appState.subjects.find(s => s.id === subId);
      if (sub) {
        if (prevStatus === 'present') {
          sub.attended = Math.max(0, (Number(sub.attended) || 0) - 1);
          sub.total = Math.max(0, (Number(sub.total) || 0) - 1);
        } else if (prevStatus === 'absent') {
          sub.total = Math.max(0, (Number(sub.total) || 0) - 1);
        }

        if (status === 'present') {
          sub.attended = (Number(sub.attended) || 0) + 1;
          sub.total = (Number(sub.total) || 0) + 1;
        } else if (status === 'absent') {
          sub.total = (Number(sub.total) || 0) + 1;
        }
      }

      const existingIdx = appState.history.findIndex(h => h.date === dateStr && h.subId === subId);
      if (existingIdx !== -1) {
        if (status === 'none') {
          appState.history.splice(existingIdx, 1);
        } else {
          appState.history[existingIdx].status = status;
          appState.history[existingIdx].timestamp = Date.now();
        }
      } else if (status !== 'none') {
        appState.history.unshift({
          id: 'hist_' + Date.now(),
          subId,
          date: dateStr,
          status,
          timestamp: Date.now()
        });
      }

      saveState();

      if (appState.activeTab === 'calendar') {
        renderCalendar();
        renderCalendarDateDetail(dateStr);
      }
      if (currentHistorySubId === subId) {
        renderHistoryList(subId);
      }
    }

    // 10. COMPONENT 3: ATTENDANCE CALENDAR (INTERACTIVE MONTHLY GRID)
    function renderCalendar() {
      const monthTitle = document.getElementById('calMonthTitle');
      const grid = document.getElementById('calGridDays');
      if (!monthTitle || !grid) return;

      const dateObj = new Date(calCurrentYear, calCurrentMonth, 1);
      monthTitle.textContent = dateObj.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });

      const firstDayIndex = dateObj.getDay();
      const daysInMonth = new Date(calCurrentYear, calCurrentMonth + 1, 0).getDate();

      let html = '';
      for (let i = 0; i < firstDayIndex; i++) {
        html += `<div class="cal-cell empty-cell"></div>`;
      }

      const todayStr = getTodayDateStr();

      for (let day = 1; day <= daysInMonth; day++) {
        const mStr = String(calCurrentMonth + 1).padStart(2, '0');
        const dStr = String(day).padStart(2, '0');
        const currentIsoDate = `${calCurrentYear}-${mStr}-${dStr}`;

        const isToday = currentIsoDate === todayStr;
        const isSelected = currentIsoDate === calSelectedDate;

        const dayData = appState.calendar[currentIsoDate] || { isHoliday: false, entries: {} };
        const isHoliday = Boolean(dayData.isHoliday);

        let presentCount = 0;
        let absentCount = 0;
        const entries = dayData.entries || {};
        Object.values(entries).forEach(st => {
          if (st === 'present') presentCount++;
          if (st === 'absent') absentCount++;
        });

        let dotClass = '';
        if (isHoliday) dotClass = 'dot-hol';
        else if (presentCount > 0 && absentCount === 0) dotClass = 'dot-pres';
        else if (absentCount > 0 && presentCount === 0) dotClass = 'dot-abs';
        else if (presentCount > 0 && absentCount > 0) dotClass = 'dot-mix';

        html += `
          <div class="cal-cell ${isToday ? 'is-today' : ''} ${isSelected ? 'is-selected' : ''} ${isHoliday ? 'is-holiday' : ''}"
               data-action="selectCalendarDate" data-date="${escapeHtml(currentIsoDate)}">
            <span>${day}</span>
            ${dotClass ? `<div class="cal-dot-row"><span class="cal-dot ${dotClass}"></span></div>` : ''}
          </div>
        `;
      }

      grid.innerHTML = html;
      renderCalendarDateDetail(calSelectedDate);
    }

    function prevMonth() {
      calCurrentMonth--;
      if (calCurrentMonth < 0) {
        calCurrentMonth = 11;
        calCurrentYear--;
      }
      renderCalendar();
    }

    function nextMonth() {
      calCurrentMonth++;
      if (calCurrentMonth > 11) {
        calCurrentMonth = 0;
        calCurrentYear++;
      }
      renderCalendar();
    }

    function goToTodayCal() {
      const now = new Date();
      calCurrentYear = now.getFullYear();
      calCurrentMonth = now.getMonth();
      calSelectedDate = getTodayDateStr();
      renderCalendar();
    }

    function selectCalendarDate(dateStr) {
      calSelectedDate = dateStr;
      renderCalendar();
    }

    function renderCalendarDateDetail(dateStr) {
      const titleEl = document.getElementById('calSelectedDateText');
      const holidayBanner = document.getElementById('calSelectedDateHolidayBanner');
      const listEl = document.getElementById('calDailySubjectsList');
      const holidayBtn = document.getElementById('calToggleHolidayBtn');

      if (!titleEl || !listEl) return;

      const parts = dateStr.split('-');
      const dObj = new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
      titleEl.textContent = dObj.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });

      const dayData = appState.calendar[dateStr] || { isHoliday: false, entries: {} };
      const isHoliday = dayData.isHoliday;

      holidayBanner.style.display = isHoliday ? 'block' : 'none';
      holidayBtn.innerHTML = isHoliday ? '<span>🎉</span> Unmark Holiday' : '<span>🎉</span> Holiday';

      if (appState.subjects.length === 0) {
        listEl.innerHTML = `<div style="text-align:center; padding:12px; color:var(--text-dim);">No subjects configured.</div>`;
        return;
      }

      let html = '';
      appState.subjects.forEach(sub => {
        const currentStatus = dayData.entries[sub.id] || 'none';
        const cat = sub.category || 'theory';
        const safeSubName = escapeHtml(sub.name);
        const safeSubId = escapeHtml(sub.id);
        const safeCat = escapeHtml(cat);
        const safeDateStr = escapeHtml(dateStr);

        html += `
          <div class="day-sub-entry">
            <div class="day-sub-info">
              <div style="display:flex; align-items:center; gap:6px;">
                <span class="cat-tag cat-${safeCat}">${safeCat.toUpperCase()}</span>
                <strong style="font-size:13.5px; color:#fff;">${safeSubName}</strong>
              </div>
              <span style="font-size:11px; color:var(--text-muted); margin-top:2px;">
                Status on this day: 
                <span class="day-status-pill status-pill-${currentStatus}">
                  ${currentStatus === 'present' ? '✓ Present' : (currentStatus === 'absent' ? '✕ Absent' : (currentStatus === 'off' ? '— Off' : 'Not marked'))}
                </span>
              </span>
            </div>

            <div style="display:flex; gap:5px;">
              <button type="button" class="act-btn ${currentStatus === 'present' ? 'act-present' : ''}" style="padding:5px 9px; font-size:11px;" data-action="recordAttendanceEntry" data-date="${safeDateStr}" data-subid="${safeSubId}" data-status="present">✓</button>
              <button type="button" class="act-btn ${currentStatus === 'absent' ? 'act-absent' : ''}" style="padding:5px 9px; font-size:11px;" data-action="recordAttendanceEntry" data-date="${safeDateStr}" data-subid="${safeSubId}" data-status="absent">✕</button>
              <button type="button" class="act-btn ${currentStatus === 'off' ? 'act-off' : ''}" style="padding:5px 9px; font-size:11px;" data-action="recordAttendanceEntry" data-date="${safeDateStr}" data-subid="${safeSubId}" data-status="off">—</button>
            </div>
          </div>
        `;
      });

      listEl.innerHTML = html;
    }

    function toggleHolidayForSelectedDate() {
      const dateStr = calSelectedDate;
      if (!appState.calendar[dateStr]) {
        appState.calendar[dateStr] = { isHoliday: false, entries: {} };
      }
      appState.calendar[dateStr].isHoliday = !appState.calendar[dateStr].isHoliday;
      saveState();
      renderCalendar();
    }

    // 11. SUBJECT-WISE ATTENDANCE HISTORY DRAWER
    function openSubjectHistoryDrawer(subId) {
      currentHistorySubId = subId;
      const sub = appState.subjects.find(s => s.id === subId);
      if (!sub) return;

      document.getElementById('histSubName').textContent = sub.name;
      const catEl = document.getElementById('histSubCat');
      catEl.className = `cat-tag cat-${sub.category || 'theory'}`;
      catEl.textContent = (sub.category || 'theory').toUpperCase();

      renderHistoryList(subId);
      document.getElementById('historyDrawer').classList.add('open');
    }

    function closeHistoryDrawer() {
      document.getElementById('historyDrawer').classList.remove('open');
      currentHistorySubId = null;
    }

    function renderHistoryList(subId) {
      const sub = appState.subjects.find(s => s.id === subId);
      if (!sub) return;

      const stats = calcStats(sub);
      document.getElementById('histScorePct').textContent = `${stats.percentage}%`;
      document.getElementById('histScorePct').style.color = stats.isShort ? 'var(--danger)' : 'var(--success)';
      document.getElementById('histRatio').textContent = `${stats.attended}/${stats.total} Classes Held (${stats.missed} Missed)`;

      if (stats.isShort) {
        document.getElementById('histGoalText').textContent = `Min to 75%: Attend ${stats.minNeededToReach75} in a row`;
        document.getElementById('histGoalText').style.color = '#f87171';
      } else {
        document.getElementById('histGoalText').textContent = `Max you can miss: ${stats.maxCanMiss} classes`;
        document.getElementById('histGoalText').style.color = '#34d399';
      }

      const listContainer = document.getElementById('historyListContainer');
      const subHistory = appState.history.filter(h => h.subId === subId);

      if (subHistory.length === 0) {
        listContainer.innerHTML = `
          <div style="text-align:center; padding:24px 12px; color:var(--text-dim); font-size:12.5px;">
            No logged sessions yet. Tap "+ Add Entry" or mark classes on the dashboard / calendar.
          </div>
        `;
        return;
      }

      let html = '';
      subHistory.forEach(item => {
        const isPres = item.status === 'present';
        const isAbs = item.status === 'absent';
        const colorVar = isPres ? 'var(--success)' : (isAbs ? 'var(--danger)' : 'var(--text-muted)');
        const safeHistId = escapeHtml(item.id);
        const safeDate = escapeHtml(item.date);

        html += `
          <div class="history-item">
            <div class="history-item-left">
              <span class="history-date">${safeDate}</span>
              <span class="history-type" style="color:${colorVar}">
                ${isPres ? '✓ Marked Present' : (isAbs ? '✕ Marked Absent' : '— Class Cancelled / Off')}
              </span>
            </div>

            <div style="display:flex; gap:6px;">
              <button type="button" class="act-btn" style="padding:4px 8px; font-size:11px;" data-action="toggleHistoryStatus" data-histid="${safeHistId}">Toggle</button>
              <button type="button" class="act-btn act-absent" style="padding:4px 8px; font-size:11px;" data-action="deleteHistoryEntry" data-histid="${safeHistId}">✕</button>
            </div>
          </div>
        `;
      });

      listContainer.innerHTML = html;
    }

    function toggleHistoryStatus(historyId) {
      const item = appState.history.find(h => h.id === historyId);
      if (!item) return;

      const newStatus = item.status === 'present' ? 'absent' : 'present';
      recordAttendanceEntry(item.date, item.subId, newStatus);
    }

    function deleteHistoryEntry(historyId) {
      const idx = appState.history.findIndex(h => h.id === historyId);
      if (idx === -1) return;

      const item = appState.history[idx];
      recordAttendanceEntry(item.date, item.subId, 'none');
    }

    function addManualEntryToSubject() {
      if (!currentHistorySubId) return;
      const date = prompt('Enter date for attendance entry (YYYY-MM-DD):', getTodayDateStr());
      if (!date || !date.match(/^\d{4}-\d{2}-\d{2}$/)) return;

      const status = confirm('Click OK for Present (✓), or Cancel for Absent (✕)') ? 'present' : 'absent';
      recordAttendanceEntry(date, currentHistorySubId, status);
    }

    // 12. ONBOARDING / SETUP WIZARD (NAME INPUT & CUSTOMIZATION)
    function openSetupModal() {
      wizardSubjectCount = appState.subjects && appState.subjects.length > 0 ? appState.subjects.length : 5;
      document.getElementById('setupCountDisplay').textContent = wizardSubjectCount;
      const nameInp = document.getElementById('wizStudentName');
      if (nameInp) nameInp.value = appState.studentName || '';
      updatePresetChips(wizardSubjectCount);
      document.getElementById('setupStep1').style.display = 'block';
      document.getElementById('setupStep2').style.display = 'none';
      document.getElementById('setupModal').classList.add('open');
      setTimeout(() => {
        if (nameInp && !nameInp.value) nameInp.focus();
      }, 150);
    }

    function closeSetupModal() {
      document.getElementById('setupModal').classList.remove('open');
    }

    function setSubjectCountDirect(count) {
      wizardSubjectCount = Math.max(1, Math.min(15, count));
      document.getElementById('setupCountDisplay').textContent = wizardSubjectCount;
      updatePresetChips(wizardSubjectCount);
    }

    function adjustSubjectCount(delta) {
      wizardSubjectCount = Math.max(1, Math.min(15, wizardSubjectCount + delta));
      document.getElementById('setupCountDisplay').textContent = wizardSubjectCount;
      updatePresetChips(wizardSubjectCount);
    }

    function updatePresetChips(count) {
      [3, 4, 5, 6, 7, 8].forEach(c => {
        const el = document.getElementById(`chipPreset${c}`);
        if (el) el.classList.toggle('active', c === count);
      });
    }

    function goToSetupStep2() {
      const nameInp = document.getElementById('wizStudentName');
      const rawName = nameInp ? nameInp.value : '';
      const cleanName = sanitizeText(rawName);
      if (!cleanName) {
        alert('Please enter your name to customize your attendance dashboard.');
        if (nameInp) nameInp.focus();
        return;
      }
      appState.studentName = cleanName;

      document.getElementById('setupStep1').style.display = 'none';
      document.getElementById('setupStep2').style.display = 'block';
      document.getElementById('step2CountLabel').textContent = wizardSubjectCount;

      const container = document.getElementById('setupSubjectsContainer');
      let html = '';

      const sampleNames = [
        'Mathematics / Calculus',
        'Data Structures & Algorithms',
        'Operating Systems',
        'Database Systems',
        'Computer Networks Lab',
        'Artificial Intelligence',
        'Software Engineering',
        'Web Development',
        'Physics / Electronics'
      ];

      for (let i = 0; i < wizardSubjectCount; i++) {
        const existing = appState.subjects[i];
        const defaultName = existing ? escapeHtml(existing.name) : '';
        const defaultCat = existing ? (existing.category || 'theory') : (i >= 4 ? 'lab' : 'theory');
        const defaultAttended = existing ? existing.attended : 0;
        const defaultTotal = existing ? existing.total : 0;
        const placeholderName = sampleNames[i % sampleNames.length];

        html += `
          <div class="subject-setup-row">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <span style="font-size:11px; font-weight:800; color:var(--brand); text-transform:uppercase;">Subject ${i + 1}</span>
              <span style="font-size:10px; color:var(--text-dim);">Course #${i + 1}</span>
            </div>
            <div class="setup-row-top">
              <input type="text" id="wizName_${i}" class="form-inp" style="flex:1;" placeholder="e.g. ${placeholderName}" value="${defaultName}" maxlength="80" required>
              <select id="wizCat_${i}" class="form-sel" style="width:115px;">
                <option value="theory" ${defaultCat === 'theory' ? 'selected' : ''}>Theory</option>
                <option value="lab" ${defaultCat === 'lab' ? 'selected' : ''}>Lab / Practical</option>
                <option value="elective" ${defaultCat === 'elective' ? 'selected' : ''}>Elective</option>
                <option value="tutorial" ${defaultCat === 'tutorial' ? 'selected' : ''}>Tutorial</option>
              </select>
            </div>
            <div class="setup-row-bottom">
              <div>
                <label style="font-size:10px; color:var(--text-dim); display:block; margin-bottom:2px;">Classes attended so far</label>
                <input type="number" id="wizAtt_${i}" class="form-inp" style="width:100%; padding:6px 8px; font-size:13px;" value="${defaultAttended}" min="0" max="2000">
              </div>
              <div>
                <label style="font-size:10px; color:var(--text-dim); display:block; margin-bottom:2px;">Total held so far</label>
                <input type="number" id="wizTot_${i}" class="form-inp" style="width:100%; padding:6px 8px; font-size:13px;" value="${defaultTotal}" min="0" max="2000">
              </div>
            </div>
          </div>
        `;
      }

      container.innerHTML = html;
      setTimeout(() => {
        const firstInput = document.getElementById('wizName_0');
        if (firstInput) firstInput.focus();
      }, 100);
    }

    function backToStep1() {
      document.getElementById('setupStep2').style.display = 'none';
      document.getElementById('setupStep1').style.display = 'block';
    }

    function finishSetup() {
      const newSubjects = [];
      for (let i = 0; i < wizardSubjectCount; i++) {
        const nameInput = document.getElementById(`wizName_${i}`);
        const catSelect = document.getElementById(`wizCat_${i}`);
        const attInput = document.getElementById(`wizAtt_${i}`);
        const totInput = document.getElementById(`wizTot_${i}`);

        let rawName = nameInput ? nameInput.value : '';
        let name = sanitizeText(rawName);
        if (!name) name = `Course ${i + 1}`;
        if (name.length > 80) name = name.substring(0, 80);

        const category = catSelect ? catSelect.value : 'theory';
        const attended = Math.max(0, Math.min(2000, parseInt(attInput.value) || 0));
        const total = Math.max(attended, Math.min(2000, parseInt(totInput.value) || 0));

        newSubjects.push({
          id: 'sub_' + (Date.now() + i),
          name,
          category,
          attended,
          total,
          target: appState.globalTarget
        });
      }

      appState.subjects = newSubjects;
      appState.isSetupCompleted = true;
      closeSetupModal();
      saveState();

      alert(`🎉 Semester Setup Saved!
Created ${newSubjects.length} customized subjects for you.`);
    }

    function openAddSingleModal() {
      document.getElementById('singleModalHeading').textContent = 'Add Single Course / Subject';
      document.getElementById('singleEditId').value = '';
      document.getElementById('singleName').value = '';
      document.getElementById('singleCategory').value = 'theory';
      document.getElementById('singleAttended').value = '0';
      document.getElementById('singleTotal').value = '0';
      document.getElementById('singleDeleteBtn').style.display = 'none';
      document.getElementById('singleModal').classList.add('open');
      setTimeout(() => document.getElementById('singleName').focus(), 150);
    }

    // 13. SINGLE SUBJECT ADD/EDIT
    function openSingleEditModal(id) {
      const sub = appState.subjects.find(s => s.id === id);
      if (!sub) return;

      document.getElementById('singleModalHeading').textContent = 'Edit Subject';
      document.getElementById('singleEditId').value = sub.id;
      document.getElementById('singleName').value = sub.name;
      document.getElementById('singleCategory').value = sub.category || 'theory';
      document.getElementById('singleAttended').value = sub.attended;
      document.getElementById('singleTotal').value = sub.total;
      document.getElementById('singleDeleteBtn').style.display = 'inline-flex';
      document.getElementById('singleModal').classList.add('open');
    }

    function closeSingleModal() {
      document.getElementById('singleModal').classList.remove('open');
    }

    function handleSingleSubmit(e) {
      e.preventDefault();
      const id = document.getElementById('singleEditId').value;
      const rawName = document.getElementById('singleName').value;
      let name = sanitizeText(rawName);
      if (!name) return;
      if (name.length > 80) name = name.substring(0, 80);

      const category = document.getElementById('singleCategory').value;
      const attended = Math.max(0, Math.min(2000, parseInt(document.getElementById('singleAttended').value) || 0));
      const total = Math.max(attended, Math.min(2000, parseInt(document.getElementById('singleTotal').value) || 0));

      if (id) {
        const sub = appState.subjects.find(s => s.id === id);
        if (sub) {
          sub.name = name;
          sub.category = category;
          sub.attended = attended;
          sub.total = total;
        }
      } else {
        appState.subjects.push({
          id: 'sub_' + Date.now(),
          name,
          category,
          attended,
          total,
          target: appState.globalTarget
        });
      }

      closeSingleModal();
      saveState();
    }

    function deleteCurrentSingle() {
      const id = document.getElementById('singleEditId').value;
      if (id && confirm('Delete this subject and its records?')) {
        appState.subjects = appState.subjects.filter(s => s.id !== id);
        closeSingleModal();
        saveState();
      }
    }

    // 14. TARGET MODAL
    function openTargetModal() {
      document.getElementById('customTargetInput').value = appState.globalTarget;
      document.getElementById('targetModal').classList.add('open');
    }
    function closeTargetModal() {
      document.getElementById('targetModal').classList.remove('open');
    }
    function setTarget(val) {
      appState.globalTarget = Math.max(50, Math.min(100, val));
      closeTargetModal();
      saveState();
    }
    function applyCustomTarget() {
      const val = parseInt(document.getElementById('customTargetInput').value) || 75;
      setTarget(val);
    }

    // 15. SIMULATOR
    function populateCalcOptions() {
      const sel = document.getElementById('calcSubjectSelect');
      if (!sel) return;
      sel.innerHTML = '';

      appState.subjects.forEach(sub => {
        const opt = document.createElement('option');
        opt.value = sub.id;
        opt.textContent = `${sub.name} (${sub.attended}/${sub.total})`;
        sel.appendChild(opt);
      });
    }

    function runSimulation() {
      const sel = document.getElementById('calcSubjectSelect');
      const attInp = document.getElementById('calcAttendNext');
      const bunkInp = document.getElementById('calcBunkNext');
      const numEl = document.getElementById('calcProjectedPercent');
      const pillWrap = document.getElementById('calcProjectedPillWrap');
      const resText = document.getElementById('calcProjectedText');

      if (!sel || !sel.value) {
        numEl.textContent = '--%';
        pillWrap.innerHTML = '';
        resText.textContent = 'Add subjects to run simulation.';
        return;
      }

      const sub = appState.subjects.find(s => s.id === sel.value);
      if (!sub) return;

      const addAtt = Math.max(0, parseInt(attInp.value) || 0);
      const addBunk = Math.max(0, parseInt(bunkInp.value) || 0);

      const newAtt = sub.attended + addAtt;
      const newTot = sub.total + addAtt + addBunk;
      const target = sub.target || appState.globalTarget || 75;

      const pctNum = newTot > 0 ? (newAtt / newTot) * 100 : 100;
      const pctStr = pctNum.toFixed(1);

      numEl.textContent = `${pctStr}%`;
      numEl.style.color = pctNum < target ? 'var(--danger)' : 'var(--success)';

      if (pctNum < target) {
        pillWrap.innerHTML = `<span class="criteria-pill pill-short"><span class="pill-dot dot-red"></span> Short by ${(target - pctNum).toFixed(1)}%</span>`;
        resText.innerHTML = `Projected: <strong>${newAtt}/${newTot}</strong> classes. Still below ${target}% criteria.`;
      } else {
        pillWrap.innerHTML = `<span class="criteria-pill pill-safe"><span class="pill-dot dot-green"></span> Above Target (+${(pctNum - target).toFixed(1)}%)</span>`;
        resText.innerHTML = `Projected: <strong>${newAtt}/${newTot}</strong> classes. Safely clears ${target}% criteria.`;
      }
    }

    // 16. TAB SWITCHER
    function switchTab(tab) {
      appState.activeTab = tab;
      document.querySelectorAll('.nav-item').forEach((btn, idx) => {
        const tabs = ['subjects', 'calendar', 'calculator', 'settings'];
        btn.classList.toggle('active', tabs[idx] === tab);
      });

      document.querySelectorAll('.view-content').forEach(view => view.classList.remove('active'));
      if (tab === 'subjects') document.getElementById('viewSubjects').classList.add('active');
      if (tab === 'calendar') {
        document.getElementById('viewCalendar').classList.add('active');
        renderCalendar();
      }
      if (tab === 'calculator') {
        document.getElementById('viewCalculator').classList.add('active');
        populateCalcOptions();
        runSimulation();
      }
      if (tab === 'settings') {
        document.getElementById('viewSettings').classList.add('active');
      }

      window.scrollTo({ top: 0, behavior: 'smooth' });
    }

    // 17. BACKUP, CSV REPORT & DATA IMPORT (VALIDATED)
    function exportData() {
      const nowStr = getTodayDateStr();
      const exportPayload = {
        app: 'Attendify',
        version: '2.2.0',
        exportDate: new Date().toISOString(),
        globalTarget: appState.globalTarget,
        activeTheme: appState.activeTheme,
        privacyMode: appState.privacyMode,
        subjects: appState.subjects,
        calendar: appState.calendar,
        history: appState.history
      };

      const blob = new Blob([JSON.stringify(exportPayload, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `attendify_backup_${nowStr}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
    }

    function exportCSVReport() {
      const target = appState.globalTarget || 75;
      let csv = 'Subject Name,Category,Attended Classes,Total Classes,Missed Classes,Attendance %,75% Criteria Status,Classes Needed For 75%,Bunks Available\r\n';

      appState.subjects.forEach(sub => {
        const stats = calcStats(sub);
        const nameEscaped = `"${sub.name.replace(/"/g, '""')}"`;
        const catEscaped = `"${sub.category || 'theory'}"`;
        const status = stats.isShort ? `Short by ${stats.shortagePct}%` : `Safe (+${stats.surplusPct}%)`;
        const needed = stats.isShort ? `${stats.minNeededToReach75} in a row` : '0';
        const bunks = stats.maxCanMiss;

        csv += `${nameEscaped},${catEscaped},${stats.attended},${stats.total},${stats.missed},${stats.percentage}%,${status},${needed},${bunks}\r\n`;
      });

      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `attendify_attendance_report_${getTodayDateStr()}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    }

    function importData(e) {
      const file = e.target.files[0];
      if (!file) return;

      // Check file size limit (max 5 MB for student records)
      if (file.size > 5 * 1024 * 1024) {
        alert('Security check failed: File size exceeds 5MB limit.');
        e.target.value = '';
        return;
      }

      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const rawParsed = JSON.parse(event.target.result);
          // Run rigorous schema validation
          const validated = validateAndSanitizeState(rawParsed);

          appState = validated;
          applyThemeUI(appState.activeTheme || 'navy-purple');
          applyPrivacyModeUI();
          saveState();

          alert(`✓ Backup verified and loaded safely!\n• ${appState.subjects.length} subjects imported.\n• ${appState.history.length} logged sessions verified.`);
        } catch (err) {
          alert('❌ Security Validation Error:\n' + (err.message || 'Invalid or corrupted JSON backup file.'));
        }
        e.target.value = '';
      };
      reader.onerror = () => {
        alert('Failed to read file.');
        e.target.value = '';
      };
      reader.readAsText(file);
    }

    // 18. SAFE DATA DELETION / FACTORY RESET MODAL
    function openDeleteModal() {
      const subCount = appState.subjects ? appState.subjects.length : 0;
      const histCount = appState.history ? appState.history.length : 0;

      const subEl = document.getElementById('deleteSubCount');
      const histEl = document.getElementById('deleteHistCount');
      if (subEl) subEl.textContent = subCount;
      if (histEl) histEl.textContent = histCount;

      document.getElementById('deleteModal').classList.add('open');
    }

    function closeDeleteModal() {
      document.getElementById('deleteModal').classList.remove('open');
    }

    async function confirmPermanentDelete() {
      const deleteBtn = document.querySelector('[data-action="confirmPermanentDelete"]');
      const originalBtnText = deleteBtn ? deleteBtn.innerHTML : '';
      if (deleteBtn) {
        deleteBtn.disabled = true;
        deleteBtn.innerHTML = '⏳ Erasing data & cloud backup...';
      }

      const codeToDelete = appState.syncCode;
      const keyToDelete = appState.syncAuthKey;

      if (syncDebounceTimer) {
        clearTimeout(syncDebounceTimer);
        syncDebounceTimer = null;
      }

      let cloudDeleteResult = 'skipped';

      // 1. Delete cloud backup from Neon servers if credentials exist
      if (codeToDelete && keyToDelete) {
        try {
          const response = await syncApiRequest('/delete', {
            sync_code: codeToDelete,
            auth_token: keyToDelete
          });

          if (response.ok) {
            const resJson = await response.json().catch(() => ({}));
            cloudDeleteResult = resJson.status === 'deleted' ? 'deleted' : 'not_found';
            console.log('[Attendify] Cloud backup deleted successfully:', resJson);
          } else {
            const errData = await response.json().catch(() => ({}));
            console.warn('[Attendify] Cloud deletion error from server:', response.status, errData);
            cloudDeleteResult = 'failed';
          }
        } catch (err) {
          console.warn('[Attendify] Cloud deletion network failure:', err);
          cloudDeleteResult = 'offline';
        }
      }

      // 2. Clear local storage & reset in-memory state
      try {
        localStorage.removeItem(STORAGE_KEY);
      } catch (err) {
        console.warn('Could not remove localStorage key:', err);
      }

      appState = getDefaultState();
      appState.subjects = [];
      appState.calendar = {};
      appState.history = [];

      applyThemeUI('navy-purple');
      applyPrivacyModeUI();
      saveStateOnly();

      if (deleteBtn) {
        deleteBtn.disabled = false;
        deleteBtn.innerHTML = originalBtnText;
      }

      closeDeleteModal();

      // 3. User feedback
      if (cloudDeleteResult === 'deleted') {
        alert('✓ Attendify has been reset.\n\n• Local attendance records erased.\n• Cloud backup permanently deleted.');
      } else if (cloudDeleteResult === 'not_found' || cloudDeleteResult === 'skipped') {
        alert('✓ Attendify has been reset.\n\n• Local attendance records erased.');
      } else {
        alert('⚠️ Local attendance records erased.\n\nNote: Could not reach cloud server to delete remote backup. Please reconnect and wipe your cloud record if needed.');
      }

      openSetupModal();
    }

    async function wipeCloudBackupOnly() {
      if (!appState.syncCode || !appState.syncAuthKey) {
        alert('No cloud backup credentials found on this device.');
        return;
      }

      const confirmed = confirm(
        `⚠️ Permanently delete cloud backup for sync code "${appState.syncCode}"?\n\nThis will remove your stored attendance data from the cloud server.\n\nYour local data on this phone will NOT be deleted.`
      );
      if (!confirmed) return;

      const wipeBtn = document.querySelector('[data-action="wipeCloudBackupOnly"]');
      const originalText = wipeBtn ? wipeBtn.innerHTML : '';
      if (wipeBtn) {
        wipeBtn.disabled = true;
        wipeBtn.innerHTML = '⏳ Deleting from cloud...';
      }

      const statusEl = document.getElementById('topCloudStatus');
      if (statusEl) statusEl.innerHTML = '☁️ <span style="color:#ef4444;">Deleting...</span>';

      try {
        const response = await syncApiRequest('/delete', {
          sync_code: appState.syncCode,
          auth_token: appState.syncAuthKey
        });

        const resData = await response.json().catch(() => ({}));

        if (!response.ok) {
          throw new Error(resData.error || resData.message || `HTTP ${response.status}`);
        }

        appState.lastSyncedAt = null;
        saveStateOnly();

        if (statusEl) statusEl.innerHTML = '☁️ <span style="color:#94a3b8;">Wiped</span>';
        const lastSyncEl = document.getElementById('settingsLastSyncTime');
        if (lastSyncEl) lastSyncEl.textContent = 'Deleted from server';

        if (resData.status === 'deleted') {
          alert('✅ Cloud backup has been permanently deleted from the server.');
        } else if (resData.status === 'not_found') {
          alert('ℹ️ No backup was found in the cloud for this sync code. Nothing to delete.');
        } else {
          alert('✅ Cloud deletion completed successfully.');
        }
      } catch (err) {
        alert('❌ Error deleting cloud backup: ' + err.message);
        if (statusEl) statusEl.innerHTML = '☁️ <span style="color:#ef4444;">Error</span>';
      } finally {
        if (wipeBtn) {
          wipeBtn.disabled = false;
          wipeBtn.innerHTML = originalText;
        }
      }
    }

    // 19. PRIVACY POLICY MODAL
    function openPrivacyModal() {
      document.getElementById('privacyModal').classList.add('open');
    }
    function closePrivacyModal() {
      document.getElementById('privacyModal').classList.remove('open');
    }

    function closeOnBackdrop(e) {
      if (e.target.classList.contains('modal-backdrop')) {
        e.target.classList.remove('open');
      }
    }


    // -------------------------------------------------------------
    // CLOUD STORAGE CONFIGURATION & ENGINE (NEON FUNCTIONS API)
    // -------------------------------------------------------------
    const SYNC_API_URL = 'https://br-fancy-block-azi8u9jd-sync.compute.c-3.ap-southeast-1.aws.neon.tech';

    // Single entry point for the Attendify Sync API.
    // Endpoints: POST /push, POST /pull, POST /delete, GET /health
    function syncApiRequest(path, payload) {
      return fetch(`${SYNC_API_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    // Cryptographically Secure Sync Credentials Generation (CSPRNG)
    function generateSyncCode() {
      const alphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
      const bytes = new Uint8Array(15);
      window.crypto.getRandomValues(bytes);
      let str = '';
      for (let i = 0; i < bytes.length; i++) {
        str += alphabet.charAt(bytes[i] % alphabet.length);
      }
      return `ATN-${str.slice(0, 4)}-${str.slice(4, 8)}-${str.slice(8, 12)}`;
    }

    function generateAuthToken() {
      const bytes = new Uint8Array(24);
      window.crypto.getRandomValues(bytes);
      return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    let syncDebounceTimer = null;

    function queueCloudSync() {
      if (syncDebounceTimer) clearTimeout(syncDebounceTimer);
      syncDebounceTimer = setTimeout(() => {
        syncToCloudStorage();
      }, 800);
    }

    async function syncToCloudStorage() {
      if (!appState.syncCode || !appState.syncCode.startsWith('ATN-')) appState.syncCode = generateSyncCode();
      if (!appState.syncAuthKey) appState.syncAuthKey = generateAuthToken();

      const statusEl = document.getElementById('topCloudStatus');
      const headerBtn = document.getElementById('headerCloudSyncBtn');
      if (statusEl) statusEl.innerHTML = '☁️ <span style="color:#fbbf24;">Syncing...</span>';
      if (headerBtn) headerBtn.style.opacity = '0.6';

      const payload = {
        sync_code: appState.syncCode,
        auth_token: appState.syncAuthKey,
        data: {
          studentName: appState.studentName || '',
          subjects: appState.subjects || [],
          calendar: appState.calendar || {},
          history: appState.history || [],
          globalTarget: appState.globalTarget || 75,
          activeTheme: appState.activeTheme || 'navy-purple',
          privacyMode: appState.privacyMode || false,
          lastUpdated: new Date().toISOString()
        }
      };

      try {
        const response = await syncApiRequest('/push', payload);

        if (response.ok) {
          appState.lastSyncedAt = Date.now();
          if (statusEl) statusEl.innerHTML = '☁️ <span style="color:#34d399;">Synced</span>';
          const lastSyncEl = document.getElementById('settingsLastSyncTime');
          if (lastSyncEl) lastSyncEl.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } else {
          console.warn('Cloud sync response error:', response.status);
          if (statusEl) statusEl.innerHTML = '☁️ <span style="color:#94a3b8;">Local</span>';
        }
      } catch (err) {
        console.warn('Offline or network error syncing to cloud:', err);
        if (statusEl) statusEl.innerHTML = '☁️ <span style="color:#94a3b8;">Offline</span>';
      } finally {
        if (headerBtn) headerBtn.style.opacity = '1';
      }
    }

    async function triggerManualSync() {
      const headerBtn = document.getElementById('headerCloudSyncBtn');
      if (headerBtn) headerBtn.classList.add('active');
      await syncToCloudStorage();
      setTimeout(() => {
        if (headerBtn) headerBtn.classList.remove('active');
      }, 600);
      alert(`☁️ Cloud Storage Synced!
Your attendance records are backed up securely under Code: ${appState.syncCode}`);
    }

    
    let isKeyVisible = false;
    function toggleKeyVisibility() {
      isKeyVisible = !isKeyVisible;
      const keyEl = document.getElementById('settingsSyncKeyDisplay');
      const btn = document.getElementById('toggleKeyVisibilityBtn');
      if (!keyEl) return;
      if (isKeyVisible) {
        keyEl.textContent = appState.syncAuthKey || 'No Key';
        if (btn) btn.textContent = '🔒 Hide';
      } else {
        keyEl.textContent = '••••••••••••••••';
        if (btn) btn.textContent = '👁️ Show';
      }
    }

    function copySyncKey() {
      if (!appState.syncAuthKey) return;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(appState.syncAuthKey).then(() => {
          alert('✓ Private Secret Key copied to clipboard! Keep this safe.');
        }).catch(() => {
          prompt('Copy your Private Secret Key:', appState.syncAuthKey);
        });
      } else {
        prompt('Copy your Private Secret Key:', appState.syncAuthKey);
      }
    }

    function copyPairingCredentials() {
      if (!appState.syncCode || !appState.syncAuthKey) return;
      const combo = `${appState.syncCode}:${appState.syncAuthKey}`;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(combo).then(() => {
          alert('✓ Full Pairing Token copied (Code:Key)!\nPaste this into Attendify on your other device for instant 1-tap restore.');
        }).catch(() => {
          prompt('Copy Pairing Token (Code:Key):', combo);
        });
      } else {
        prompt('Copy Pairing Token (Code:Key):', combo);
      }
    }

    function copySyncCode() {
      if (!appState.syncCode) return;
      navigator.clipboard.writeText(appState.syncCode).then(() => {
        alert(`📋 Copied Cloud Sync Code: ${appState.syncCode}
Save this code to restore your courses on another phone or computer!`);
      }).catch(() => {
        prompt('Copy your Cloud Sync Code:', appState.syncCode);
      });
    }

    function openRestoreCloudModal() {
      document.getElementById('restoreCloudModal').classList.add('open');
      setTimeout(() => document.getElementById('restoreSyncCodeInput').focus(), 100);
    }
    function closeRestoreCloudModal() {
      document.getElementById('restoreCloudModal').classList.remove('open');
    }

    async function confirmRestoreFromCloud() {
      const codeInput = document.getElementById('restoreSyncCodeInput');
      const keyInput = document.getElementById('restoreAuthKeyInput');
      let code = (codeInput ? codeInput.value : '').trim();
      let key = (keyInput ? keyInput.value : '').trim();

      // Check if user pasted a combined token (CODE:KEY)
      if (code.includes(':')) {
        const parts = code.split(':');
        code = parts[0].trim();
        key = parts[1].trim();
      }

      if (!code) {
        alert('Please enter your Cloud Sync Code.');
        return;
      }
      if (!key) {
        alert('Please enter your Private Secret Key (Authorization) to restore this sync code.');
        return;
      }

      try {
        const response = await syncApiRequest('/pull', {
          sync_code: code,
          auth_token: key
        });

        if (!response.ok) {
          const errData = await response.json().catch(() => ({}));
          const errMsg = errData.error || errData.message || '';
          if (response.status === 401 || errMsg.includes('Authorization failed')) {
            alert('❌ Authorization Failed: The secret key does not match this Sync Code.');
          } else if (response.status === 404 || response.status === 400 || errMsg.includes('Record not found')) {
            alert('❌ Sync code not found in Cloud Storage. Please check for typos.');
          } else {
            alert('❌ Cloud Restore Error: ' + (errMsg || `HTTP ${response.status}`));
          }
          return;
        }

        const resJson = await response.json();
        const cloudData = resJson.data;
        if (!cloudData) {
          throw new Error('Cloud storage record returned empty data.');
        }

        const validated = validateAndSanitizeState(cloudData);
        appState = validated;
        appState.syncCode = code;
        appState.syncAuthKey = key;
        appState.isSetupCompleted = true;
        appState.studentName = sanitizeText(cloudData.studentName || '');

        applyThemeUI(appState.activeTheme || 'navy-purple');
        applyPrivacyModeUI();
        saveState();
        closeRestoreCloudModal();

        alert(`🎉 Cloud Restore Successful!\nWelcome back, ${appState.studentName || 'Student'}!\nRestored ${appState.subjects.length} subjects from secure cloud storage.`);
      } catch (err) {
        alert('❌ Error connecting to Cloud Storage: ' + err.message);
      }
    }

    function openEditNameModal() {
      document.getElementById('editNameInput').value = appState.studentName || '';
      document.getElementById('editNameModal').classList.add('open');
      setTimeout(() => document.getElementById('editNameInput').focus(), 100);
    }
    function closeEditNameModal() {
      document.getElementById('editNameModal').classList.remove('open');
    }
    function saveEditedName() {
      const inp = document.getElementById('editNameInput');
      const newName = sanitizeText(inp ? inp.value : '');
      if (newName) {
        appState.studentName = newName;
        saveState();
        queueCloudSync();
      }
      closeEditNameModal();
    }

    function initServiceWorker() {
      if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('./sw.js').catch(() => {});
      }
    }
  

    // =============================================================
    // GLOBAL EVENT DELEGATION & HARDENED EVENT BINDINGS
    // Enforces zero-inline handlers to satisfy strict CSP (script-src 'self')
    // =============================================================

    document.addEventListener('click', (e) => {
      // Backdrop click closes open modal
      if (e.target.classList.contains('modal-backdrop')) {
        e.target.classList.remove('open');
        return;
      }

      const el = e.target.closest('[data-action]');
      if (!el) return;

      const action = el.getAttribute('data-action');

      switch (action) {
        case 'triggerManualSync':
          triggerManualSync();
          break;
        case 'togglePrivacyMode':
          togglePrivacyMode();
          break;
        case 'openSetupModal':
          openSetupModal();
          break;
        case 'closeSetupModal':
          closeSetupModal();
          break;
        case 'setSubjectCountDirect': {
          const count = parseInt(el.getAttribute('data-count'), 10);
          setSubjectCountDirect(count);
          break;
        }
        case 'adjustSubjectCount': {
          const delta = parseInt(el.getAttribute('data-delta'), 10);
          adjustSubjectCount(delta);
          break;
        }
        case 'goToSetupStep2':
          goToSetupStep2();
          break;
        case 'backToStep1':
          backToStep1();
          break;
        case 'finishSetup':
          finishSetup();
          break;
        case 'openAddSingleModal':
          openAddSingleModal();
          break;
        case 'openSingleEditModal':
          openSingleEditModal(el.getAttribute('data-subid'));
          break;
        case 'closeSingleModal':
          closeSingleModal();
          break;
        case 'deleteCurrentSingle':
          deleteCurrentSingle();
          break;
        case 'openTargetModal':
          openTargetModal();
          break;
        case 'closeTargetModal':
          closeTargetModal();
          break;
        case 'setTarget': {
          const tgt = parseInt(el.getAttribute('data-target'), 10);
          setTarget(tgt);
          break;
        }
        case 'applyCustomTarget':
          applyCustomTarget();
          break;
        case 'openSubjectHistoryDrawer':
          openSubjectHistoryDrawer(el.getAttribute('data-subid'));
          break;
        case 'closeHistoryDrawer':
          closeHistoryDrawer();
          break;
        case 'addManualEntryToSubject':
          addManualEntryToSubject();
          break;
        case 'toggleHistoryStatus':
          toggleHistoryStatus(el.getAttribute('data-histid'));
          break;
        case 'deleteHistoryEntry':
          deleteHistoryEntry(el.getAttribute('data-histid'));
          break;
        case 'filterCategory':
          filterCategory(el.getAttribute('data-cat'));
          break;
        case 'quickMarkToday':
          quickMarkToday(el.getAttribute('data-subid'), el.getAttribute('data-status'));
          break;
        case 'recordAttendanceEntry':
          recordAttendanceEntry(el.getAttribute('data-date'), el.getAttribute('data-subid'), el.getAttribute('data-status'));
          break;
        case 'prevMonth':
          prevMonth();
          break;
        case 'nextMonth':
          nextMonth();
          break;
        case 'goToTodayCal':
          goToTodayCal();
          break;
        case 'selectCalendarDate':
          selectCalendarDate(el.getAttribute('data-date'));
          break;
        case 'toggleHolidayForSelectedDate':
          toggleHolidayForSelectedDate();
          break;
        case 'setAppTheme':
          setAppTheme(el.getAttribute('data-theme'));
          break;
        case 'openEditNameModal':
          openEditNameModal();
          break;
        case 'closeEditNameModal':
          closeEditNameModal();
          break;
        case 'saveEditedName':
          saveEditedName();
          break;
        case 'copySyncCode':
          copySyncCode();
          break;
        case 'copySyncKey':
          copySyncKey();
          break;
        case 'copyPairingCredentials':
          copyPairingCredentials();
          break;
        case 'toggleKeyVisibility':
          toggleKeyVisibility();
          break;
        case 'openRestoreCloudModal':
          openRestoreCloudModal();
          break;
        case 'closeRestoreCloudModal':
          closeRestoreCloudModal();
          break;
        case 'wipeCloudBackupOnly':
          wipeCloudBackupOnly();
          break;
        case 'confirmRestoreFromCloud':
          confirmRestoreFromCloud();
          break;
        case 'openPrivacyModal':
          openPrivacyModal();
          break;
        case 'closePrivacyModal':
          closePrivacyModal();
          break;
        case 'openDeleteModal':
          openDeleteModal();
          break;
        case 'closeDeleteModal':
          closeDeleteModal();
          break;
        case 'confirmPermanentDelete':
          confirmPermanentDelete();
          break;
        case 'exportData':
          exportData();
          break;
        case 'exportCSVReport':
          exportCSVReport();
          break;
        case 'switchTab':
          switchTab(el.getAttribute('data-tab'));
          break;
      }
    });

    // Form Submissions
    const singleForm = document.getElementById('singleSubjectForm');
    if (singleForm) {
      singleForm.addEventListener('submit', (e) => {
        handleSingleSubmit(e);
      });
    }

    // File Import Change Listener
    const importInput = document.getElementById('importFileInput');
    if (importInput) {
      importInput.addEventListener('change', (e) => {
        importData(e);
      });
    }

    // Calculator Live Input Listeners
    const calcSubjectSelect = document.getElementById('calcSubjectSelect');
    if (calcSubjectSelect) calcSubjectSelect.addEventListener('change', runSimulation);

    const calcAttendNext = document.getElementById('calcAttendNext');
    if (calcAttendNext) calcAttendNext.addEventListener('input', runSimulation);

    const calcBunkNext = document.getElementById('calcBunkNext');
    if (calcBunkNext) calcBunkNext.addEventListener('input', runSimulation);

    // Restore Code auto-splitter on paste
    const restoreSyncCodeInput = document.getElementById('restoreSyncCodeInput');
    const restoreAuthKeyInput = document.getElementById('restoreAuthKeyInput');
    if (restoreSyncCodeInput) {
      restoreSyncCodeInput.addEventListener('input', () => {
        const val = restoreSyncCodeInput.value.trim();
        if (val.includes(':')) {
          const parts = val.split(':');
          restoreSyncCodeInput.value = parts[0].trim();
          if (restoreAuthKeyInput && parts[1]) {
            restoreAuthKeyInput.value = parts[1].trim();
          }
        }
      });
    }

    // Accessibility: Close modals with Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-backdrop.open').forEach(m => m.classList.remove('open'));
      }
    });

    // Initialize application on DOM ready
    document.addEventListener('DOMContentLoaded', () => {
      initDate();
      applyThemeUI(appState.activeTheme || 'navy-purple');
      applyPrivacyModeUI();
      renderApp();
      initServiceWorker();

      // Initial cloud sync if enabled
      if (navigator.onLine && appState.cloudSyncEnabled) {
        setTimeout(syncToCloudStorage, 1200);
      }
    });
