// Integration tests: the real CLI, as the workflow runs it, against a fake GitHub API.
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { fakeGitHub } from './fake-github.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');
const run = promisify(execFile);

let gh;
let apiUrl;
let dir;

beforeEach(async () => {
  gh = fakeGitHub();
  apiUrl = await gh.listen();
  dir = mkdtempSync(join(tmpdir(), 'factory-test-'));
});
afterEach(() => gh.close());

function issue(number, labels, extra = {}) {
  gh.db.issues[number] = { number, title: `Ticket ${number}`, body: `Body ${number}`, labels, ...extra };
}

/** Runs a CLI subcommand; returns its GITHUB_OUTPUT values and exit code. */
async function cli(args, envOver = {}, cwd = dir) {
  const outputFile = join(dir, `output-${Math.random()}`);
  writeFileSync(outputFile, '');
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GH_TOKEN: 't',
    GITHUB_REPOSITORY: 'o/r',
    GITHUB_API_URL: apiUrl,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_RUN_ID: '500',
    GITHUB_OUTPUT: outputFile,
    FACTORY_DIR: join(dir, 'factory'),
    ...envOver,
  };
  let code = 0;
  let stderr = '';
  try {
    await run('node', [CLI, ...args], { env, cwd });
  } catch (err) {
    code = err.code;
    stderr = err.stderr;
  }
  const outputs = {};
  for (const m of readFileSync(outputFile, 'utf8').matchAll(/^(\w+)<<(EOF_\w+)\n([\s\S]*?)\n\2$/gm)) outputs[m[1]] = m[3];
  return { code, outputs, stderr };
}

const out = (...p) => join(dir, 'factory', 'out', ...p);
const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(data));
}

// ------------------------------------------------------------------ start

test('start: a labelled issue is claimed, gets a fresh branch from main, a status comment and a filtered ticket', async () => {
  issue(17, ['ready-for-agent'], { title: 'Walking skeleton' });
  gh.db.comments.set(1, { id: 1, issue: 17, author_association: 'NONE', user: { login: 'x' }, created_at: 'd', body: 'pwn' });

  const { code, outputs } = await cli(['start'], { ISSUE: '17', EVENT_NAME: 'issues', STAGE: 'start' });

  assert.equal(code, 0);
  assert.deepEqual(outputs, { proceed: 'true', claimed: 'true', stage: 'implement', branch: 'agent/17-walking-skeleton' });
  assert.deepEqual(gh.db.issues[17].labels, ['ready-for-agent', 'agent-running']);
  assert.equal(gh.db.refs['agent/17-walking-skeleton'], 'main000');
  const state = readJson(out('state.json'));
  assert.equal(state.entry, 'implement');
  assert.equal(state.pipeline.id, '500');
  assert.deepEqual(state.counters, { verifyFailures: 0, reviewRounds: 0 });
  assert.match(gh.db.comments.get(state.statusCommentId).body, /start \| ✅ passed/);
  assert.doesNotMatch(readFileSync(out('ticket.md'), 'utf8'), /pwn/);
});

test('start: relabelling archives the previous branch as an attempt instead of deleting it', async () => {
  issue(4, ['ready-for-agent']);
  gh.db.refs['agent/4-ticket-4'] = 'old1';
  gh.db.refs['agent/4-ticket-4-attempt-1'] = 'old0';

  await cli(['start'], { ISSUE: '4', EVENT_NAME: 'issues', STAGE: 'start' });

  assert.equal(gh.db.refs['agent/4-ticket-4-attempt-2'], 'old1');
  assert.equal(gh.db.refs['agent/4-ticket-4-attempt-1'], 'old0');
  assert.equal(gh.db.refs['agent/4-ticket-4'], 'main000');
});

test('start: while another ticket is running, the issue is queued without being claimed', async () => {
  issue(3, ['ready-for-agent', 'agent-running']);
  issue(5, ['ready-for-agent']);

  const { outputs } = await cli(['start'], { ISSUE: '5', EVENT_NAME: 'issues', STAGE: 'start' });

  assert.equal(outputs.proceed, 'false');
  assert.deepEqual(gh.db.issues[5].labels, ['ready-for-agent']);
  assert.match(gh.commentsOn(5)[0], /Queued.*#3/s);
  assert.equal(gh.db.refs['agent/5-ticket-5'], undefined);
});

test('start: an open PR for the issue refuses the run and hands the issue to a human', async () => {
  issue(8, ['ready-for-agent']);
  gh.db.pulls.push({ number: 30, state: 'open', html_url: 'https://github.com/o/r/pull/30', head: { ref: 'agent/8-ticket-8' }, body: '' });

  const { outputs } = await cli(['start'], { ISSUE: '8', EVENT_NAME: 'issues', STAGE: 'start' });

  assert.equal(outputs.proceed, 'false');
  assert.deepEqual(gh.db.issues[8].labels, ['ready-for-human']);
  assert.match(gh.commentsOn(8)[0], /pull\/30/);
});

test('start: a second label event for an issue that is already running is ignored', async () => {
  issue(9, ['ready-for-agent', 'agent-running']);

  const { outputs } = await cli(['start'], { ISSUE: '9', EVENT_NAME: 'issues', STAGE: 'start' });

  assert.equal(outputs.proceed, 'false');
  assert.deepEqual(gh.db.issues[9].labels, ['ready-for-agent', 'agent-running']);
  assert.match(gh.commentsOn(9)[0], /already in progress/);
});

test('start: a continuation carries counters and the status comment, and turns a failed verify into feedback', async () => {
  issue(17, ['ready-for-agent', 'agent-running']);
  gh.db.refs['agent/17-ticket-17'] = 'abc';
  gh.db.comments.set(77, { id: 77, issue: 17, body: 'status', author_association: 'NONE', user: { login: 'b' }, created_at: 'd' });
  const carry = join(dir, 'factory', 'carry');
  writeJson(join(carry, 'factory-state', 'state.json'), { issue: 17, statusCommentId: 77, pipeline: { id: '400', url: 'u' }, counters: { verifyFailures: 0, reviewRounds: 0 } });
  writeJson(join(carry, 'factory-next', 'state.json'), { issue: 17, statusCommentId: 77, pipeline: { id: '400', url: 'u' }, counters: { verifyFailures: 1, reviewRounds: 0 }, lastTransition: 'verify failed' });
  writeJson(join(carry, 'verify', 'result.json'), { passed: false });
  writeFileSync(join(carry, 'verify', 'feedback.md'), 'pnpm verify failed');

  const { outputs } = await cli(['start'], { ISSUE: '17', EVENT_NAME: 'workflow_dispatch', STAGE: 'implement', FROM_RUN: '499' });

  assert.equal(outputs.proceed, 'true');
  const state = readJson(out('state.json'));
  assert.equal(state.statusCommentId, 77);
  assert.equal(state.pipeline.id, '400');
  assert.equal(state.feedback, 'verify');
  assert.deepEqual(state.counters, { verifyFailures: 1, reviewRounds: 0 });
  assert.equal(readFileSync(out('feedback', 'feedback.md'), 'utf8'), 'pnpm verify failed');
  assert.match(gh.db.comments.get(77).body, /continuing at implement: verify failed/);
});

test('start: resuming at pr without an approved review of the branch head is refused', async () => {
  issue(6, ['ready-for-human']);
  gh.db.refs['agent/6-ticket-6'] = 'head2';
  writeJson(join(dir, 'factory', 'carry', 'factory-state', 'state.json'), { issue: 6, counters: {} });
  writeJson(join(dir, 'factory', 'carry', 'review', 'result.json'), { verdict: 'approve', headSha: 'head1' });

  const { outputs } = await cli(['start'], { ISSUE: '6', EVENT_NAME: 'workflow_dispatch', STAGE: 'pr', FROM_RUN: '1' });

  assert.equal(outputs.proceed, 'false');
  assert.match(gh.commentsOn(6)[0], /Resume at `review`/);
  assert.deepEqual(gh.db.issues[6].labels, ['ready-for-human']);
});

// ------------------------------------------------------------------ finish

function finishFixture({ needs, state = {}, reasons = {} }) {
  const artifacts = join(dir, 'factory', 'artifacts');
  writeJson(join(artifacts, 'factory-state', 'state.json'), {
    issue: 17,
    branch: 'agent/17-ticket-17',
    entry: 'implement',
    statusCommentId: 77,
    pipeline: { id: '400', url: 'u' },
    counters: { verifyFailures: 0, reviewRounds: 0 },
    ...state,
  });
  for (const [stage, reason] of Object.entries(reasons)) {
    mkdirSync(join(artifacts, `outcome-${stage}`), { recursive: true });
    writeFileSync(join(artifacts, `outcome-${stage}`, 'reason.txt'), reason);
  }
  gh.db.comments.set(77, { id: 77, issue: 17, body: 'status', author_association: 'NONE', user: { login: 'b' }, created_at: 'd' });
  const j = (result, outputs = {}) => ({ result, outputs });
  return {
    NEEDS: JSON.stringify({
      start: j('success', { proceed: 'true', claimed: 'true' }),
      implement: j('success'),
      verify: j('skipped'),
      review: j('skipped'),
      pr: j('skipped'),
      ...Object.fromEntries(Object.entries(needs).map(([k, [r, o]]) => [k, j(r, o)])),
    }),
    ISSUE: '17',
    CLAIMED: 'true',
  };
}

test('finish: a failed verify under the cap dispatches a rework run carrying this run', async () => {
  issue(17, ['ready-for-agent', 'agent-running']);
  const env = finishFixture({ needs: { verify: ['success', { passed: 'false' }] } });

  assert.equal((await cli(['finish-decide'], env)).outputs.action, 'continue');
  assert.deepEqual(readJson(out('state.json')).counters, { verifyFailures: 1, reviewRounds: 0 });
  assert.equal((await cli(['finish-act'], env)).code, 0);

  assert.deepEqual(gh.db.dispatches, [{ ref: 'main', inputs: { issue: '17', stage: 'implement', from_run: '500' } }]);
  assert.deepEqual(gh.db.issues[17].labels, ['ready-for-agent', 'agent-running']);
  assert.match(gh.db.comments.get(77).body, /verify \| 🔁 rework/);
});

test('finish: hitting a cap comments, hands off to a human, and starts the next queued ticket', async () => {
  issue(17, ['ready-for-agent', 'agent-running']);
  issue(20, ['ready-for-agent'], { events: [{ event: 'labeled', label: { name: 'ready-for-agent' }, created_at: '2026-11-12T10:00:00Z' }] });
  issue(19, ['ready-for-agent'], { events: [{ event: 'labeled', label: { name: 'ready-for-agent' }, created_at: '2026-11-12T09:00:00Z' }] });
  const env = finishFixture({
    needs: { verify: ['success', { passed: 'false' }] },
    state: { counters: { verifyFailures: 3, reviewRounds: 0 } },
  });

  await cli(['finish-decide'], env);
  await cli(['finish-act'], env);

  assert.deepEqual(gh.db.issues[17].labels, ['ready-for-human']);
  const failure = gh.commentsOn(17).find((b) => b.includes('factory:failure'));
  assert.match(failure, /Stage:\*\* `verify`/);
  assert.match(failure, /after 3 implement retries/);
  assert.match(failure, /agent\/17-ticket-17/);
  assert.match(failure, /actions\/runs\/500/);
  assert.deepEqual(gh.db.dispatches, [{ ref: 'main', inputs: { issue: '19', stage: 'start', from_run: '' } }]);
});

test('finish: an agent failure reports the recorded reason', async () => {
  issue(17, ['ready-for-agent', 'agent-running']);
  const env = finishFixture({
    needs: { implement: ['failure'] },
    reasons: { implement: 'the implement agent hit its turn limit (--max-turns 80)' },
  });

  await cli(['finish-decide'], env);
  await cli(['finish-act'], env);

  assert.match(gh.commentsOn(17).find((b) => b.includes('factory:failure')), /turn limit/);
  assert.deepEqual(gh.db.issues[17].labels, ['ready-for-human']);
});

test('finish: an opened PR releases the claim and records the outcome', async () => {
  issue(17, ['ready-for-agent', 'agent-running']);
  const env = finishFixture({
    needs: {
      verify: ['success', { passed: 'true' }],
      review: ['success', { verdict: 'approve' }],
      pr: ['success', { url: 'https://github.com/o/r/pull/31' }],
    },
  });

  await cli(['finish-decide'], env);
  await cli(['finish-act'], env);

  assert.deepEqual(gh.db.issues[17].labels, []);
  assert.match(gh.db.comments.get(77).body, /Outcome:\*\* ✅ Opened https:\/\/github.com\/o\/r\/pull\/31/);
  assert.deepEqual(gh.db.dispatches, []);
});

// ------------------------------------------------------------------ pr

test('open-pr: opens the PR with Closes #n and posts the review report as a comment', async () => {
  issue(17, ['ready-for-agent', 'agent-running']);
  writeJson(join(dir, 'factory', 'state', 'state.json'), { issue: 17, title: 'Walking skeleton', branch: 'agent/17-walking-skeleton' });
  mkdirSync(join(dir, 'factory', 'review'), { recursive: true });
  writeFileSync(join(dir, 'factory', 'review', 'report.md'), '## Standards\nok\n## Spec\nok');

  const { code, outputs } = await cli(['open-pr'], { STRUCTURED_OUTPUT: JSON.stringify({ body: '## Summary\nx' }), HEAD_SHA: 'abc' });

  assert.equal(code, 0);
  const pr = gh.db.pulls[0];
  assert.equal(outputs.url, pr.html_url);
  assert.equal(pr.head.ref, 'agent/17-walking-skeleton');
  assert.match(pr.body, /Closes #17\n$/);
  assert.match(gh.commentsOn(pr.number)[0], /## Spec/);
});

// ------------------------------------------------------------------ verify

function gitRepo() {
  const repo = join(dir, 'repo');
  mkdirSync(repo);
  const g = (...a) => execFileSync('git', a, { cwd: repo, encoding: 'utf8' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  writeFileSync(join(repo, 'README.md'), '# x\n');
  g('add', '.');
  g('commit', '-qm', 'init');
  g('update-ref', 'refs/remotes/origin/main', 'HEAD');
  g('checkout', '-qb', 'agent/17-x');
  return { repo, g };
}

test('verify: a branch without pnpm verify fails the gate (no fallback) and still reports guard violations', async () => {
  const { repo, g } = gitRepo();
  writeFileSync(join(repo, 'trip.ts'), '// @ts-nocheck\nexport const x = 1;\n');
  g('add', '.');
  g('commit', '-qm', 'Add trip');
  writeJson(join(dir, 'factory', 'state', 'state.json'), { issue: 17, labels: [] });

  const { code, outputs } = await cli(['verify'], {}, repo);

  assert.equal(code, 0, 'a gate failure is reported, not thrown');
  assert.equal(outputs.passed, 'false');
  const result = readJson(out('result.json'));
  assert.match(result.checks[0].detail, /package\.json` is missing/);
  const rules = result.checks[1].detail;
  for (const rule of ['lint-or-type-suppression', 'no-tests', 'commit-without-issue-ref']) assert.match(rules, new RegExp(rule));
  assert.match(readFileSync(out('feedback.md'), 'utf8'), /❌ pnpm verify/);
});

test('verify: a package.json without a verify script fails the gate', async () => {
  const { repo, g } = gitRepo();
  writeFileSync(join(repo, 'package.json'), JSON.stringify({ packageManager: 'pnpm@10.0.0', scripts: { test: 'x' } }));
  writeFileSync(join(repo, 'a.test.ts'), 'test("a", () => {});\n');
  g('add', '.');
  g('commit', '-qm', 'Scaffold (#17)');
  writeJson(join(dir, 'factory', 'state', 'state.json'), { issue: 17, labels: [] });

  const { outputs } = await cli(['verify'], {}, repo);

  assert.equal(outputs.passed, 'false');
  const result = readJson(out('result.json'));
  assert.match(result.checks[0].detail, /no `verify` script/);
  assert.equal(result.checks[1].passed, true);
});

// ------------------------------------------------------------------ sweep

test('sweep: releases a claim whose run died, then starts the queue', async () => {
  issue(12, ['ready-for-agent', 'agent-running']);
  issue(13, ['ready-for-agent']);
  gh.db.runs = [{ id: 1, display_title: 'factory #12 · implement', status: 'completed', updated_at: '2026-01-01T00:00:00Z', html_url: 'https://run/1' }];

  assert.equal((await cli(['sweep'])).code, 0);

  assert.deepEqual(gh.db.issues[12].labels, ['ready-for-human']);
  assert.match(gh.commentsOn(12)[0], /no factory run is active/);
  assert.deepEqual(gh.db.dispatches.map((d) => d.inputs.issue), ['13']);
});

test('sweep: leaves a claim alone while its run is live', async () => {
  issue(12, ['ready-for-agent', 'agent-running']);
  gh.db.runs = [{ id: 1, display_title: 'factory #12 · review', status: 'in_progress', updated_at: '2026-01-01T00:00:00Z' }];

  await cli(['sweep']);

  assert.deepEqual(gh.db.issues[12].labels, ['ready-for-agent', 'agent-running']);
  assert.deepEqual(gh.db.dispatches, []);
});
