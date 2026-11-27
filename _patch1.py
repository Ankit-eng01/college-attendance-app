import io, re, sys

def read(p):
    with io.open(p, 'r', encoding='utf-8', newline='') as f:
        return f.read()

def write(p, s):
    with io.open(p, 'w', encoding='utf-8', newline='') as f:
        f.write(s)

def sub(text, old, new, path):
    if old not in text:
        sys.exit('MISS in %s: %r' % (path, old[:70]))
    if text.count(old) != 1:
        sys.exit('AMBIGUOUS in %s: %r' % (path, old[:70]))
    return text.replace(old, new)

# ---- calc.js: strip script/style content in cleanText ----
p = 'calc.js'
t = read(p)
old = """  function cleanText(value, maxLength) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/<[^>]*>?/gm, '').replace(/[\\u0000-\\u001F\\u007F]/g, ' ').trim().slice(0, maxLength || 120);
  }"""
new = """  function cleanText(value, maxLength) {
    if (value === null || value === undefined) return '';
    return String(value)
      // Drop scripting elements together with their content before stripping tags.
      .replace(/<\\s*(script|style)[^>]*>[\\s\\S]*?<\\s*\\/\\s*\\1\\s*>/gi, ' ')
      .replace(/<[^>]*>?/gm, '')
      .replace(/[\\u0000-\\u001F\\u007F]/g, ' ')
      .trim()
      .slice(0, maxLength || 120);
  }"""
t = sub(t, old, new, p)
write(p, t)

# ---- tests/calc.test.js: correct the expectations ----
p = 'tests/calc.test.js'
t = read(p)
pairs = [
    ("  assert.equal(calc.percentage(1, 3), 100 / 3);",
     "  assert.ok(Math.abs(calc.percentage(1, 3) - 100 / 3) < 1e-9);"),
    ("  assert.equal(calc.safeBunks(16, 20, 75), 1);\n  assert.equal(calc.safeBunks(3, 4, 75), 1);",
     "  assert.equal(calc.safeBunks(16, 20, 75), 1);\n  assert.equal(calc.safeBunks(3, 4, 75), 0); // exactly 75%: no room to miss\n  assert.equal(calc.safeBunks(17, 20, 75), 2);"),
    ("  assert.equal(calc.classesNeeded(50, 100, 75), 0);\n  assert.equal(calc.classesNeeded(8, 10, 90), 10);",
     "  assert.equal(calc.classesNeeded(50, 100, 75), 100);\n  assert.equal(calc.classesNeeded(80, 100, 75), 0);\n  assert.equal(calc.classesNeeded(8, 10, 90), 10);"),
    ("  assert.equal(calc.stats({ attended: 17, total: 20 }, 80).isShort, false);\n  assert.equal(calc.stats({ attended: 16, total: 20 }, 80).isShort, true);\n  assert.equal(calc.stats({ attended: 17, total: 20 }, 85).isShort, true);",
     "  assert.equal(calc.stats({ attended: 17, total: 20 }, 80).isShort, false);\n  assert.equal(calc.stats({ attended: 16, total: 20 }, 80).isShort, false); // exactly 80%\n  assert.equal(calc.stats({ attended: 15, total: 20 }, 80).isShort, true);\n  assert.equal(calc.stats({ attended: 17, total: 20 }, 85).isShort, false); // exactly 85%\n  assert.equal(calc.stats({ attended: 16, total: 20 }, 85).isShort, true);"),
    ("  assert.equal(agg.belowTarget, 2);",
     "  assert.equal(agg.belowTarget, 1); // A is exactly on 75%, B is short"),
    ("      { id: 'h2', subId: 'a', date: '2026-11-24', status: 'absent', timestamp: 1 },",
     "      { id: 'h2', subId: 'a', date: '2026-11-25', status: 'absent', timestamp: 1 },"),
    ("  assert.throws(() => calc.csvToSubjects('Subject Name\\nOnly Header', 75), /header row/i);",
     "  assert.throws(() => calc.csvToSubjects('Subject Name\\nOnly Header', 75), /Attended/);"),
]
for old, new in pairs:
    t = sub(t, old, new, p)
write(p, t)
print('patched')
