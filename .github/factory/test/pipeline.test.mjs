import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decideNext, firstStage, parseCaps, pickNext } from '../lib/pipeline.mjs';

const caps = { verifyRetries: 3, reviewRounds: 2 };
const zero = { verifyFailures: 0, reviewRounds: 0 };
const ok = (outputs = {}) => ({ result: 'success', outputs });
const skipped = { result: 'skipped', outputs: {} };

const fullRun = (over = {}) => ({
  start: ok({ proceed: 'true' }),
  implement: ok(),
  verify: ok({ passed: 'true' }),
  review: ok({ verdict: 'approve' }),
  pr: ok({ url: 'https://github.com/o/r/pull/9' }),
  ...over,
});

test('a clean run ends with the PR', () => {
  assert.deepEqual(decideNext({ entry: 'implement', jobs: fullRun(), counters: zero, caps }), {
    action: 'done',
    stage: 'pr',
    url: 'https://github.com/o/r/pull/9',
  });
});

test('a failed verify schedules an implement retry until the cap, then fails', () => {
  const jobs = fullRun({ verify: ok({ passed: 'false' }), review: skipped, pr: skipped });
  const first = decideNext({ entry: 'implement', jobs, counters: zero, caps });
  assert.equal(first.action, 'continue');
  assert.equal(first.feedback, 'verify');
  assert.deepEqual(first.counters, { verifyFailures: 1, reviewRounds: 0 });

  const last = decideNext({ entry: 'implement', jobs, counters: { verifyFailures: 3, reviewRounds: 0 }, caps });
  assert.equal(last.action, 'fail');
  assert.equal(last.stage, 'verify');
  assert.match(last.reason, /after 3 implement retries/);
});

test('review rework continues until the round cap and resets verify retries', () => {
  const jobs = fullRun({ review: ok({ verdict: 'rework' }), pr: skipped });
  const next = decideNext({ entry: 'implement', jobs, counters: { verifyFailures: 2, reviewRounds: 1 }, caps });
  assert.equal(next.action, 'continue');
  assert.deepEqual(next.counters, { verifyFailures: 0, reviewRounds: 2 });

  const capped = decideNext({ entry: 'implement', jobs, counters: { verifyFailures: 0, reviewRounds: 2 }, caps });
  assert.equal(capped.action, 'fail');
  assert.equal(capped.stage, 'review');
});

test('a failed or cancelled job fails the pipeline at the first broken stage, with the recorded reason', () => {
  const jobs = fullRun({ implement: { result: 'failure', outputs: {} }, verify: skipped, review: skipped, pr: skipped });
  assert.deepEqual(
    decideNext({ entry: 'implement', jobs, counters: zero, caps, reasons: { implement: 'hit its turn limit' } }),
    { action: 'fail', stage: 'implement', reason: 'hit its turn limit' },
  );
  const cancelled = decideNext({ entry: 'implement', jobs: fullRun({ review: { result: 'cancelled' }, pr: skipped }), counters: zero, caps });
  assert.equal(cancelled.stage, 'review');
  assert.match(cancelled.reason, /cancelled/);
});

test('a crashed start fails at start', () => {
  const jobs = { start: { result: 'failure', outputs: {} }, implement: skipped, verify: skipped, review: skipped, pr: skipped };
  assert.equal(decideNext({ entry: 'implement', jobs, counters: zero, caps }).stage, 'start');
});

test('a run that neither opens a PR nor needs rework is a failure, never a silent stop', () => {
  const jobs = fullRun({ pr: skipped, review: ok({ verdict: 'approve' }) });
  const d = decideNext({ entry: 'implement', jobs, counters: zero, caps });
  assert.equal(d.action, 'fail');
  assert.equal(d.stage, 'review');
});

test('caps come from repo variables with defaults', () => {
  assert.deepEqual(parseCaps({}), { verifyRetries: 3, reviewRounds: 2 });
  assert.deepEqual(parseCaps({ FACTORY_VERIFY_RETRIES: '1', FACTORY_REVIEW_ROUNDS: '' }), { verifyRetries: 1, reviewRounds: 2 });
  assert.throws(() => parseCaps({ FACTORY_VERIFY_RETRIES: 'two' }));
});

test('firstStage maps start to implement and rejects unknown stages', () => {
  assert.equal(firstStage('start'), 'implement');
  assert.equal(firstStage('review'), 'review');
  assert.throws(() => firstStage('deploy'));
});

test('the queue is first labelled, first served', () => {
  const next = pickNext([
    { issue: 3, queuedAt: '2026-11-12T10:05:00Z' },
    { issue: 9, queuedAt: '2026-11-12T10:01:00Z' },
  ]);
  assert.equal(next.issue, 9);
  assert.equal(pickNext([]), undefined);
});
