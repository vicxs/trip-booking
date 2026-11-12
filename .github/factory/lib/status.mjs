// The status comment: one per pipeline, edited in place at each stage
// transition. Its data lives in a hidden JSON block so any job can patch it
// without coordinating with the others. Pure: no I/O.

export const STATUS_MARKER = '<!-- factory:status -->';
const DATA_RE = /<!-- factory:data (.*?) -->/s;

const ICON = {
  queued: '🕓 queued',
  running: '⏳ running',
  passed: '✅ passed',
  failed: '❌ failed',
  rework: '🔁 rework',
  skipped: '⏭️ skipped',
  cancelled: '🛑 cancelled',
};

export function emptyStatus({ issue, branch, pipelineUrl }) {
  return { issue, branch, pipelineUrl, events: [], outcome: null };
}

/** Inserts or replaces the event for (runId, stage). */
export function upsertEvent(status, event) {
  const events = [...status.events];
  const i = events.findIndex((e) => e.runId === event.runId && e.stage === event.stage);
  if (i === -1) events.push(event);
  else events[i] = { ...events[i], ...event };
  return { ...status, events };
}

export function withOutcome(status, outcome) {
  return { ...status, outcome };
}

export function renderStatus(status) {
  const rows = status.events.map(
    (e, i) =>
      `| ${i + 1} | ${e.stage} | ${ICON[e.state] ?? e.state} | [${e.runId}](${e.runUrl}) | ${escapeCell(e.note ?? '')} |`,
  );
  const outcome = status.outcome
    ? `\n**Outcome:** ${status.outcome}\n`
    : '\n_In progress. This comment is updated at each stage transition._\n';
  return [
    STATUS_MARKER,
    `### 🏭 Software factory · #${status.issue}`,
    '',
    `**Branch:** \`${status.branch}\` · **Pipeline:** [started here](${status.pipelineUrl})`,
    '',
    '| # | Stage | State | Run | Note |',
    '|---|---|---|---|---|',
    ...rows,
    outcome,
    `<!-- factory:data ${encodeData(status)} -->`,
  ].join('\n');
}

export function parseStatus(body) {
  const m = body?.match(DATA_RE);
  if (!m) return null;
  return JSON.parse(m[1]);
}

// `--` would terminate the HTML comment; - is the same character to JSON.
function encodeData(data) {
  return JSON.stringify(data).replace(/--/g, '-\\u002d');
}

function escapeCell(text) {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
