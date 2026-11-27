
    // -------------------------------------------------------------
    // ATTENDIFY CORE ENGINE (SECURITY & PRIVACY HARDENED)
    // -------------------------------------------------------------

    const STORAGE_KEY = 'attendify_state_v6';
    const THEME_IDS = ['graphite', 'sapphire', 'obsidian'];
    const LEGACY_THEME_IDS = { 'navy-purple': 'graphite', 'violet': 'sapphire', 'amoled': 'obsidian' };

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

    // Non-blocking toast notifications (replaces native alert dialogs)
    function showToast(message, type = 'info', timeout = 4200) {
      const container = document.getElementById('toastContainer');
      const text = String(message == null ? '' : message).trim();
      if (!container || !text) return;

      const toast = document.createElement('div');
      toast.className = `toast toast-${type}`;
      toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

      const dot = document.createElement('span');
      dot.className = 'toast-dot';
      dot.setAttribute('aria-hidden', 'true');

      const copy = document.createElement('span');
      copy.textContent = text;

      toast.appendChild(dot);
      toast.appendChild(copy);
      container.appendChild(toast);

      const remove = () => {
        if (!toast.isConnected) return;
        toast.classList.add('out');
        setTimeout(() => toast.remove(), 220);
      };
      const timer = setTimeout(remove, timeout);
      toast.addEventListener('click', () => {
        clearTimeout(timer);
        remove();
      });
    }

    function notify(message) {
      const text = String(message == null ? '' : message);
      const lower = text.toLowerCase();
      let type = 'info';
      if (/error|failed|cannot|could not|invalid|denied|not found|no cloud|no backup|exceeds|mismatch|unable/.test(lower)) {
        type = 'error';
      } else if (/success|saved|copied|synced|verified|restored|deleted|erased|reset|welcome|complete|marked/.test(lower)) {
        type = 'success';
      } else if (/please|warning|check|keep this safe|note:|recommend/.test(lower)) {
        type = 'warning';
      }
      showToast(text, type);
    }

    function getTodayDateStr() {
      const now = new Date();
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, '0');
      const d = String(now.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }

    function parseLocalDateStr(dateStr) {
      if (typeof dateStr !== 'string') return null;
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
      if (!m) return null;
      const year = Number(m[1]);
      const month = Number(m[2]);
      const day = Number(m[3]);
      if (month < 1 || month > 12 || day < 1 || day > 31) return null;
      const dt = new Date(year, month - 1, day);
      if (dt.getFullYear() !== year || dt.getMonth() !== month - 1 || dt.getDate() !== day) {
        return null;
      }
      return dt;
    }

    function isValidCalendarDateStr(dateStr) {
      return parseLocalDateStr(dateStr) !== null;
    }

    function getDefaultState() {
      return {
        isSetupCompleted: false,
        studentName: '',
        syncCode: generateSyncCode(),
        syncAuthKey: generateAuthToken(),
        accountEmail: '',
        authChoice: '',
        cloudSyncEnabled: true,
        lastSyncedAt: null,
        subjects: [],
        calendar: {},
        history: [],
        globalTarget: 75,
        activeTheme: 'graphite',
        themeMode: 'dark',
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

    function initDate() {
      const now = new Date();
      const opts = { month: 'short', day: 'numeric', year: 'numeric' };
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
        appState.localUpdatedAt = Date.now();
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
        appState.localUpdatedAt = Date.now();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
        renderApp();
      } catch (err) {
        console.error('Failed to save state locally:', err);
      }
    }

    // 2. SECURITY: SCHEMA VALIDATOR FOR IMPORTED & LOADED JSON
    function validateAndSanitizeState(raw) {
      // calc.js owns the schema rules (and is unit-tested). The legacy body
      // below stays as an offline fallback if calc.js ever fails to load.
      if (window.AttendifyCalc && typeof window.AttendifyCalc.sanitizeState === 'function') {
        return window.AttendifyCalc.sanitizeState(raw);
      }
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
        const dateKeys = Object.keys(raw.calendar).slice(0, 1000);
        for (const dateKey of dateKeys) {
          if (!isValidCalendarDateStr(dateKey)) continue;
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
          const date = isValidCalendarDateStr(h.date) ? h.date : getTodayDateStr();
          const status = validStatuses.includes(h.status) ? h.status : 'present';
          const timestamp = typeof h.timestamp === 'number' ? h.timestamp : Date.now();
          sanitizedHistory.push({ id, subId, date, status, timestamp });
        }
      }

      let globalTarget = parseInt(raw.globalTarget) || 75;
      if (globalTarget < 50 || globalTarget > 100) globalTarget = 75;

      let activeTheme = typeof raw.activeTheme === 'string' ? raw.activeTheme : 'graphite';
      if (LEGACY_THEME_IDS[activeTheme]) activeTheme = LEGACY_THEME_IDS[activeTheme];
      if (!THEME_IDS.includes(activeTheme)) activeTheme = 'graphite';

      let themeMode = typeof raw.themeMode === 'string' ? raw.themeMode : 'dark';
      if (!['dark', 'light', 'system'].includes(themeMode)) themeMode = 'dark';

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

      // Account email (email/password sign-in). Kept separate from the pairing secret.
      let accountEmail = '';
      if (typeof raw.accountEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(raw.accountEmail.trim())) {
        accountEmail = raw.accountEmail.trim().toLowerCase().substring(0, 254);
      }

      // First-run account choice: '' (must choose), 'guest', or 'account'
      const authChoice = raw.authChoice === 'guest' || raw.authChoice === 'account'
        ? raw.authChoice
        : '';

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
        accountEmail,
        authChoice,
        cloudSyncEnabled,
        lastSyncedAt,
        subjects: sanitizedSubjects,
        calendar: sanitizedCalendar,
        history: sanitizedHistory,
        globalTarget,
        activeTheme,
        themeMode,
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
        headerBtn.innerHTML = isPrivate
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m2 2 20 20"></path><path d="M6.7 6.7A10.4 10.4 0 0 0 2 12s3.5 7 10 7a10.6 10.6 0 0 0 4.1-.8"></path><path d="M10.6 5.2A10 10 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-2.2 3.2"></path><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"></path></svg>'
          : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
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
    const THEME_MODES = ['dark', 'light', 'system'];

    function setAppTheme(theme) {
      if (!THEME_IDS.includes(theme)) return;
      appState.activeTheme = theme;
      applyThemeUI(theme);
      saveState();
    }

    function setThemeMode(mode) {
      if (!THEME_MODES.includes(mode)) return;
      appState.themeMode = mode;
      applyThemeUI(appState.activeTheme || 'graphite');
      saveState();
    }

    function toggleThemeMode() {
      const resolved = getResolvedThemeMode(appState.themeMode);
      appState.themeMode = resolved === 'dark' ? 'light' : 'dark';
      applyThemeUI(appState.activeTheme || 'graphite');
      saveState();
    }

    function getResolvedThemeMode(mode) {
      if (mode === 'system') {
        try {
          return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
        } catch (err) {
          return 'dark';
        }
      }
      return mode === 'light' ? 'light' : 'dark';
    }

    function applyThemeUI(theme) {
      if (!THEME_IDS.includes(theme)) theme = 'graphite';
      const mode = THEME_MODES.includes(appState.themeMode) ? appState.themeMode : 'dark';
      const resolvedMode = getResolvedThemeMode(mode);
      const root = document.documentElement;

      if (root) {
        root.setAttribute('data-theme', theme);
        root.setAttribute('data-mode', resolvedMode);
        root.style.colorScheme = resolvedMode;
      }

      const themeColorMeta = document.querySelector('meta[name="theme-color"]');
      if (themeColorMeta) {
        const computedBg = root && window.getComputedStyle
          ? window.getComputedStyle(root).getPropertyValue('--bg').trim()
          : '';
        themeColorMeta.setAttribute('content', computedBg || (resolvedMode === 'light' ? '#f5f3ee' : '#08090b'));
      }

      THEME_IDS.forEach(t => {
        const btn = document.getElementById(`themeBtn_${t}`);
        if (!btn) return;
        const isActive = t === theme;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });

      THEME_MODES.forEach(m => {
        const btn = document.getElementById(`modeBtn_${m}`);
        if (!btn) return;
        const isActive = m === mode;
        btn.classList.toggle('active', isActive);
        btn.setAttribute('aria-pressed', isActive ? 'true' : 'false');
      });

      const badge = document.getElementById('appearanceModeBadge');
      if (badge) {
        const label = resolvedMode === 'dark' ? 'Dark' : 'Light';
        badge.textContent = mode === 'system' ? `System · ${label}` : label;
      }

      const toggleBtn = document.getElementById('themeModeToggleBtn');
      if (toggleBtn) {
        const nextLabel = resolvedMode === 'dark' ? 'light' : 'dark';
        toggleBtn.title = `Switch to ${nextLabel} theme`;
        toggleBtn.setAttribute('aria-label', `Switch to ${nextLabel} theme`);
      }
    }

    function initSystemThemeListener() {
      if (!window.matchMedia) return;
      try {
        const schemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
        const onChange = () => {
          if (appState.themeMode === 'system') {
            applyThemeUI(appState.activeTheme || 'graphite');
          }
        };
        if (schemeQuery.addEventListener) schemeQuery.addEventListener('change', onChange);
        else if (schemeQuery.addListener) schemeQuery.addListener(onChange);
      } catch (err) {
        // matchMedia unavailable — dark remains the fallback.
      }
    }

    // Apply saved appearance immediately (avoids a flash of the wrong theme)
    applyThemeUI(appState.activeTheme || 'graphite');
    initSystemThemeListener();

    // 5. MATHEMATICAL FORMULAS FOR 75% ATTENDANCE CRITERIA
    // Public entry point. The maths lives in calc.js so the browser and the
    // automated test-suite run exactly the same formulas.
    function calcStats(sub) {
      if (window.AttendifyCalc && typeof window.AttendifyCalc.stats === 'function') {
        return window.AttendifyCalc.stats(sub, appState.globalTarget);
      }
      return legacyCalcStats(sub);
    }

    function legacyCalcStats(sub) {
      const a = Number(sub.attended) || 0;
      const t = Number(sub.total) || 0;
      const target = Number(sub.target) || appState.globalTarget || 75;
      const missed = Math.max(0, t - a);

      const hasData = t > 0;
      const percentage = hasData ? ((a / t) * 100).toFixed(1) : '--';
      const pctNum = hasData ? parseFloat(percentage) : 0;
      const isShort = hasData && pctNum < target;

      let minNeededToReach75 = 0;
      let maxCanMiss = 0;

      if (isShort) {
        if (target >= 100) {
          minNeededToReach75 = null;
        } else {
          const numerator = (target * t) - (100 * a);
          const denominator = 100 - target;
          minNeededToReach75 = Math.max(1, Math.ceil(numerator / denominator));
        }
      } else {
        if (target > 0) {
          const maxAllowedTotal = Math.floor((100 * a) / target);
          maxCanMiss = Math.max(0, maxAllowedTotal - t);
        }
      }

      const shortagePct = isShort ? (target - pctNum).toFixed(1) : '0.0';
      const surplusPct = hasData && !isShort ? (pctNum - target).toFixed(1) : '0.0';

      return {
        attended: a,
        total: t,
        missed,
        target,
        hasData,
        percentage,
        pctNum,
        isShort,
        minNeededToReach75,
        maxCanMiss,
        shortagePct,
        surplusPct
      };
    }

    function statusPillIcon(kind) {
      if (kind === 'safe') {
        return '<svg class="pill-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>';
      }
      if (kind === 'short') {
        return '<svg class="pill-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 8v5"></path><path d="M12 16.5h.01"></path></svg>';
      }
      return '<span class="pill-dot dot-green"></span>';
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
        brandTitle.textContent = appState.studentName ? `Hi, ${appState.studentName}` : 'Attendify';
      }

      // Dashboard greeting + semester snapshot
      const firstName = (appState.studentName || '').trim().split(/\s+/)[0];
      const greetingName = document.getElementById('dashGreetingName');
      if (greetingName) greetingName.textContent = firstName || 'Student';
      const greetingPart = document.getElementById('dashGreetingPart');
      if (greetingPart) {
        const hour = new Date().getHours();
        greetingPart.textContent = hour < 12 ? 'morning' : hour < 17 ? 'afternoon' : 'evening';
      }
      const sidebarName = document.getElementById('sidebarAccountName');
      if (sidebarName) {
        sidebarName.textContent = appState.accountEmail
          ? appState.accountEmail.split('@')[0]
          : (appState.studentName || (appState.authChoice === 'guest' ? 'Guest mode' : 'Not signed in'));
      }
      const sidebarSub = document.getElementById('sidebarAccountSub');
      if (sidebarSub) {
        sidebarSub.textContent = appState.accountEmail
          ? 'Email account · Synced'
          : (appState.authChoice === 'guest' ? 'Guest · Auto-syncs via code' : 'Choose account or guest');
      }
      ['dashTargetVal', 'dashTargetValMirror'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.textContent = `${target}%`;
      });
      const subjectCount = document.getElementById('dashSubjectCount');
      if (subjectCount) subjectCount.textContent = appState.subjects.length;
      const subjectCountInline = document.getElementById('dashSubjectCountInline');
      if (subjectCountInline) subjectCountInline.textContent = appState.subjects.length;

      // Update Settings cloud details
      const nameDisp = document.getElementById('settingsStudentNameDisplay');
      if (nameDisp) nameDisp.textContent = appState.studentName || 'Not Set';
      const syncDisp = document.getElementById('settingsSyncCodeDisplay');
      if (syncDisp) syncDisp.textContent = appState.syncCode || '--';
      const keyDisp = document.getElementById('settingsSyncKeyDisplay');
      if (keyDisp) keyDisp.textContent = isKeyVisible ? (appState.syncAuthKey || 'Not Set') : '••••••••••••••••';
      updateAccountUI();
      const lastSyncEl = document.getElementById('settingsLastSyncTime');
      if (lastSyncEl) {
        if (appState.lastSyncedAt) {
          const d = new Date(appState.lastSyncedAt);
          lastSyncEl.textContent = isNaN(d.getTime()) ? 'Recently' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        } else {
          lastSyncEl.textContent = 'Not synced yet';
        }
      }
      updateCloudStatusUI();

      renderSmartDashboard();
      renderChips();
      renderSubjectAnalyticsList();
      if (appState.activeTab === 'calendar') {
        renderCalendar();
      }
      if (appState.activeTab === 'calculator') {
        populateCalcOptions();
        runSimulation();
      }
      const badge = document.getElementById('subjectCountBadge');
      if (badge) badge.textContent = appState.subjects.length;

      // Advanced surfaces (insights, analytics, timetable, notifications, sync state)
      if (window.AttendifyFeatures && typeof window.AttendifyFeatures.render === 'function') {
        window.AttendifyFeatures.render();
      }
    }

    function updateCloudStatusUI() {
      const badgeEl = document.getElementById('cloudConnectionBadge');
      if (!badgeEl) return;

      const online = typeof navigator === 'undefined' || navigator.onLine !== false;
      if (lastSyncState === 'syncing') {
        badgeEl.className = 'criteria-pill pill-neutral';
        badgeEl.textContent = 'Syncing...';
      } else if (!online || lastSyncState === 'offline') {
        badgeEl.className = 'criteria-pill pill-neutral';
        badgeEl.textContent = 'Not connected';
      } else if (lastSyncState === 'error') {
        badgeEl.className = 'criteria-pill pill-short';
        badgeEl.innerHTML = `${statusPillIcon('short')} Failed`;
      } else if (lastSyncState === 'synced' || appState.lastSyncedAt) {
        badgeEl.className = 'criteria-pill pill-safe';
        badgeEl.innerHTML = `${statusPillIcon('safe')} Synced`;
      } else {
        badgeEl.className = 'criteria-pill pill-neutral';
        badgeEl.textContent = 'Ready to sync';
      }
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
      const hasOverallData = totalConducted > 0;
      const overallPctNum = hasOverallData ? (totalAtt / totalConducted) * 100 : null;
      const overallPct = hasOverallData ? overallPctNum.toFixed(1) : '--';
      const target = appState.globalTarget || 75;
      const isOverallShort = hasOverallData && overallPctNum < target;

      document.getElementById('dashOverallPct').textContent = hasOverallData ? `${overallPct}%` : '--%';
      document.getElementById('statAttended').textContent = totalAtt;
      document.getElementById('statMissed').textContent = totalMissed;
      document.getElementById('statTotalHeld').textContent = totalConducted;
      document.getElementById('statShortCount').textContent = shortCount;

      const shortMirror = document.getElementById('dashShortCountMirror');
      if (shortMirror) shortMirror.textContent = shortCount;
      const conductedMirror = document.getElementById('dashConductedMirror');
      if (conductedMirror) conductedMirror.textContent = totalConducted;

      // Circular gauge animation
      const circle = document.getElementById('dashGaugeCircle');
      const radius = 40;
      const circumference = 2 * Math.PI * radius; // 251.2
      const offset = hasOverallData
        ? circumference - (Math.min(100, Math.max(0, overallPctNum)) / 100) * circumference
        : circumference;
      circle.style.strokeDashoffset = offset;
      circle.style.stroke = hasOverallData ? (isOverallShort ? 'var(--danger)' : 'var(--brand)') : 'var(--border)';

      // Overall criteria pill
      const pillWrap = document.getElementById('dashCriteriaPillWrap');
      if (appState.subjects.length === 0) {
        pillWrap.innerHTML = '';
      } else if (isOverallShort) {
        const gap = (target - overallPctNum).toFixed(1);
        pillWrap.innerHTML = `<span class="criteria-pill pill-short">${statusPillIcon('short')} Short by ${gap}%</span>`;
      } else {
        const lead = (overallPctNum - target).toFixed(1);
        pillWrap.innerHTML = `<span class="criteria-pill pill-safe">${statusPillIcon('safe')} On track · +${lead}%</span>`;
      }

      // Attendance Health Indicator & Action Advice
      const healthTag = document.getElementById('dashHealthTag');
      const adviceEl = document.getElementById('dashAdviceText');
      const alertBar = document.getElementById('dashAlertBanner');

      // Responsive max-width for dashboard container based on theme mode
      const mode = appState.themeMode || 'dark';
      const isLight = mode === 'light' || (mode === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
      const dashboardMaxWidth = isLight ? '560px' : '520px';
      const appContainer = document.querySelector('.app-container');
      if (appContainer) appContainer.style.maxWidth = dashboardMaxWidth;

      if (appState.subjects.length === 0) {
        document.getElementById('dashOverallPct').textContent = '--%';
        circle.style.strokeDashoffset = circumference;
        healthTag.textContent = '● No Subjects Yet';
        healthTag.className = 'health-tag health-neutral';
        adviceEl.innerHTML = `Add your subjects below or run <strong>Semester Setup</strong> to start tracking attendance.`;
        alertBar.className = 'shortage-banner banner-safe welcome-panel';
        alertBar.style.display = 'flex';
        alertBar.innerHTML = `
          <div class="welcome-panel-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"></path>
              <path d="M22 10v6"></path>
              <path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"></path>
            </svg>
          </div>
          <div class="welcome-panel-body">
            <div class="welcome-panel-title">Welcome to Attendify</div>
            <p class="welcome-panel-text">Add your first subject below to unlock overall attendance, safe-bunk limits, and progress alerts.</p>
          </div>
        `;
        return;
      }

      if (!hasOverallData) {
        healthTag.textContent = '● No Classes Yet';
        healthTag.className = 'health-tag health-warning';
        adviceEl.innerHTML = 'Mark your first class as Present or Absent to start tracking attendance.';
        alertBar.className = 'shortage-banner banner-safe welcome-panel';
        alertBar.style.display = 'flex';
        alertBar.innerHTML = `
          <div class="welcome-panel-icon" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21.42 10.922a1 1 0 0 0-.019-1.838L12.83 5.18a2 2 0 0 0-1.66 0L2.6 9.08a1 1 0 0 0 0 1.832l8.57 3.908a2 2 0 0 0 1.66 0z"></path>
              <path d="M22 10v6"></path>
              <path d="M6 12.5V16a6 3 0 0 0 12 0v-3.5"></path>
            </svg>
          </div>
          <div class="welcome-panel-body">
            <div class="welcome-panel-title">No classes logged yet</div>
            <p class="welcome-panel-text">Attendance stays blank until you mark your first class as Present or Absent.</p>
          </div>
          <button type="button" class="btn-primary welcome-panel-cta" data-action="openSetupModal">Edit Subjects</button>
        `;
        return;
      }

      // Determine risk level and construct health tag
      let healthHtml = '';
      if (overallPctNum >= 85) {
        healthHtml = '● A+ • Attendance Master';
      } else if (overallPctNum >= target) {
        healthHtml = '● B+ • Safe & On Track';
      } else if (overallPctNum >= target - 8) {
        healthHtml = '● C • Borderline Warning';
      } else {
        healthHtml = '● Critical Detention Risk';
      }
      healthTag.innerHTML = healthHtml;
      healthTag.className = 'health-tag ' + (overallPctNum >= 85 ? 'health-excellent' : overallPctNum >= target ? 'health-good' : overallPctNum >= target - 8 ? 'health-warning' : 'health-danger');

      if (isOverallShort) {
        if (target >= 100) {
          adviceEl.innerHTML = `Below 100% target (${overallPct}%). Once a class is missed, 100% cannot be reached.`;
          alertBar.className = 'shortage-banner banner-danger';
          alertBar.style.display = 'flex';
          alertBar.innerHTML = `
            <div>
              <strong>Below 100%:</strong> You're <span class="privacy-blur">${(target - overallPctNum).toFixed(1)}%</span> short. Lower your target or keep attending to raise your percentage.
            </div>
          `;
        } else {
          const needed = Math.max(1, Math.ceil(((target * totalConducted) - (100 * totalAtt)) / (100 - target)));
          const neededLabel = `${needed} ${needed === 1 ? 'class' : 'classes'}`;
          adviceEl.innerHTML = `Below criteria. Attend the next <strong class="privacy-blur" style="color:var(--danger-text);">${neededLabel}</strong> in a row to recover.`;
          alertBar.className = 'shortage-banner banner-danger';
          alertBar.style.display = 'flex';
          alertBar.innerHTML = `
            <div>
              <strong>Below ${target}%:</strong> You're <span class="privacy-blur">${(target - overallPctNum).toFixed(1)}%</span> short.
              Attend <span class="privacy-blur">${neededLabel}</span> consecutively to get back on track.
            </div>
          `;
        }
      } else {
        const allowedTot = Math.floor((100 * totalAtt) / target);
        const bunks = Math.max(0, allowedTot - totalConducted);
        const bunkLabel = `${bunks} ${bunks === 1 ? 'class' : 'classes'}`;
        adviceEl.innerHTML = `On track. You can miss up to <strong class="privacy-blur" style="color:var(--success-text);">${bunkLabel}</strong>.`;
        alertBar.className = 'shortage-banner banner-safe';
        alertBar.style.display = 'flex';
        alertBar.innerHTML = `
          <div>
            <strong>You're on track.</strong> <span class="privacy-blur">${(overallPctNum - target).toFixed(1)}%</span> above the ${target}% mark.
            You can miss up to <span class="privacy-blur">${bunkLabel}</span> and stay safe.
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
        { id: 'shortage', label: 'Below 75%' }
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
      const sectionAddBtn = document.getElementById('subjectsSectionAddBtn');
      if (sectionAddBtn) {
        sectionAddBtn.style.display = appState.subjects.length === 0 ? 'none' : '';
      }

      const filtered = appState.subjects.filter(s => {
        if (appState.activeCategory === 'all') return true;
        if (appState.activeCategory === 'shortage') return calcStats(s).isShort;
        return (s.category || 'theory') === appState.activeCategory;
      });

      if (filtered.length === 0) {
        list.innerHTML = '';
        empty.style.display = 'flex';
        const hasAny = appState.subjects.length > 0;
        const title = document.getElementById('emptyStateTitle');
        const copy = document.getElementById('emptyStateText');
        const cta = document.getElementById('emptyStateCta');
        if (title) title.textContent = hasAny ? 'No subjects in this filter' : 'Your semester starts here.';
        if (copy) {
          copy.textContent = hasAny
            ? 'Try another category or clear the filter to see all your courses.'
            : 'Add your first subject to start tracking attendance and monitoring your progress.';
        }
        if (cta) cta.style.display = hasAny ? 'none' : '';
        return;
      }

      empty.style.display = 'none';
      let html = '';

      filtered.forEach(sub => {
        const stats = calcStats(sub);
        const cat = sub.category || 'theory';
        const colorVar = !stats.hasData ? 'var(--text-muted)' : (stats.isShort ? 'var(--danger)' : 'var(--success)');
        const safeSubName = escapeHtml(sub.name);
        const safeSubId = escapeHtml(sub.id);
        const safeCat = escapeHtml(cat);

        html += `
          <div class="subject-card ${stats.isShort ? 'is-short' : ''}">
            <div class="card-head">
              <div>
                <div class="card-meta">
                  <span class="cat-tag cat-${safeCat}">${safeCat.toUpperCase()}</span>
                  ${!stats.hasData ? `
                    <span class="criteria-pill pill-neutral">No classes yet</span>
                  ` : stats.isShort ? `
                    <span class="criteria-pill pill-short">
                      ${statusPillIcon('short')} Short by ${stats.shortagePct}%
                    </span>
                  ` : `
                    <span class="criteria-pill pill-safe">
                      ${statusPillIcon('safe')} On track · +${stats.surplusPct}%
                    </span>
                  `}
                </div>
                <h3 class="card-title">${safeSubName}</h3>
              </div>

              <div class="card-score">
                <span class="score-pct privacy-blur" style="color:${colorVar}">${stats.hasData ? `${stats.percentage}%` : '--'}</span>
                <span class="score-ratio privacy-blur">${stats.attended} / ${stats.total} held (${stats.missed} missed)</span>
              </div>
            </div>

            <!-- Analytics Dual-Badges -->
            <div class="card-analytics-row">
              <div class="analytic-chip ${stats.isShort ? 'alert-chip' : ''}">
                <span class="analytic-lbl">Min to reach ${stats.target}%</span>
                <span class="analytic-val ${!stats.hasData ? 'text-muted' : (stats.isShort ? 'text-danger' : 'text-success')} privacy-blur">
                  ${!stats.hasData ? 'Log a class first' : (stats.isShort ? (stats.minNeededToReach75 === null ? 'Not reachable at 100%' : `Attend ${stats.minNeededToReach75} in a row`) : '0 (Already Safe)')}
                </span>
              </div>

              <div class="analytic-chip ${stats.hasData && !stats.isShort ? 'safe-chip' : ''}">
                <span class="analytic-lbl">Max classes you can miss</span>
                <span class="analytic-val ${!stats.hasData ? 'text-muted' : (stats.maxCanMiss > 0 ? 'text-success' : 'text-danger')} privacy-blur">
                  ${!stats.hasData ? 'No data yet' : (stats.maxCanMiss > 0 ? `${stats.maxCanMiss} classes` : '0 bunks left')}
                </span>
              </div>
            </div>

            <!-- Progress bar with 75% target marker -->
            <div class="prog-wrapper">
              <div class="prog-marker-75" style="left:${stats.target}%;" title="${stats.target}% Target"></div>
              <div class="prog-fill" style="width:${stats.hasData ? Math.min(100, stats.pctNum) : 0}%; background:${colorVar};"></div>
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
                History
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
      const sub = appState.subjects.find(s => s.id === subId);
      const label = sub ? sub.name : 'Subject';
      const verb = status === 'present' ? 'present' : status === 'absent' ? 'absent' : 'off';
      showToast(`${label}: marked ${verb} for today.`, status === 'present' ? 'success' : status === 'absent' ? 'error' : 'info', 2400);
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
          id: 'hist_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
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

      if (!Number.isInteger(calCurrentYear) || !Number.isInteger(calCurrentMonth) || calCurrentMonth < 0 || calCurrentMonth > 11) {
        const now = new Date();
        calCurrentYear = now.getFullYear();
        calCurrentMonth = now.getMonth();
      }
      if (!isValidCalendarDateStr(calSelectedDate)) {
        calSelectedDate = getTodayDateStr();
      }

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
        let statusLabel = 'No logs';
        if (isHoliday) {
          dotClass = 'dot-hol';
          statusLabel = 'Holiday';
        } else if (presentCount > 0 && absentCount === 0) {
          dotClass = 'dot-pres';
          statusLabel = `${presentCount} present`;
        } else if (absentCount > 0 && presentCount === 0) {
          dotClass = 'dot-abs';
          statusLabel = `${absentCount} absent`;
        } else if (presentCount > 0 && absentCount > 0) {
          dotClass = 'dot-mix';
          statusLabel = `${presentCount} present, ${absentCount} absent`;
        }

        const ariaDate = new Date(calCurrentYear, calCurrentMonth, day).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
        const todayNote = isToday ? ', Today' : '';
        html += `
          <div class="cal-cell ${isToday ? 'is-today' : ''} ${isSelected ? 'is-selected' : ''} ${isHoliday ? 'is-holiday' : ''}"
               role="button" tabindex="0"
               aria-pressed="${isSelected ? 'true' : 'false'}"
               aria-label="${escapeHtml(`${ariaDate}${todayNote} (${statusLabel})`)}"
               data-action="selectCalendarDate" data-date="${escapeHtml(currentIsoDate)}">
            <span>${day}</span>
            ${dotClass ? `<div class="cal-dot-row" aria-hidden="true"><span class="cal-dot ${dotClass}"></span></div>` : ''}
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
      if (!isValidCalendarDateStr(dateStr)) return;
      calSelectedDate = dateStr;
      renderCalendar();
    }

    function renderCalendarDateDetail(dateStr) {
      const titleEl = document.getElementById('calSelectedDateText');
      const holidayBanner = document.getElementById('calSelectedDateHolidayBanner');
      const listEl = document.getElementById('calDailySubjectsList');
      const holidayBtn = document.getElementById('calToggleHolidayBtn');

      if (!titleEl || !listEl) return;

      const safeDateKey = isValidCalendarDateStr(dateStr) ? dateStr : getTodayDateStr();
      const dObj = parseLocalDateStr(safeDateKey) || new Date();
      titleEl.textContent = dObj.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });

      const dayData = appState.calendar[safeDateKey] || { isHoliday: false, entries: {} };
      const isHoliday = dayData.isHoliday;

      holidayBanner.style.display = isHoliday ? 'block' : 'none';
      holidayBtn.innerHTML = isHoliday ? 'Unmark Holiday' : 'Holiday';

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
        const safeDateStr = escapeHtml(safeDateKey);

        html += `
          <div class="day-sub-entry">
            <div class="day-sub-info">
              <div style="display:flex; align-items:center; gap:6px;">
                <span class="cat-tag cat-${safeCat}">${safeCat.toUpperCase()}</span>
                <strong style="font-size:13.5px; color:var(--text-strong);">${safeSubName}</strong>
              </div>
              <span style="font-size:11px; color:var(--text-muted); margin-top:2px;">
                Status on this day: 
                <span class="day-status-pill status-pill-${currentStatus}">
                  ${currentStatus === 'present' ? '✓ Present' : (currentStatus === 'absent' ? '✕ Absent' : (currentStatus === 'off' ? '— Off' : 'Not marked'))}
                </span>
              </span>
            </div>

            <div class="day-sub-actions">
              <button type="button" class="act-btn ${currentStatus === 'present' ? 'act-present' : ''}" data-action="recordAttendanceEntry" data-date="${safeDateStr}" data-subid="${safeSubId}" data-status="present" aria-label="Mark ${safeSubName} present">✓</button>
              <button type="button" class="act-btn ${currentStatus === 'absent' ? 'act-absent' : ''}" data-action="recordAttendanceEntry" data-date="${safeDateStr}" data-subid="${safeSubId}" data-status="absent" aria-label="Mark ${safeSubName} absent">✕</button>
              <button type="button" class="act-btn ${currentStatus === 'off' ? 'act-off' : ''}" data-action="recordAttendanceEntry" data-date="${safeDateStr}" data-subid="${safeSubId}" data-status="off" aria-label="Mark ${safeSubName} off">—</button>
              <button type="button" class="act-btn" data-action="clearAttendanceEntry" data-date="${safeDateStr}" data-subid="${safeSubId}" aria-label="Clear the ${safeSubName} entry for this day" title="Clear entry">⟲</button>
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
      document.getElementById('histScorePct').textContent = stats.hasData ? `${stats.percentage}%` : '--';
      document.getElementById('histScorePct').style.color = !stats.hasData ? 'var(--text-muted)' : (stats.isShort ? 'var(--danger)' : 'var(--success)');
      document.getElementById('histRatio').textContent = `${stats.attended}/${stats.total} Classes Held (${stats.missed} Missed)`;

      if (!stats.hasData) {
        document.getElementById('histGoalText').textContent = 'No classes logged yet';
        document.getElementById('histGoalText').style.color = 'var(--text-muted)';
      } else if (stats.isShort) {
        document.getElementById('histGoalText').textContent = stats.minNeededToReach75 === null
          ? 'Not reachable at 100% target'
          : `Min to ${stats.target}%: Attend ${stats.minNeededToReach75} in a row`;
        document.getElementById('histGoalText').style.color = 'var(--danger-text)';
      } else {
        document.getElementById('histGoalText').textContent = `Max you can miss: ${stats.maxCanMiss} classes`;
        document.getElementById('histGoalText').style.color = 'var(--success-text)';
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
      const rawDate = prompt('Enter date for attendance entry (YYYY-MM-DD):', getTodayDateStr());
      if (rawDate === null) return;
      const date = rawDate.trim();
      if (!isValidCalendarDateStr(date)) {
        notify('Invalid date. Please enter a real calendar date in YYYY-MM-DD format.');
        return;
      }

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
        notify('Please enter your name to customize your attendance dashboard.');
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

      notify(`Semester Setup Saved.
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
      if (!name) {
        notify('Please enter a valid subject name.');
        return;
      }
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
          id: 'sub_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          name,
          category,
          attended,
          total,
          target: appState.globalTarget
        });
      }

      appState.isSetupCompleted = true;
      closeSingleModal();
      saveState();
    }

    function deleteCurrentSingle() {
      const id = document.getElementById('singleEditId').value;
      if (id && confirm('Delete this subject and its records?')) {
        appState.subjects = appState.subjects.filter(s => s.id !== id);
        appState.history = (appState.history || []).filter(h => h.subId !== id);
        if (appState.calendar && typeof appState.calendar === 'object') {
          Object.keys(appState.calendar).forEach(dateKey => {
            if (appState.calendar[dateKey] && appState.calendar[dateKey].entries) {
              delete appState.calendar[dateKey].entries[id];
            }
          });
        }
        if (currentHistorySubId === id) closeHistoryDrawer();
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
      (appState.subjects || []).forEach(sub => {
        sub.target = appState.globalTarget;
      });
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
      const emptyEl = document.getElementById('calcEmptyState');
      const layoutEl = document.getElementById('calcLayout');
      const hasSubs = Array.isArray(appState.subjects) && appState.subjects.length > 0;

      if (emptyEl) emptyEl.style.display = hasSubs ? 'none' : 'flex';
      if (layoutEl) layoutEl.style.display = hasSubs ? '' : 'none';
      if (!sel) return;

      const prevVal = sel.value;
      sel.innerHTML = '';

      appState.subjects.forEach(sub => {
        const opt = document.createElement('option');
        opt.value = sub.id;
        const pct = sub.total > 0 ? `${((sub.attended / sub.total) * 100).toFixed(1)}%` : '--%';
        opt.textContent = `${sub.name} (${sub.attended}/${sub.total} · ${pct})`;
        sel.appendChild(opt);
      });

      if (prevVal && appState.subjects.some(s => s.id === prevVal)) {
        sel.value = prevVal;
      }
    }

    function adjustSimInput(inputId, delta) {
      const inp = document.getElementById(inputId);
      if (!inp) return;
      const cur = Math.max(0, parseInt(inp.value, 10) || 0);
      inp.value = String(Math.max(0, Math.min(500, cur + delta)));
      runSimulation();
    }

    function resetSimulation() {
      const attInp = document.getElementById('calcAttendNext');
      const bunkInp = document.getElementById('calcBunkNext');
      if (attInp) attInp.value = '0';
      if (bunkInp) bunkInp.value = '0';
      runSimulation();
    }

    function runSimulation() {
      const sel = document.getElementById('calcSubjectSelect');
      const attInp = document.getElementById('calcAttendNext');
      const bunkInp = document.getElementById('calcBunkNext');
      const numEl = document.getElementById('calcProjectedPercent');
      const pillWrap = document.getElementById('calcProjectedPillWrap');
      const resText = document.getElementById('calcProjectedText');
      const curSummary = document.getElementById('calcCurrentSummary');

      if (!sel || !sel.value) {
        if (numEl) {
          numEl.textContent = '--%';
          numEl.style.color = 'var(--text-muted)';
        }
        if (pillWrap) pillWrap.innerHTML = '';
        if (resText) resText.textContent = 'Add subjects to run a simulation.';
        if (curSummary) curSummary.innerHTML = '<span>Current standing</span><strong style="color:var(--text-strong);">--</strong>';
        return;
      }

      const sub = appState.subjects.find(s => s.id === sel.value);
      if (!sub) return;

      const curStats = calcStats(sub);
      if (curSummary) {
        curSummary.innerHTML = `
          <span>Current standing</span>
          <strong style="color:var(--text-strong);">${curStats.attended}/${curStats.total} (${curStats.hasData ? `${curStats.percentage}%` : '--%'})</strong>
        `;
      }

      const addAtt = Math.max(0, Math.min(500, parseInt(attInp.value, 10) || 0));
      const addBunk = Math.max(0, Math.min(500, parseInt(bunkInp.value, 10) || 0));

      const newAtt = sub.attended + addAtt;
      const newTot = sub.total + addAtt + addBunk;
      const target = sub.target || appState.globalTarget || 75;

      if (newTot === 0) {
        numEl.textContent = '--%';
        numEl.style.color = 'var(--text-muted)';
        pillWrap.innerHTML = '';
        resText.textContent = 'Increase Attend Next or Bunk Next above 0 to preview projected attendance.';
        return;
      }

      const pctNum = (newAtt / newTot) * 100;
      const pctStr = pctNum.toFixed(1);

      numEl.textContent = `${pctStr}%`;
      numEl.style.color = pctNum < target ? 'var(--danger)' : 'var(--success)';

      const deltaText = addAtt === 0 && addBunk === 0
        ? 'No upcoming changes applied yet.'
        : `After +${addAtt} attended & +${addBunk} missed (${newAtt}/${newTot} total):`;

      if (pctNum < target) {
        const gap = (target - pctNum).toFixed(1);
        const needMore = target < 100
          ? Math.max(1, Math.ceil(((target * newTot) - (100 * newAtt)) / (100 - target)))
          : null;
        pillWrap.innerHTML = `<span class="criteria-pill pill-short">${statusPillIcon('short')} Below target · Short by ${gap}%</span>`;
        resText.innerHTML = `${deltaText} <strong>Target not achieved</strong> (${target}%).${needMore !== null ? ` You would still need <strong>${needMore}</strong> consecutive present ${needMore === 1 ? 'class' : 'classes'}.` : ''}`;
      } else {
        const surplus = (pctNum - target).toFixed(1);
        const safeBunks = target > 0 ? Math.max(0, Math.floor((100 * newAtt) / target) - newTot) : 0;
        pillWrap.innerHTML = `<span class="criteria-pill pill-safe">${statusPillIcon('safe')} Target achieved · +${surplus}%</span>`;
        resText.innerHTML = `${deltaText} <strong>Meets ${target}% target</strong> with room to miss <strong>${safeBunks}</strong> more ${safeBunks === 1 ? 'class' : 'classes'}.`;
      }
    }

    // 16. TAB SWITCHER
    function switchTab(tab) {
      appState.activeTab = tab;
      document.querySelectorAll('.nav-item').forEach((btn) => {
        const isActive = btn.getAttribute('data-tab') === tab;
        btn.classList.toggle('active', isActive);
        if (isActive) btn.setAttribute('aria-current', 'page');
        else btn.removeAttribute('aria-current');
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
      if (tab === 'analytics') {
        document.getElementById('viewAnalytics').classList.add('active');
      }
      if (tab === 'timetable') {
        document.getElementById('viewTimetable').classList.add('active');
      }
      if (tab === 'settings') {
        document.getElementById('viewSettings').classList.add('active');
      }

      if (window.AttendifyFeatures && typeof window.AttendifyFeatures.onTab === 'function') {
        window.AttendifyFeatures.onTab(tab);
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
        themeMode: appState.themeMode,
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
        const status = !stats.hasData ? 'No classes yet' : (stats.isShort ? `Short by ${stats.shortagePct}%` : `On track (+${stats.surplusPct}%)`);
        const needed = !stats.hasData ? '-' : (stats.isShort ? `${stats.minNeededToReach75} in a row` : '0');
        const bunks = stats.hasData ? stats.maxCanMiss : '-';
        const pctCell = stats.hasData ? `${stats.percentage}%` : '';

        csv += `${nameEscaped},${catEscaped},${stats.attended},${stats.total},${stats.missed},${pctCell},${status},${needed},${bunks}\r\n`;
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
        notify('Security check failed: File size exceeds 5MB limit.');
        e.target.value = '';
        return;
      }

      const reader = new FileReader();
      reader.onload = (event) => {
        try {
          const rawParsed = JSON.parse(event.target.result);
          // Run rigorous schema validation
          const validated = validateAndSanitizeState(rawParsed);
          const previousAccountEmail = appState.accountEmail;
          const previousAuthChoice = appState.authChoice;

          appState = validated;
          if (!appState.accountEmail && previousAccountEmail) {
            appState.accountEmail = previousAccountEmail;
            appState.authChoice = 'account';
          } else if (!appState.accountEmail && previousAuthChoice === 'guest') {
            appState.authChoice = 'guest';
          }
          applyThemeUI(appState.activeTheme || 'graphite');
          applyPrivacyModeUI();
          saveState();

          notify(`Backup verified and loaded safely.\n• ${appState.subjects.length} subjects imported.\n• ${appState.history.length} logged sessions verified.`);
        } catch (err) {
          notify('Security Validation Error:\n' + (err.message || 'Invalid or corrupted JSON backup file.'));
        }
        e.target.value = '';
      };
      reader.onerror = () => {
        notify('Failed to read file.');
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

      try {
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
        lastSyncState = 'idle';
        resetKeyVisibility();

        applyThemeUI('graphite');
        applyPrivacyModeUI();
        saveStateOnly();
        closeDeleteModal();

        // 3. User feedback
        if (cloudDeleteResult === 'deleted') {
          notify('Attendify has been reset.\n\n• Local attendance records erased.\n• Cloud backup permanently deleted.');
        } else if (cloudDeleteResult === 'not_found' || cloudDeleteResult === 'skipped') {
          notify('Attendify has been reset.\n\n• Local attendance records erased.');
        } else {
          notify('Local attendance records erased.\n\nNote: Could not reach cloud server to delete remote backup. Please reconnect and wipe your cloud record if needed.');
        }

        setTimeout(openAuthGate, 150);
      } finally {
        if (deleteBtn) {
          deleteBtn.disabled = false;
          deleteBtn.innerHTML = originalBtnText;
        }
      }
    }

    async function wipeCloudBackupOnly() {
      if (!appState.syncCode || !appState.syncAuthKey) {
        notify('No cloud backup credentials found on this device.');
        return;
      }

      const confirmed = confirm(
        `Permanently delete cloud backup for sync code "${appState.syncCode}"?\n\nThis will remove your stored attendance data from the cloud server.\n\nYour local data on this phone will NOT be deleted.`
      );
      if (!confirmed) return;

      const wipeBtn = document.querySelector('[data-action="wipeCloudBackupOnly"]');
      const originalText = wipeBtn ? wipeBtn.innerHTML : '';
      if (wipeBtn) {
        wipeBtn.disabled = true;
        wipeBtn.innerHTML = 'Deleting from cloud...';
      }

      const statusEl = document.getElementById('topCloudStatus');
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger-text);">Deleting...</span>';

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
        lastSyncState = 'idle';
        saveStateOnly();

        if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-dim);">Wiped</span>';
        const lastSyncEl = document.getElementById('settingsLastSyncTime');
        if (lastSyncEl) lastSyncEl.textContent = 'Deleted from server';
        updateCloudStatusUI();

        if (resData.status === 'deleted') {
          notify('Cloud backup has been permanently deleted from the server.');
        } else if (resData.status === 'not_found') {
          notify('No backup was found in the cloud for this sync code. Nothing to delete.');
        } else {
          notify('Cloud deletion completed successfully.');
        }
      } catch (err) {
        notify('Error deleting cloud backup: ' + err.message);
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--danger-text);">Error</span>';
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

    // Compact device fingerprint for the admin console. No full user-agent string
    // is stored: only a readable label and a few coarse classification fields.
    // macOS cannot distinguish MacBook from desktop Mac in a browser, so it is
    // intentionally labelled "MacBook / Mac" rather than guessing.
    function getDeviceProfile() {
      const nav = navigator || {};
      const ua = String(nav.userAgent || '');
      const platform = String(nav.platform || '');
      const maxTouchPoints = Number(nav.maxTouchPoints || 0);
      const android = /Android/i.test(ua);
      const iPhone = /iPhone/i.test(ua);
      const iPod = /iPod/i.test(ua);
      // iPadOS 13+ reports a desktop Mac user-agent; touch points reveal the iPad.
      const iPad = /iPad/i.test(ua) || (/Macintosh/i.test(ua) && /MacIntel/.test(platform) && maxTouchPoints > 1);
      const iOS = iPhone || iPad || iPod;
      const tablet = iPad || /Tablet/i.test(ua) || (android && !/Mobile/i.test(ua));
      const mobile = android || iOS || /Mobile/i.test(ua);
      const twa = android && /; wv\)/.test(ua);
      const iosVersion = (ua.match(/OS\s+([\d_]+)/) || [])[1];
      const androidVersion = (ua.match(/Android\s+([\d.]+)/) || [])[1];

      let os = 'Unknown OS';
      if (iPad) os = 'iPadOS' + (iosVersion ? ' ' + iosVersion.replace(/_/g, '.') : '');
      else if (iPhone || iPod) os = 'iOS' + (iosVersion ? ' ' + iosVersion.replace(/_/g, '.') : '');
      else if (/Windows NT 10\.0/.test(ua)) os = 'Windows 10/11';
      else if (/Windows NT/.test(ua)) os = 'Windows';
      else if (android) os = 'Android' + (androidVersion ? ' ' + androidVersion : '');
      else if (/CrOS/.test(ua)) os = 'ChromeOS';
      else if (/Mac OS X|Macintosh/.test(ua)) os = 'macOS';
      else if (/Linux/.test(ua)) os = 'Linux';
      else if (platform) os = platform;

      let browser = 'Browser';
      if (/SamsungBrowser/i.test(ua)) browser = 'Samsung Internet';
      else if (/EdgA?\//i.test(ua)) browser = 'Edge';
      else if (/OPR\/|Opera/i.test(ua)) browser = 'Opera';
      else if (/Firefox\/|FxiOS/i.test(ua)) browser = 'Firefox';
      else if (/Chrome\/|CriOS/.test(ua)) browser = 'Chrome';
      else if (/Safari\//i.test(ua)) browser = 'Safari';

      let model = '';
      if (iPhone) model = 'iPhone';
      else if (iPad) model = 'iPad';
      else if (iPod) model = 'iPod touch';
      else if (android) {
        const androidModel = (ua.match(/Android[^;]*;\s*([^;)]+)/) || [])[1];
        model = androidModel ? androidModel.trim().replace(/\s+Build\/.*$/, '') : 'Android device';
        if (/^SM-/.test(model)) model = 'Samsung Galaxy ' + model.slice(3);
        else if (/Pixel/i.test(model)) model = 'Google ' + model;
      } else if (/CrOS/.test(ua)) model = 'Chromebook';
      else if (/Windows/.test(ua)) model = 'Windows PC';
      else if (/Macintosh|Mac OS X/.test(ua)) model = 'MacBook / Mac';
      else if (/Linux/.test(ua)) model = 'Linux PC';
      else if (platform) model = platform;

      const type = tablet ? 'Tablet' : (mobile ? 'Mobile' : 'Desktop');
      const access = twa ? 'Attendify APK (TWA)' : 'Browser / PWA';
      const channel = twa ? 'Attendify APK' : browser;
      const label = [model || type, channel].filter(Boolean).join(' · ');
      const clean = (v, max) => String(v || '').replace(/[<>]/g, '').trim().slice(0, max);

      return {
        label: clean(label, 80) || 'Unknown device',
        type: clean(type, 20),
        browser: clean(browser, 30),
        os: clean(os, 40),
        model: clean(model, 60),
        screen: clean(window.innerWidth + 'x' + window.innerHeight, 20),
        access: clean(access, 40),
        updatedAt: new Date().toISOString()
      };
    }

    // Single entry point for the Attendify Sync API.
    // Endpoints: POST /auth/register, POST /auth/login, POST /push,
    //            POST /pull, POST /delete, GET /health
    async function syncApiRequest(path, payload, timeoutMs = 15000) {
      const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
      try {
        return await fetch(`${SYNC_API_URL}${path}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller ? controller.signal : undefined
        });
      } catch (err) {
        if (err && err.name === 'AbortError') {
          throw new Error('Request timed out. Please check your connection and try again.');
        }
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
      }
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

    let isSyncInFlight = false;
    let lastSyncState = 'idle';

    async function syncToCloudStorage() {
      if (isSyncInFlight) return { ok: false, busy: true };
      isSyncInFlight = true;
      lastSyncState = 'syncing';

      if (!appState.syncCode || !appState.syncCode.startsWith('ATN-')) appState.syncCode = generateSyncCode();
      if (!appState.syncAuthKey) appState.syncAuthKey = generateAuthToken();

      const statusEl = document.getElementById('topCloudStatus');
      if (statusEl) statusEl.innerHTML = '<span style="color:var(--warning-text);">Syncing...</span>';
      updateCloudStatusUI();

      const payload = {
        sync_code: appState.syncCode,
        auth_token: appState.syncAuthKey,
        data: {
          studentName: appState.studentName || '',
          accountEmail: appState.accountEmail || '',
          subjects: appState.subjects || [],
          calendar: appState.calendar || {},
          history: appState.history || [],
          globalTarget: appState.globalTarget || 75,
          activeTheme: appState.activeTheme || 'graphite',
          themeMode: appState.themeMode || 'dark',
          privacyMode: appState.privacyMode || false,
          timetable: appState.timetable || [],
          notifPrefs: appState.notifPrefs || {},
          simScenarios: appState.simScenarios || [],
          localUpdatedAt: appState.localUpdatedAt || 0,
          device: getDeviceProfile(),
          lastUpdated: new Date().toISOString()
        }
      };

      try {
        const response = await syncApiRequest('/push', payload);

        if (response.ok) {
          appState.lastSyncedAt = Date.now();
          lastSyncState = 'synced';
          try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));
          } catch (storageErr) {
            console.warn('Could not persist lastSyncedAt:', storageErr);
          }
          if (statusEl) statusEl.innerHTML = '<span style="color:var(--success-text);">Synced</span>';
          updateCloudStatusUI();
          const lastSyncEl = document.getElementById('settingsLastSyncTime');
          if (lastSyncEl) lastSyncEl.textContent = new Date(appState.lastSyncedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
          return { ok: true };
        } else {
          lastSyncState = 'error';
          const errData = await response.json().catch(() => ({}));
          console.warn('Cloud sync response error:', response.status, errData);
          if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-dim);">Local</span>';
          updateCloudStatusUI();
          return { ok: false, error: errData.error || `Server error (${response.status})` };
        }
      } catch (err) {
        lastSyncState = (typeof navigator !== 'undefined' && navigator.onLine === false) ? 'offline' : 'error';
        console.warn('Offline or network error syncing to cloud:', err);
        if (statusEl) statusEl.innerHTML = '<span style="color:var(--text-dim);">Offline</span>';
        updateCloudStatusUI();
        return { ok: false, error: err.message || 'Network unavailable' };
      } finally {
        isSyncInFlight = false;
        const headerBtn = document.getElementById('headerCloudSyncBtn');
        if (headerBtn) headerBtn.style.opacity = '1';
      }
    }

    async function triggerManualSync() {
      const syncBtn = document.querySelector('[data-action="triggerManualSync"]');
      if (syncBtn && syncBtn.disabled) return;
      const originalText = syncBtn ? syncBtn.textContent : 'Sync now';
      if (syncBtn) {
        syncBtn.disabled = true;
        syncBtn.textContent = 'Syncing...';
      }

      try {
        const res = await syncToCloudStorage();
        if (res && res.busy) return;
        if (res && res.ok) {
          notify(`Cloud backup synced.\nYour records are backed up under Code: ${appState.syncCode}`);
        } else {
          notify(`Cloud sync failed: ${(res && res.error) || 'Network unavailable'}. Your records remain saved locally.`);
        }
      } finally {
        if (syncBtn) {
          syncBtn.disabled = false;
          syncBtn.textContent = originalText;
        }
      }
    }

    
    let isKeyVisible = false;
    function resetKeyVisibility() {
      isKeyVisible = false;
      const keyEl = document.getElementById('settingsSyncKeyDisplay');
      const btn = document.getElementById('toggleKeyVisibilityBtn');
      if (keyEl) keyEl.textContent = '••••••••••••••••';
      if (btn) btn.textContent = 'Show';
    }
    function toggleKeyVisibility() {
      isKeyVisible = !isKeyVisible;
      const keyEl = document.getElementById('settingsSyncKeyDisplay');
      const btn = document.getElementById('toggleKeyVisibilityBtn');
      if (!keyEl) return;
      if (isKeyVisible) {
        keyEl.textContent = appState.syncAuthKey || 'No Key';
        if (btn) btn.textContent = 'Hide';
      } else {
        keyEl.textContent = '••••••••••••••••';
        if (btn) btn.textContent = 'Show';
      }
    }

    function copySyncKey() {
      if (!appState.syncAuthKey) return;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(appState.syncAuthKey).then(() => {
          notify('Private Secret Key copied to clipboard! Keep this safe.');
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
          notify('Full Pairing Token copied (Code:Key)!\nPaste this into Attendify on your other device for instant 1-tap restore.');
        }).catch(() => {
          prompt('Copy Pairing Token (Code:Key):', combo);
        });
      } else {
        prompt('Copy Pairing Token (Code:Key):', combo);
      }
    }

    function copySyncCode() {
      if (!appState.syncCode) return;
      if (navigator.clipboard) {
        navigator.clipboard.writeText(appState.syncCode).then(() => {
          notify(`Copied Cloud Sync Code: ${appState.syncCode}
Save this code to restore your courses on another phone or computer!`);
        }).catch(() => {
          prompt('Copy your Cloud Sync Code:', appState.syncCode);
        });
      } else {
        prompt('Copy your Cloud Sync Code:', appState.syncCode);
      }
    }

    function openRestoreCloudModal() {
      document.getElementById('restoreCloudModal').classList.add('open');
      setTimeout(() => document.getElementById('restoreSyncCodeInput').focus(), 100);
    }
    function closeRestoreCloudModal() {
      document.getElementById('restoreCloudModal').classList.remove('open');
    }

    let isRestoreInFlight = false;
    async function confirmRestoreFromCloud() {
      if (isRestoreInFlight) return;

      const codeInput = document.getElementById('restoreSyncCodeInput');
      const keyInput = document.getElementById('restoreAuthKeyInput');
      const restoreBtn = document.querySelector('[data-action="confirmRestoreFromCloud"]');
      let code = (codeInput ? codeInput.value : '').trim();
      let key = (keyInput ? keyInput.value : '').trim();

      // Check if user pasted a combined token (CODE:KEY)
      if (code.includes(':')) {
        const parts = code.split(':');
        code = parts[0].trim();
        key = parts.slice(1).join(':').trim();
      }

      if (!code) {
        notify('Please enter your Cloud Sync Code.');
        return;
      }
      if (!key) {
        notify('Please enter your Private Secret Key (Authorization) to restore this sync code.');
        return;
      }

      isRestoreInFlight = true;
      const originalText = restoreBtn ? restoreBtn.textContent : 'Fetch & Restore';
      if (restoreBtn) {
        restoreBtn.disabled = true;
        restoreBtn.textContent = 'Restoring...';
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
            notify('Authorization Failed: The secret key does not match this Sync Code.');
          } else if (response.status === 404 || response.status === 400 || errMsg.includes('Record not found')) {
            notify('Sync code not found in Cloud Storage. Please check for typos.');
          } else {
            notify('Cloud Restore Error: ' + (errMsg || `HTTP ${response.status}`));
          }
          return;
        }

        const resJson = await response.json();
        const cloudData = resJson.data;
        if (!cloudData) {
          throw new Error('Cloud storage record returned empty data.');
        }

        const validated = validateAndSanitizeState(cloudData);
        const existingAccountEmail = appState.accountEmail || '';
        const existingAuthChoice = appState.authChoice || '';
        appState = validated;
        appState.accountEmail = cloudData.accountEmail || existingAccountEmail;
        appState.authChoice = appState.accountEmail
          ? (validated.authChoice || 'account')
          : (existingAuthChoice || 'guest');
        appState.syncCode = code;
        appState.syncAuthKey = key;
        appState.isSetupCompleted = true;
        appState.lastSyncedAt = Date.now();
        appState.studentName = sanitizeText(cloudData.studentName || '');

        resetKeyVisibility();
        if (codeInput) codeInput.value = '';
        if (keyInput) keyInput.value = '';
        applyThemeUI(appState.activeTheme || 'graphite');
        applyPrivacyModeUI();
        saveStateOnly();
        renderCalendar();
        closeRestoreCloudModal();

        notify(`Cloud Restore Successful.\nWelcome back, ${appState.studentName || 'Student'}!\nRestored ${appState.subjects.length} subjects from cloud backup.`);
      } catch (err) {
        notify('Error connecting to Cloud Storage: ' + err.message);
      } finally {
        isRestoreInFlight = false;
        if (restoreBtn) {
          restoreBtn.disabled = false;
          restoreBtn.textContent = originalText;
        }
      }
    }

    // -------------------------------------------------------------
    // EMAIL / PASSWORD ACCOUNTS
    // -------------------------------------------------------------
    // -------------------------------------------------------------
    // FIRST-RUN ACCOUNT GATE — a choice is required before using the app
    // -------------------------------------------------------------
    function needsAuthGate() {
      return !appState.accountEmail && appState.authChoice !== 'guest';
    }

    function openSetupIfNeeded() {
      if (!appState.isSetupCompleted || !appState.subjects || appState.subjects.length === 0) {
        setTimeout(() => openSetupModal(), 150);
      }
    }

    function openAuthGate() {
      const modal = document.getElementById('authGateModal');
      if (modal) modal.classList.add('open');
    }

    function closeAuthGate() {
      const modal = document.getElementById('authGateModal');
      if (modal) modal.classList.remove('open');
    }

    function continueAsGuest() {
      appState.authChoice = 'guest';
      saveStateOnly();
      closeAuthGate();
      renderApp();
      // Prompt for setup when there is no usable semester yet. This also catches
      // older guest states that only contain empty 0/0 subjects.
      const hasLoggedClasses = (appState.subjects || []).some(sub => Number(sub.total) > 0);
      if (!appState.isSetupCompleted || !appState.subjects || appState.subjects.length === 0 || !hasLoggedClasses) {
        setTimeout(() => openSetupModal(), 150);
      }
    }

    function openAccountFromGate() {
      closeAuthGate();
      openAccountModal();
    }

    const ACCOUNT_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

    function setAccountMessage(text, kind) {
      const color = kind === 'error' ? 'var(--danger)' :
                    kind === 'success' ? 'var(--success-text)' : 'var(--text-muted)';
      ['accountMessage', 'accountModalMessage'].forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = text || '';
        el.style.color = color;
      });
    }

    function updateAccountUI() {
      const signedIn = Boolean(appState.accountEmail);
      const badge = document.getElementById('accountStatusBadge');
      if (badge) {
        badge.textContent = signedIn ? 'Signed in' : (appState.authChoice === 'guest' ? 'Guest' : 'Not signed in');
        badge.className = 'criteria-pill ' + (signedIn ? 'pill-safe' : 'pill-neutral');
      }
      [
        ['accountSignedOutPanel', 'accountSignedInPanel', 'accountEmailDisplay'],
        ['accountModalSignedOut', 'accountModalSignedIn', 'accountModalEmailDisplay']
      ].forEach(([outId, inId, displayId]) => {
        const out = document.getElementById(outId);
        const inn = document.getElementById(inId);
        if (out) out.style.display = signedIn ? 'none' : '';
        if (inn) inn.style.display = signedIn ? '' : 'none';
        const display = document.getElementById(displayId);
        if (display) display.textContent = appState.accountEmail || '--';
      });
      const headerBtn = document.getElementById('headerAccountBtn');
      if (headerBtn) {
        headerBtn.title = signedIn
          ? `Signed in as ${appState.accountEmail}`
          : (appState.authChoice === 'guest' ? 'Guest mode — tap to create an account' : 'Sign up or sign in');
      }
    }

    function openAccountModal() {
      updateAccountUI();
      const modal = document.getElementById('accountModal');
      if (modal) modal.classList.add('open');
      setTimeout(() => {
        const target = appState.accountEmail
          ? document.getElementById('accountModalSignedIn')
          : document.getElementById('accountModalEmail');
        if (target && target.focus) target.focus();
      }, 100);
    }

    function closeAccountModal() {
      const modal = document.getElementById('accountModal');
      if (modal) modal.classList.remove('open');
      if (needsAuthGate()) setTimeout(openAuthGate, 100);
    }

    function readAccountForm(requireStrongPassword, modal) {
      const emailId = modal ? 'accountModalEmail' : 'accountEmailInput';
      const pwId = modal ? 'accountModalPassword' : 'accountPasswordInput';
      const emailEl = document.getElementById(emailId);
      const pwEl = document.getElementById(pwId);
      const email = ((emailEl && emailEl.value) || '').trim().toLowerCase();
      const password = (pwEl && pwEl.value) || '';
      if (!ACCOUNT_EMAIL_RE.test(email)) {
        setAccountMessage('Enter a valid email address.', 'error');
        return null;
      }
      if (requireStrongPassword) {
        if (password.length < 8 || !/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) {
          setAccountMessage('Use 8+ characters with at least one letter and one number.', 'error');
          return null;
        }
      } else if (!password) {
        setAccountMessage('Enter your password.', 'error');
        return null;
      }
      return { email, password };
    }

    function setAccountBusy(busy) {
      ['createAccountBtn', 'signInBtn', 'createAccountModalBtn', 'signInModalBtn'].forEach((id) => {
        const btn = document.getElementById(id);
        if (btn) btn.disabled = busy;
      });
    }

    async function accountRequest(path, body) {
      const response = await syncApiRequest(path, body);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data.error || `Request failed (${response.status})`);
      }
      return data;
    }

    async function adoptAccountSession(data, restoreCloud) {
      appState.accountEmail = data.email || '';
      appState.authChoice = 'account';
      closeAuthGate();
      appState.syncCode = data.sync_code;
      appState.syncAuthKey = data.auth_token;
      if (data.student_name && !appState.studentName) {
        appState.studentName = sanitizeText(data.student_name).substring(0, 50);
      }
      saveStateOnly();

      let pulledFromCloud = false;
      if (restoreCloud) {
        try {
          const response = await syncApiRequest('/pull', {
            sync_code: appState.syncCode,
            auth_token: appState.syncAuthKey
          });
          if (response.ok) {
            const cloudJson = await response.json();
            if (cloudJson.data) {
              const restored = validateAndSanitizeState(cloudJson.data);
              restored.accountEmail = appState.accountEmail;
              restored.syncCode = appState.syncCode;
              restored.syncAuthKey = appState.syncAuthKey;
              restored.authChoice = 'account';
              restored.isSetupCompleted = true;
              restored.lastSyncedAt = Date.now();
              appState = restored;
              pulledFromCloud = true;
              applyThemeUI(appState.activeTheme || 'graphite');
              applyPrivacyModeUI();
              saveStateOnly();
            }
          } else if (response.status !== 404) {
            notify('Signed in, but cloud restore returned an error. Local records were kept.');
          }
        } catch (err) {
          console.warn('Could not pull cloud data after sign in:', err);
          notify('Signed in, but could not reach cloud storage right now. Local records were kept.');
        }
      }

      resetKeyVisibility();
      renderApp();
      renderCalendar();
      ['accountPasswordInput', 'accountModalPassword'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });

      let syncRes = { ok: pulledFromCloud };
      if (!pulledFromCloud) {
        syncRes = await syncToCloudStorage();
      }
      setAccountMessage(
        restoreCloud
          ? (pulledFromCloud ? 'Signed in and restored from cloud.' : 'Signed in. No cloud backup found yet—using device data.')
          : (syncRes && syncRes.ok ? 'Account created and synced to cloud.' : 'Account created. Cloud sync will retry when online.'),
        'success'
      );
      openSetupIfNeeded();
    }

    async function createAccount(modal) {
      const creds = readAccountForm(true, modal);
      if (!creds) return;
      setAccountBusy(true);
      setAccountMessage('Creating your account...');
      try {
        const data = await accountRequest('/auth/register', {
          email: creds.email,
          password: creds.password,
          student_name: appState.studentName || ''
        });
        await adoptAccountSession(data, false);
      } catch (err) {
        setAccountMessage(err.message, 'error');
      } finally {
        setAccountBusy(false);
      }
    }

    async function signIn(modal) {
      const creds = readAccountForm(false, modal);
      if (!creds) return;
      setAccountBusy(true);
      setAccountMessage('Signing in...');
      try {
        const data = await accountRequest('/auth/login', creds);
        const restore = confirm(
          'Signed in successfully.\n\n' +
          'OK — Restore your cloud attendance data to this device (replaces data currently on this device).\n' +
          'Cancel — Keep this device\'s data and sync it to your account instead.'
        );
        await adoptAccountSession(data, restore);
      } catch (err) {
        setAccountMessage(err.message, 'error');
      } finally {
        setAccountBusy(false);
      }
    }

    function signOut() {
      if (!confirm('Sign out of your Attendify account? Your records stay on this device.')) return;
      appState.accountEmail = '';
      appState.authChoice = '';
      appState.lastSyncedAt = null;
      lastSyncState = 'idle';
      appState.syncCode = generateSyncCode();
      appState.syncAuthKey = generateAuthToken();
      resetKeyVisibility();
      ['accountPasswordInput', 'accountModalPassword'].forEach((id) => {
        const el = document.getElementById(id);
        if (el) el.value = '';
      });
      saveStateOnly();
      renderApp();
      setAccountMessage('Signed out. Choose how to continue.', 'success');
      setTimeout(openAuthGate, 150);
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
      }
      closeEditNameModal();
    }

    function initServiceWorker() {
      if ('serviceWorker' in navigator) {
        const hadController = Boolean(navigator.serviceWorker.controller);
        let reloaded = false;
        if (hadController) {
          navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (reloaded) return;
            reloaded = true;
            window.location.reload();
          });
        }
        navigator.serviceWorker.register('./sw.js?v=20261127r13', { updateViaCache: 'none' })
          .then((reg) => {
            if (reg && typeof reg.update === 'function') reg.update().catch(() => {});
          })
          .catch(() => {});
      }
    }
  

    // =============================================================
    // GLOBAL EVENT DELEGATION & HARDENED EVENT BINDINGS
    // Enforces zero-inline handlers to satisfy strict CSP (script-src 'self')
    // =============================================================

    document.addEventListener('click', (e) => {
      // Backdrop click closes open modal
      if (e.target.classList.contains('modal-backdrop')) {
        if (e.target.getAttribute('data-locked') !== 'true') e.target.classList.remove('open');
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
        case 'clearAttendanceEntry':
          recordAttendanceEntry(el.getAttribute('data-date'), el.getAttribute('data-subid'), 'none');
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
          setAppTheme(el.getAttribute('data-accent') || el.getAttribute('data-theme'));
          break;
        case 'setThemeMode':
          setThemeMode(el.getAttribute('data-mode'));
          break;
        case 'toggleThemeMode':
          toggleThemeMode();
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
        case 'gateCreateAccount':
        case 'gateSignIn':
          openAccountFromGate();
          break;
        case 'continueAsGuest':
          continueAsGuest();
          break;
        case 'openAccountModal':
          openAccountModal();
          break;
        case 'closeAccountModal':
          closeAccountModal();
          break;
        case 'createAccount':
          createAccount(false);
          break;
        case 'signIn':
          signIn(false);
          break;
        case 'createAccountModal':
          createAccount(true);
          break;
        case 'signInModal':
          signIn(true);
          break;
        case 'signOut':
        case 'signOutModal':
          signOut();
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
        case 'adjustSimInput':
          adjustSimInput(el.getAttribute('data-target'), parseInt(el.getAttribute('data-delta'), 10) || 0);
          break;
        case 'resetSimulation':
          resetSimulation();
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
          const joinedKey = parts.slice(1).join(':').trim();
          if (restoreAuthKeyInput && joinedKey) {
            restoreAuthKeyInput.value = joinedKey;
          }
        }
      });
    }

    // Accessibility: Close modals with Escape & activate role="button" elements with Enter/Space
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-backdrop.open').forEach((m) => {
          if (m.getAttribute('data-locked') !== 'true') m.classList.remove('open');
        });
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        const target = e.target;
        if (!target) return;
        if (target.matches('[role="button"][data-action]')) {
          e.preventDefault();
          target.click();
        } else if (target.matches('label.settings-link')) {
          const inp = target.querySelector('input[type="file"]');
          if (inp) {
            e.preventDefault();
            inp.click();
          }
        }
      }
    });

    window.addEventListener('online', () => {
      if (lastSyncState === 'offline') lastSyncState = appState.lastSyncedAt ? 'synced' : 'idle';
      updateCloudStatusUI();
    });
    window.addEventListener('offline', () => {
      if (lastSyncState !== 'syncing') lastSyncState = 'offline';
      updateCloudStatusUI();
    });

    // Initialize application on DOM ready
    document.addEventListener('DOMContentLoaded', () => {
      const now = new Date();
      calCurrentYear = now.getFullYear();
      calCurrentMonth = now.getMonth();
      calSelectedDate = getTodayDateStr();
      initDate();
      applyThemeUI(appState.activeTheme || 'graphite');
      applyPrivacyModeUI();
      try {
        renderApp();
        renderCalendar();
      } catch (err) {
        console.error('Failed to render initial UI:', err);
        const healthTag = document.getElementById('dashHealthTag');
        const adviceEl = document.getElementById('dashAdviceText');
        if (healthTag) healthTag.textContent = '● Error';
        if (adviceEl) adviceEl.textContent = 'Could not load saved attendance data. Check console or reset data in Settings.';
      }
      initServiceWorker();

      // First launch requires an explicit choice: account or guest.
      // The setup wizard only opens after that choice has been made.
      if (needsAuthGate()) {
        setTimeout(openAuthGate, 150);
      } else {
        openSetupIfNeeded();
      }

      // Initial cloud sync if enabled — only once the student has real data,
      // otherwise every first-time visitor creates an empty cloud record.
      if (
        navigator.onLine &&
        appState.cloudSyncEnabled &&
        appState.isSetupCompleted &&
        Array.isArray(appState.subjects) &&
        appState.subjects.length > 0
      ) {
        setTimeout(syncToCloudStorage, 1200);
      }
    });
