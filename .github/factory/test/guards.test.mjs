import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addedLines, changedFiles, checkDiff, commits } from '../lib/guards.mjs';

const diff = `diff --git a/src/trip.test.ts b/src/trip.test.ts
index 1..2 100644
--- a/src/trip.test.ts
+++ b/src/trip.test.ts
@@ -3,0 +4,2 @@
+  it.only('creates a trip', () => {
+  // eslint-disable-next-line no-console
diff --git a/src/trip.ts b/src/trip.ts
--- a/src/trip.ts
+++ b/src/trip.ts
@@ -10 +10 @@
-  return x;
+  return x as any; // @ts-expect-error
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,0 +2 @@
+Never use \`test.skip(\` or eslint-disable.
`;

const base = (over = {}) => ({
  issue: 17,
  labels: [],
  files: [
    { status: 'M', path: 'src/trip.ts' },
    { status: 'A', path: 'src/trip.test.ts' },
  ],
  added: new Map(),
  commitList: [{ sha: 'abc1234def', message: 'Add trip (#17)' }],
  ...over,
});

test('addedLines tracks added lines per file with their new line numbers', () => {
  const files = addedLines(diff);
  assert.deepEqual(files.get('src/trip.test.ts').map((l) => l.line), [4, 5]);
  assert.equal(files.get('src/trip.ts')[0].line, 10);
});

test('flags focused/skipped tests and lint/TS suppressions in code, not in docs', () => {
  const rules = checkDiff(base({ added: addedLines(diff) })).map((v) => v.rule);
  assert.deepEqual(rules.sort(), ['focused-or-skipped-test', 'lint-or-type-suppression', 'lint-or-type-suppression']);
});

test('recognises the common focus/skip spellings', () => {
  for (const line of ['describe.skip(', 'test.describe.only(', 'it.concurrent.skip(', 'xit(', 'fdescribe (', "test.fixme('x'"]) {
    const added = new Map([['a.spec.ts', [{ line: 1, text: line }]]]);
    assert.equal(checkDiff(base({ added }))[0]?.rule, 'focused-or-skipped-test', line);
  }
  const fine = new Map([['a.ts', [{ line: 1, text: 'const skipped = items.filter(isOnly);' }]]]);
  assert.deepEqual(checkDiff(base({ added: fine })), []);
});

test('requires test changes unless the issue is labelled no-tests-needed', () => {
  const files = [{ status: 'M', path: 'src/trip.ts' }];
  assert.deepEqual(checkDiff(base({ files })).map((v) => v.rule), ['no-tests']);
  assert.deepEqual(checkDiff(base({ files, labels: ['no-tests-needed'] })), []);
  const deletedOnly = [{ status: 'D', path: 'src/old.test.ts' }, ...files];
  assert.deepEqual(checkDiff(base({ files: deletedOnly })).map((v) => v.rule), ['no-tests']);
  const e2e = [{ status: 'A', path: 'apps/web/e2e/home.ts' }, ...files];
  assert.deepEqual(checkDiff(base({ files: e2e })), []);
});

test('rejects changes to the factory and its pinned skills, including renames out of them', () => {
  const files = [
    { status: 'M', path: '.github/factory/lib/guards.mjs' },
    { status: 'R', path: 'tmp/skill.md', from: '.claude/skills/tdd/SKILL.md' },
    { status: 'M', path: '.github/workflows/factory.yml' },
    { status: 'A', path: '.github/workflows/ci.yml' },
    { status: 'A', path: 'x.test.ts' },
  ];
  assert.deepEqual(checkDiff(base({ files })).map((v) => v.rule), ['protected-path', 'protected-path', 'protected-path']);
});

test('every commit must reference the issue', () => {
  const commitList = [
    { sha: 'aaaaaaa1', message: 'Add trip (#17)' },
    { sha: 'bbbbbbb2', message: 'Fix lint (#170)' },
    { sha: 'ccccccc3', message: 'wip' },
  ];
  assert.deepEqual(checkDiff(base({ commitList })).map((v) => v.detail.slice(0, 7)), ['bbbbbbb', 'ccccccc']);
});

test('an empty diff fails', () => {
  assert.deepEqual(checkDiff(base({ files: [] })).map((v) => v.rule), ['empty-diff']);
});

test('parses git name-status and log output', () => {
  assert.deepEqual(changedFiles('M\ta.ts\nR100\told.ts\tnew.ts\n'), [
    { status: 'M', path: 'a.ts' },
    { status: 'R', path: 'new.ts', from: 'old.ts' },
  ]);
  assert.deepEqual(commits('abc\x1fSubject (#1)\n\nBody\n\x1e\ndef\x1fOther\n\x1e'), [
    { sha: 'abc', message: 'Subject (#1)\n\nBody' },
    { sha: 'def', message: 'Other' },
  ]);
});
