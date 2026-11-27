# -*- coding: utf-8 -*-
import io, sys

def read(p):
    with io.open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read().replace('\r\n', '\n')

def write(p, s):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(s.replace('\n', '\r\n'))

def one(t, old, new, label):
    if t.count(old) != 1:
        sys.exit('%s: found %d matches for %r' % (label, t.count(old), old[:90]))
    return t.replace(old, new)

# ===========================================================================
# app.js
# ===========================================================================
p = 'app.js'
t = read(p)

# --- 1. calcStats now delegates to the tested engine -----------------------
t = one(t, "    function calcStats(sub) {\n      const a = Number(sub.attended) || 0;",
        "    // Public entry point. The maths lives in calc.js so the browser and the\n"
        "    // automated test-suite run exactly the same formulas.\n"
        "    function calcStats(sub) {\n"
        "      if (window.AttendifyCalc && typeof window.AttendifyCalc.stats === 'function') {\n"
        "        return window.AttendifyCalc.stats(sub, appState.globalTarget);\n"
        "      }\n"
        "      return legacyCalcStats(sub);\n"
        "    }\n\n"
        "    function legacyCalcStats(sub) {\n      const a = Number(sub.attended) || 0;",
        'calcStats delegate')

# --- 2. State validation delegates to the shared, tested validator ---------
t = one(t, "    function validateAndSanitizeState(raw) {\n      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {",
        "    function validateAndSanitizeState(raw) {\n"
        "      // calc.js owns the schema rules (and is unit-tested). The legacy body\n"
        "      // below stays as an offline fallback if calc.js ever fails to load.\n"
        "      if (window.AttendifyCalc && typeof window.AttendifyCalc.sanitizeState === 'function') {\n"
        "        return window.AttendifyCalc.sanitizeState(raw);\n"
        "      }\n"
        "      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {",
        'validator delegate')

# --- 3. Track the last local write (used for sync conflict detection) ------
t = one(t, "    function saveState() {\n      try {\n        localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));",
        "    function saveState() {\n      try {\n        appState.localUpdatedAt = Date.now();\n"
        "        localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));",
        'saveState timestamp')
t = one(t, "    function saveStateOnly() {\n      try {\n        localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));",
        "    function saveStateOnly() {\n      try {\n        appState.localUpdatedAt = Date.now();\n"
        "        localStorage.setItem(STORAGE_KEY, JSON.stringify(appState));",
        'saveStateOnly timestamp')

# --- 4. Render hook for the feature layer ---------------------------------
t = one(t, "      const badge = document.getElementById('subjectCountBadge');\n      if (badge) badge.textContent = appState.subjects.length;\n    }",
        "      const badge = document.getElementById('subjectCountBadge');\n      if (badge) badge.textContent = appState.subjects.length;\n\n"
        "      // Advanced surfaces (insights, analytics, timetable, notifications, sync state)\n"
        "      if (window.AttendifyFeatures && typeof window.AttendifyFeatures.render === 'function') {\n"
        "        window.AttendifyFeatures.render();\n"
        "      }\n    }",
        'render hook')

# --- 5. Tab routing for the two new views --------------------------------
t = one(t, "      if (tab === 'settings') {\n        document.getElementById('viewSettings').classList.add('active');\n      }\n\n      window.scrollTo({ top: 0, behavior: 'smooth' });",
        "      if (tab === 'analytics') {\n        document.getElementById('viewAnalytics').classList.add('active');\n      }\n"
        "      if (tab === 'timetable') {\n        document.getElementById('viewTimetable').classList.add('active');\n      }\n"
        "      if (tab === 'settings') {\n        document.getElementById('viewSettings').classList.add('active');\n      }\n\n"
        "      if (window.AttendifyFeatures && typeof window.AttendifyFeatures.onTab === 'function') {\n"
        "        window.AttendifyFeatures.onTab(tab);\n"
        "      }\n\n      window.scrollTo({ top: 0, behavior: 'smooth' });",
        'switchTab routes')

# --- 6. Sync payload carries timetable + preferences ----------------------
t = one(t, "          privacyMode: appState.privacyMode || false,\n          device: getDeviceProfile(),",
        "          privacyMode: appState.privacyMode || false,\n"
        "          timetable: appState.timetable || [],\n"
        "          notifPrefs: appState.notifPrefs || {},\n"
        "          simScenarios: appState.simScenarios || [],\n"
        "          localUpdatedAt: appState.localUpdatedAt || 0,\n"
        "          device: getDeviceProfile(),",
        'sync payload')

# --- 7. Clear an existing calendar entry ---------------------------------
t = one(t, "              <button type=\"button\" class=\"act-btn ${currentStatus === 'off' ? 'act-off' : ''}\" data-action=\"recordAttendanceEntry\" data-date=\"${safeDateStr}\" data-subid=\"${safeSubId}\" data-status=\"off\" aria-label=\"Mark ${safeSubName} off\">—</button>",
        "              <button type=\"button\" class=\"act-btn ${currentStatus === 'off' ? 'act-off' : ''}\" data-action=\"recordAttendanceEntry\" data-date=\"${safeDateStr}\" data-subid=\"${safeSubId}\" data-status=\"off\" aria-label=\"Mark ${safeSubName} off\">—</button>\n"
        "              <button type=\"button\" class=\"act-btn\" data-action=\"clearAttendanceEntry\" data-date=\"${safeDateStr}\" data-subid=\"${safeSubId}\" aria-label=\"Clear the ${safeSubName} entry for this day\" title=\"Clear entry\">⟲</button>",
        'clear entry button')

t = one(t, "        case 'recordAttendanceEntry':\n          recordAttendanceEntry(el.getAttribute('data-date'), el.getAttribute('data-subid'), el.getAttribute('data-status'));\n          break;",
        "        case 'recordAttendanceEntry':\n          recordAttendanceEntry(el.getAttribute('data-date'), el.getAttribute('data-subid'), el.getAttribute('data-status'));\n          break;\n"
        "        case 'clearAttendanceEntry':\n          recordAttendanceEntry(el.getAttribute('data-date'), el.getAttribute('data-subid'), 'none');\n          break;",
        'clear entry action')

# --- 8. Service worker registration version ------------------------------
t = one(t, "navigator.serviceWorker.register('./sw.js?v=20261127r11', { updateViaCache: 'none' })",
        "navigator.serviceWorker.register('./sw.js?v=20261127r12', { updateViaCache: 'none' })",
        'sw registration version')

write(p, t)

# ===========================================================================
# sw.js
# ===========================================================================
p = 'sw.js'
t = read(p)
t = one(t, "const CACHE_NAME = 'attendify-v32-polish';", "const CACHE_NAME = 'attendify-v33-insights';", 'sw cache name')
t = one(t, "  './app.js?v=20261127r11',\n  './app.js',",
        "  './calc.js?v=20261127r12',\n  './calc.js',\n"
        "  './app.js?v=20261127r12',\n  './app.js',\n"
        "  './features.js?v=20261127r12',\n  './features.js',",
        'sw precache')
write(p, t)

# ===========================================================================
# index.html — version labels
# ===========================================================================
p = 'index.html'
t = read(p)
t = one(t, '<span class="criteria-pill pill-neutral">v2.2</span>',
        '<span class="criteria-pill pill-neutral">v3.0</span>', 'about version')
t = one(t, '<p>College attendance tracker with 75% target &amp; safe-bunk intelligence.</p>',
        '<p>Attendance OS — safe-bunk maths, analytics, timetable and offline-first sync.</p>', 'about copy')
write(p, t)

print('app.js, sw.js and version labels patched')
