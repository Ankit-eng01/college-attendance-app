'use strict';

// Single-entry verification for Attendify 3.0.
// Runs every node:test suite in tests/, plus syntax checks on shipped JS.
// It reports only what the child processes actually print.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const testsDir = __dirname;
const syntaxTargets = ['calc.js', 'app.js', 'offline.js', 'features.js', 'sw.js'];
const knownFailures = [];
const knownLimitations = [
  'Per-operation server sync and idempotency require backend endpoints that do not exist; the outbox is an honest local retry ledger.',
  'Server-side scheduled reminders cannot run on static hosting; device alerts are permission-gated and in-tab only.',
  'Code coverage is not instrumented, so no coverage percentage is claimed.'
];

function run(command, args) {
  return spawnSync(command, args, {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true
  });
}

function readCount(output, label) {
  const match = output.match(new RegExp(`^\\s*[ℹi]\\s+${label}\\s+(\\d+)`, 'm'));
  return match ? Number(match[1]) : 0;
}

function syntaxCheck() {
  const results = syntaxTargets.map((file) => {
    const result = run(process.execPath, ['--check', path.join(root, file)]);
    return { file, ok: result.status === 0, error: result.status === 0 ? '' : (result.stderr || result.stdout).trim() };
  });
  return results;
}

function runSuite(file) {
  const result = run(process.execPath, [path.join(testsDir, file)]);
  const output = `${result.stdout || ''}${result.stderr || ''}`;
  return {
    file,
    status: result.status === 0 ? 'pass' : 'fail',
    tests: readCount(output, 'tests'),
    pass: readCount(output, 'pass'),
    fail: readCount(output, 'fail'),
    skipped: readCount(output, 'skipped'),
    todo: readCount(output, 'todo'),
    output: result.status === 0 ? '' : output.trim()
  };
}

const suites = fs.readdirSync(testsDir)
  .filter((file) => file.endsWith('.test.js'))
  .sort()
  .map(runSuite);

const totals = suites.reduce((sum, suite) => ({
  tests: sum.tests + suite.tests,
  pass: sum.pass + suite.pass,
  fail: sum.fail + suite.fail,
  skipped: sum.skipped + suite.skipped,
  todo: sum.todo + suite.todo
}), { tests: 0, pass: 0, fail: 0, skipped: 0, todo: 0 });

const syntax = syntaxCheck();
const syntaxPass = syntax.filter((item) => item.ok).length;
const overallPass = totals.fail === 0 && suites.every((suite) => suite.status === 'pass') &&
  syntaxPass === syntax.length && knownFailures.length === 0;

const report = {
  status: overallPass ? 'PASS' : 'FAIL',
  totals,
  suites,
  syntax: { checked: syntax.length, passed: syntaxPass, results: syntax },
  coverage: 'Not measured — no coverage instrumentation is configured.',
  knownFailures,
  knownLimitations
};

console.log('ATTENDIFY 3.0 — FULL VERIFICATION');
console.log('--------------------------------');
suites.forEach((suite) => {
  console.log(`${suite.file}: ${suite.pass} passed, ${suite.fail} failed, ${suite.skipped} skipped (${suite.status.toUpperCase()})`);
  if (suite.output) console.log(suite.output.split('\n').map((line) => `  ${line}`).join('\n'));
});
console.log(`JS syntax: ${syntaxPass}/${syntax.length} files passed`);
syntax.filter((item) => !item.ok).forEach((item) => console.log(`  ${item.file}: ${item.error}`));
console.log('--------------------------------');
console.log(`TOTAL: ${totals.tests} tests · ${totals.pass} passed · ${totals.fail} failed · ${totals.skipped} skipped · ${totals.todo} todo`);
console.log(`Coverage: ${report.coverage}`);
console.log(`Known failures: ${knownFailures.length ? knownFailures.join('; ') : 'none in the included suites'}`);
knownLimitations.forEach((item) => console.log(`Known limitation: ${item}`));
console.log(`RESULT: ${report.status}`);

process.exitCode = overallPass ? 0 : 1;
