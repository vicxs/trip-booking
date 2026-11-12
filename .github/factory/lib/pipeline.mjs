// Pipeline state machine. Pure: no I/O.
//
// One workflow run executes a contiguous slice of the stages below, starting
// at the run's entry stage. After the run, `decideNext` turns the job results
// into exactly one transition: continue (dispatch a rework run), done (PR is
// open) or fail (hand the ticket to a human).

export const STAGES = ['implement', 'verify', 'review', 'pr'];
export const ENTRY_STAGES = ['start', ...STAGES];

export const DEFAULT_CAPS = { verifyRetries: 3, reviewRounds: 2 };

export function parseCaps(env) {
  return {
    verifyRetries: positiveInt(env.FACTORY_VERIFY_RETRIES, DEFAULT_CAPS.verifyRetries),
    reviewRounds: positiveInt(env.FACTORY_REVIEW_ROUNDS, DEFAULT_CAPS.reviewRounds),
  };
}

function positiveInt(raw, fallback) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Expected a non-negative integer, got "${raw}"`);
  return n;
}

/** The stage the run's first job executes: `start` means a fresh pipeline beginning with implement. */
export function firstStage(entry) {
  if (!ENTRY_STAGES.includes(entry)) throw new Error(`Unknown stage "${entry}"`);
  return entry === 'start' ? 'implement' : entry;
}

export function newState({ issue, title, branch, runId, runUrl, now }) {
  return {
    version: 1,
    issue,
    title,
    branch,
    pipeline: { id: String(runId), url: runUrl, startedAt: now },
    statusCommentId: null,
    entry: 'implement',
    counters: { verifyFailures: 0, reviewRounds: 0 },
    feedback: null,
  };
}

const FAILED = new Set(['failure', 'cancelled']);

/**
 * @param {object} p
 * @param {string} p.entry           first stage this run executed
 * @param {object} p.jobs            `needs` context: { start, implement, verify, review, pr } -> { result, outputs }
 * @param {object} p.counters        counters at the start of this run
 * @param {object} p.caps            { verifyRetries, reviewRounds }
 * @param {object} [p.reasons]       optional per-stage failure reasons collected from artifacts
 */
export function decideNext({ entry, jobs, counters, caps, reasons = {} }) {
  for (const stage of ['start', ...STAGES]) {
    const result = jobs[stage]?.result;
    if (FAILED.has(result)) {
      const fallback =
        result === 'cancelled'
          ? 'the job was cancelled (stopped manually, superseded, or hit its timeout)'
          : 'the job failed unexpectedly';
      return { action: 'fail', stage, reason: reasons[stage] || fallback };
    }
  }

  const verify = jobs.verify;
  if (verify?.result === 'success' && verify.outputs?.passed !== 'true') {
    const verifyFailures = counters.verifyFailures + 1;
    if (verifyFailures > caps.verifyRetries) {
      return {
        action: 'fail',
        stage: 'verify',
        reason: `verify is still failing after ${caps.verifyRetries} implement retries`,
      };
    }
    return {
      action: 'continue',
      stage: 'verify',
      feedback: 'verify',
      counters: { ...counters, verifyFailures },
      reason: `verify failed (retry ${verifyFailures} of ${caps.verifyRetries})`,
    };
  }

  const review = jobs.review;
  if (review?.result === 'success' && review.outputs?.verdict === 'rework') {
    const reviewRounds = counters.reviewRounds + 1;
    if (reviewRounds > caps.reviewRounds) {
      return {
        action: 'fail',
        stage: 'review',
        reason: `review still has blocking findings after ${caps.reviewRounds} rework rounds`,
      };
    }
    return {
      action: 'continue',
      stage: 'review',
      feedback: 'review',
      counters: { verifyFailures: 0, reviewRounds },
      reason: `review requested rework (round ${reviewRounds} of ${caps.reviewRounds})`,
    };
  }

  if (jobs.pr?.result === 'success' && jobs.pr.outputs?.url) {
    return { action: 'done', stage: 'pr', url: jobs.pr.outputs.url };
  }

  return {
    action: 'fail',
    stage: lastRanStage(jobs) ?? firstStage(entry),
    reason: 'the run ended without opening a PR or scheduling rework (unexpected job outcome)',
  };
}

function lastRanStage(jobs) {
  return [...STAGES].reverse().find((s) => jobs[s] && jobs[s].result !== 'skipped');
}

/** Ordering for the queue of `ready-for-agent` tickets: first labelled, first served. */
export function pickNext(candidates) {
  return [...candidates].sort(
    (a, b) => Date.parse(a.queuedAt) - Date.parse(b.queuedAt) || a.issue - b.issue,
  )[0];
}
