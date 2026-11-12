#!/usr/bin/env node
// Orchestrator for the software factory workflow (.github/workflows/factory.yml).
// Each workflow job calls one subcommand. Decisions live in ./lib (pure, unit
// tested); this file does the I/O. See docs/agents/factory.md for the stage
// contracts.

import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, cpSync, createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitHub } from './lib/github.mjs';
import { addedLines, changedFiles, checkDiff, commits } from './lib/guards.mjs';
import { agentBranch, archiveNames, branchPrefix, classifyBranches } from './lib/naming.mjs';
import { decideNext, firstStage, newState, parseCaps, pickNext } from './lib/pipeline.mjs';
import { emptyStatus, parseStatus, renderStatus, upsertEvent, withOutcome } from './lib/status.mjs';
import { fillTemplate, renderTicket } from './lib/ticket.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LABEL = {
  ready: 'ready-for-agent',
  human: 'ready-for-human',
  running: 'agent-running',
};

const env = process.env;
const RUN_ID = env.GITHUB_RUN_ID;
const RUN_URL = `${env.GITHUB_SERVER_URL}/${env.GITHUB_REPOSITORY}/actions/runs/${RUN_ID}`;
const FACTORY_DIR = env.FACTORY_DIR;
const STATE_DIR = FACTORY_DIR && join(FACTORY_DIR, 'state');
const OUT_DIR = FACTORY_DIR && join(FACTORY_DIR, 'out');

// ---------------------------------------------------------------- helpers

function gh() {
  return createGitHub({ token: env.GH_TOKEN, repository: env.GITHUB_REPOSITORY, apiUrl: env.GITHUB_API_URL });
}

function setOutput(name, value) {
  const delim = `EOF_${Math.random().toString(36).slice(2)}`;
  appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delim}\n${value}\n${delim}\n`);
}

function summary(markdown) {
  if (env.GITHUB_STEP_SUMMARY) appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
}

function readJson(path, fallback = undefined) {
  if (!existsSync(path)) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Missing ${path}`);
  }
  return JSON.parse(readFileSync(path, 'utf8'));
}

function writeFile(path, content) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof content === 'string' ? content : `${JSON.stringify(content, null, 2)}\n`);
}

function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).trim();
}

function issueNumber() {
  const n = Number(env.ISSUE);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`Invalid ISSUE "${env.ISSUE}"`);
  return n;
}

function loadState() {
  return readJson(join(STATE_DIR, 'state.json'));
}

/**
 * Records why a job failed, for the failure comment written by `finish`.
 * The first recorded reason wins: it is the root cause, later ones are fallout.
 */
function recordFailure(stage, reason) {
  const file = join(OUT_DIR, 'reason.txt');
  if (!existsSync(file)) writeFile(file, reason);
  console.error(`::error::${stage}: ${reason}`);
}

async function updateStatus(api, state, event, outcome) {
  if (!state.statusCommentId) return;
  const comment = await api.getComment(state.statusCommentId);
  let status =
    parseStatus(comment.body) ??
    emptyStatus({ issue: state.issue, branch: state.branch, pipelineUrl: state.pipeline.url });
  if (event) status = upsertEvent(status, { runId: RUN_ID, runUrl: RUN_URL, ...event });
  if (outcome) status = withOutcome(status, outcome);
  await api.updateComment(state.statusCommentId, renderStatus(status));
}

async function openPullFor(api, issue) {
  const closes = new RegExp(`\\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\\s+#${issue}\\b`, 'i');
  return (await api.listOpenPulls()).find(
    (p) => p.head.ref.startsWith(branchPrefix(issue)) || closes.test(p.body ?? ''),
  );
}

async function handOff(api, issue, { removeReady = true } = {}) {
  await api.removeLabel(issue, LABEL.running);
  if (removeReady) await api.removeLabel(issue, LABEL.ready);
}

// ---------------------------------------------------------------- start

/**
 * Claims the ticket and prepares the run.
 * Outputs: proceed, claimed, stage, branch.
 * Writes $FACTORY_DIR/out: state.json, ticket.md, feedback/*, review/* (carried).
 */
async function start() {
  const api = gh();
  const issue = issueNumber();
  const entry = env.STAGE || 'start';
  const stage = firstStage(entry);
  const fromRun = env.FROM_RUN || '';
  const carryDir = join(FACTORY_DIR, 'carry');
  setOutput('proceed', 'false');
  setOutput('claimed', 'false');

  const refuse = async (message, { toHuman = false } = {}) => {
    console.log(`Not starting: ${message}`);
    summary(`Not starting #${issue}: ${message}`);
    if (message) await api.createComment(issue, `<!-- factory:notice -->\n🏭 ${message}`);
    if (toHuman) {
      await api.removeLabel(issue, LABEL.ready);
      await api.addLabels(issue, [LABEL.human]);
    }
  };

  const ticket = await api.getIssue(issue);
  const labels = ticket.labels.map((l) => l.name);
  if (ticket.pull_request) throw new Error(`#${issue} is a pull request, not an issue`);
  if (ticket.state !== 'open') return refuse(`#${issue} is closed; the factory only builds open issues.`);
  if (env.EVENT_NAME === 'issues' && !labels.includes(LABEL.ready)) {
    return console.log(`\`${LABEL.ready}\` was removed before the run started; nothing to do.`);
  }

  const pr = await openPullFor(api, issue);
  if (pr) {
    return refuse(
      `Pull request #${pr.number} (${pr.html_url}) is already open for this issue, so the factory will not start another run. Moving to \`${LABEL.human}\`: review that PR, or close it and relabel to start over.`,
      { toHuman: !labels.includes(LABEL.running) },
    );
  }

  // One run per issue, one ticket at a time.
  const isContinuation = labels.includes(LABEL.running) && entry !== 'start' && fromRun !== '';
  if (labels.includes(LABEL.running) && !isContinuation) {
    return refuse(
      `A factory run is already in progress for this issue (\`${LABEL.running}\`), so this ${entry === 'start' ? 'label event' : `\`${entry}\` dispatch`} was ignored. To stop the current run, cancel it in Actions.`,
    );
  }
  if (!isContinuation) {
    const busy = (await api.listOpenIssuesWithLabel(LABEL.running)).filter((i) => i.number !== issue);
    if (busy.length > 0) {
      const others = busy.map((i) => `#${i.number}`).join(', ');
      if (entry === 'start') {
        return refuse(
          `Queued: the factory builds one ticket at a time and is busy with ${others}. This issue keeps \`${LABEL.ready}\` and starts automatically when the factory is free.`,
        );
      }
      return refuse(`Cannot resume at \`${entry}\`: the factory is busy with ${others}. Dispatch again once it is free.`);
    }
  }

  // Carried artifacts: a continuation carries everything, a manual resume only the feedback.
  const carried = fromRun
    ? readJson(join(carryDir, 'factory-next', 'state.json'), null) ?? readJson(join(carryDir, 'factory-state', 'state.json'), null)
    : null;
  if (fromRun && !carried) throw new Error(`Run ${fromRun} has no factory state artifact to resume from`);

  // Resolve the branch.
  const mainSha = await api.getBranchSha('main');
  const branches = await api.listBranches(branchPrefix(issue));
  let branch;
  if (entry === 'start') {
    branch = agentBranch(issue, ticket.title);
  } else {
    const { active } = classifyBranches(issue, branches);
    if (active.length !== 1) {
      return refuse(
        `Cannot resume at \`${entry}\`: expected exactly one active agent branch for #${issue}, found ${active.length ? active.map((b) => `\`${b}\``).join(', ') : 'none'}. Relabel \`${LABEL.ready}\` to start from scratch.`,
      );
    }
    branch = active[0];
  }
  const headSha = entry === 'start' ? mainSha : await api.getBranchSha(branch);

  // Resuming at `pr` must not bypass review: require an approved review of this exact commit.
  if (entry === 'pr') {
    const review = readJson(join(carryDir, 'review', 'result.json'), null);
    if (!review || review.verdict !== 'approve' || review.headSha !== headSha) {
      return refuse(
        `Cannot resume at \`pr\`: it needs \`from_run\` pointing at a run whose review approved the current head of \`${branch}\` (${headSha.slice(0, 7)}). Resume at \`review\` instead.`,
      );
    }
  }

  // Claim. A continuation inherits the claim of the run that dispatched it.
  if (!isContinuation) await api.addLabels(issue, [LABEL.running]);
  setOutput('claimed', 'true');

  if (entry === 'start') {
    for (const { from, to } of archiveNames(issue, branches)) {
      const sha = await api.getBranchSha(from);
      await api.createBranch(to, sha);
      await api.deleteBranch(from);
      console.log(`Archived ${from} as ${to}`);
    }
    await api.createBranch(branch, mainSha);
  }

  // State for this run.
  const now = new Date().toISOString();
  const state = isContinuation
    ? { ...carried }
    : newState({ issue, title: ticket.title, branch, runId: RUN_ID, runUrl: RUN_URL, now });
  Object.assign(state, { entry: stage, branch, title: ticket.title, labels });

  // Feedback for an implement run comes from the carried run's own results:
  // a failed verify, or a review that asked for rework.
  state.feedback = stage === 'implement' && fromRun ? feedbackFrom(carryDir) : null;
  if (state.feedback) cpSync(join(carryDir, state.feedback), join(OUT_DIR, 'feedback'), { recursive: true });
  if (entry === 'pr') cpSync(join(carryDir, 'review'), join(OUT_DIR, 'review'), { recursive: true });

  if (!state.statusCommentId) {
    const status = emptyStatus({ issue, branch, pipelineUrl: state.pipeline.url });
    const created = await api.createComment(issue, renderStatus(status));
    state.statusCommentId = created.id;
  }

  writeFile(join(OUT_DIR, 'ticket.md'), renderTicket(ticket, await api.listComments(issue)));
  writeFile(join(OUT_DIR, 'state.json'), state);

  const note = isContinuation
    ? `continuing at ${stage}: ${carried.lastTransition ?? 'rework'}`
    : entry === 'start'
      ? `claimed; branch created from main${archiveNames(issue, branches).length ? ' (previous attempt archived)' : ''}`
      : `manual resume at ${stage}`;
  await updateStatus(api, state, { stage: 'start', state: 'passed', note });

  setOutput('proceed', 'true');
  setOutput('stage', stage);
  setOutput('branch', branch);
  summary(`Starting #${issue} at \`${stage}\` on \`${branch}\``);
}

function feedbackFrom(carryDir) {
  if (readJson(join(carryDir, 'verify', 'result.json'), null)?.passed === false) return 'verify';
  if (readJson(join(carryDir, 'review', 'result.json'), null)?.verdict === 'rework') return 'review';
  return null;
}

// ---------------------------------------------------------------- status

async function status() {
  const [stage, state, ...noteParts] = process.argv.slice(3);
  const jobState = { success: 'passed', failure: 'failed', cancelled: 'cancelled' }[state] ?? state;
  const fromFile = (f) => (existsSync(join(OUT_DIR, f)) ? readFileSync(join(OUT_DIR, f), 'utf8').trim() : '');
  const note = noteParts.join(' ') || fromFile('reason.txt') || fromFile('note.txt');
  await updateStatus(gh(), loadState(), { stage, state: jobState, note });
}

// ---------------------------------------------------------------- prompts

function prompt() {
  const kind = process.argv[3];
  const state = loadState();
  const values = {
    issue: state.issue,
    title: state.title,
    branch: state.branch,
    ticket_path: join(STATE_DIR, 'ticket.md'),
    feedback_dir: join(STATE_DIR, 'feedback'),
    verify_dir: join(FACTORY_DIR, 'verify'),
    review_dir: join(FACTORY_DIR, 'review'),
    head_sha: env.HEAD_SHA ?? '',
  };
  const read = (name) => readFileSync(join(HERE, 'prompts', `${name}.md`), 'utf8');
  let text;
  if (kind === 'implement') {
    text = state.feedback === 'review' ? read('rework') : read('implement');
    if (state.feedback === 'verify') text += `\n${read('verify-feedback')}`;
    text += `\n${read('rules')}`;
  } else if (kind === 'review' || kind === 'pr') {
    text = read(kind);
  } else {
    throw new Error(`Unknown prompt "${kind}"`);
  }
  const filled = fillTemplate(text, values);
  writeFile(join(FACTORY_DIR, `prompt-${kind}.md`), filled);
  setOutput('prompt', filled);
  setOutput('schema', JSON.stringify(readJson(join(HERE, 'schemas', `${kind}.json`), {})));
}

// ---------------------------------------------------------------- implement

/** Reads the claude-code-action execution file and records why the agent stopped. */
function agentOutcome() {
  const [stage, file] = process.argv.slice(3);
  let reason = `the ${stage} agent did not finish successfully`;
  try {
    const messages = JSON.parse(readFileSync(file, 'utf8'));
    const result = [...messages].reverse().find((m) => m.type === 'result');
    if (result?.subtype === 'error_max_turns') reason = `the ${stage} agent hit its turn limit (--max-turns ${env.MAX_TURNS})`;
    else if (result) reason = `the ${stage} agent ended with ${result.subtype}${result.is_error ? ' (error)' : ''}`;
  } catch {
    // No execution file: the agent never started (auth, install, or timeout).
  }
  recordFailure(stage, reason);
}

/** Pushes the implementer's commits. Fails if there are none. */
function push() {
  const state = loadState();
  const before = env.BASE_SHA;
  const head = git('rev-parse', 'HEAD');
  const dirty = git('status', '--porcelain');
  if (dirty) summary(`Uncommitted files left by the agent (not pushed):\n\n\`\`\`\n${dirty}\n\`\`\``);
  if (head === before) {
    recordFailure('implement', 'the implement agent made no commits');
    process.exit(1);
  }
  try {
    git('merge-base', '--is-ancestor', before, head);
  } catch {
    recordFailure('implement', 'the implement agent rewrote branch history (amend/rebase/reset), which is not allowed');
    process.exit(1);
  }
  git('push', 'origin', `HEAD:refs/heads/${state.branch}`);
  console.log(`Pushed ${before.slice(0, 7)}..${head.slice(0, 7)} to ${state.branch}`);
}

// ---------------------------------------------------------------- verify

function run(cmd, args, log) {
  return new Promise((resolve) => {
    log.write(`\n$ ${[cmd, ...args].join(' ')}\n`);
    const child = spawn(cmd, args, { env: { ...env, CI: 'true', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
    for (const s of [child.stdout, child.stderr]) {
      s.on('data', (d) => {
        process.stdout.write(d);
        log.write(d);
      });
    }
    child.on('error', (err) => {
      log.write(`\n${err.message}\n`);
      resolve(1);
    });
    child.on('close', (code) => resolve(code ?? 1));
  });
}

function tail(text, lines) {
  const all = text.split('\n');
  return all.length <= lines ? text : [`… (${all.length - lines} earlier lines omitted)`, ...all.slice(-lines)].join('\n');
}

/**
 * Deterministic gate: `pnpm install --frozen-lockfile && pnpm verify`, plus diff guards.
 * Never fails the job for a gate failure; reports `passed` instead.
 * Writes $FACTORY_DIR/out: result.json, verify.log, feedback.md.
 */
async function verify() {
  const state = loadState();
  const logPath = join(OUT_DIR, 'verify.log');
  mkdirSync(OUT_DIR, { recursive: true });
  const log = createWriteStream(logPath);
  const headSha = git('rev-parse', 'HEAD');
  const checks = [];

  // 1. pnpm verify, the same command CI runs.
  const pkg = existsSync('package.json') ? JSON.parse(readFileSync('package.json', 'utf8')) : null;
  if (!pkg) {
    checks.push({ name: 'pnpm verify', passed: false, detail: '`package.json` is missing, so `pnpm verify` is not defined.' });
  } else if (!pkg.scripts?.verify) {
    checks.push({ name: 'pnpm verify', passed: false, detail: '`package.json` defines no `verify` script.' });
  } else if (!/^pnpm@\d/.test(pkg.packageManager ?? '')) {
    checks.push({ name: 'pnpm verify', passed: false, detail: '`package.json` must pin pnpm in `packageManager` (e.g. `"pnpm@10.x.y"`).' });
  } else {
    const steps = [
      ['npm', ['install', '--global', pkg.packageManager.split('+')[0]]],
      ['pnpm', ['install', '--frozen-lockfile']],
      ['pnpm', ['verify']],
    ];
    let failedAt = null;
    for (const [cmd, args] of steps) {
      if ((await run(cmd, args, log)) !== 0) {
        failedAt = `${cmd} ${args.join(' ')}`;
        break;
      }
    }
    checks.push({ name: 'pnpm verify', passed: !failedAt, detail: failedAt ? `\`${failedAt}\` failed.` : 'passed' });
  }

  // 2. Diff guards against main.
  const range = 'origin/main...HEAD';
  const violations = checkDiff({
    issue: state.issue,
    labels: state.labels ?? [],
    files: changedFiles(git('diff', '--name-status', '-M', range)),
    added: addedLines(git('diff', '--unified=0', '--no-color', range)),
    commitList: commits(git('log', '--format=%H%x1f%B%x1e', 'origin/main..HEAD')),
  });
  checks.push({
    name: 'diff guards',
    passed: violations.length === 0,
    detail: violations.length ? violations.map((v) => `- **${v.rule}**: ${v.detail}`).join('\n') : 'passed',
  });

  await new Promise((r) => log.end(r));
  const passed = checks.every((c) => c.passed);
  const report = checks.map((c) => `### ${c.passed ? '✅' : '❌'} ${c.name}\n\n${c.detail}`).join('\n\n');
  const output = readFileSync(logPath, 'utf8');
  writeFile(join(OUT_DIR, 'result.json'), { passed, headSha, checks });
  writeFile(
    join(OUT_DIR, 'feedback.md'),
    `# Verify result for ${headSha}\n\n${report}\n\n## Command output (tail)\n\n\`\`\`\n${tail(output, 300)}\n\`\`\`\n`,
  );
  summary(`## Verify ${passed ? 'passed' : 'failed'}\n\n${report}`);
  setOutput('passed', String(passed));
  setOutput('head_sha', headSha);
  if (!passed) {
    const failed = checks.filter((c) => !c.passed).map((c) => c.name).join(' and ');
    writeFile(join(OUT_DIR, 'note.txt'), `${failed} failed`);
  }
}

// ---------------------------------------------------------------- review

/** Turns the review agent's structured output into the review contract. */
function reviewResult() {
  const raw = JSON.parse(env.STRUCTURED_OUTPUT || 'null');
  if (!raw || typeof raw.report !== 'string' || !Array.isArray(raw.blocking_findings)) {
    recordFailure('review', 'the review agent returned no usable structured output');
    process.exit(1);
  }
  const verdict = raw.blocking_findings.length > 0 ? 'rework' : 'approve';
  const result = { verdict, headSha: env.HEAD_SHA, blockingFindings: raw.blocking_findings };
  writeFile(join(OUT_DIR, 'result.json'), result);
  writeFile(join(OUT_DIR, 'report.md'), raw.report);
  writeFile(
    join(OUT_DIR, 'note.txt'),
    verdict === 'approve' ? 'no blocking findings' : `${raw.blocking_findings.length} blocking finding(s)`,
  );
  summary(`## Review: ${verdict}\n\n${raw.report}`);
  setOutput('verdict', verdict);
}

// ---------------------------------------------------------------- pr

async function openPr() {
  const api = gh();
  const state = loadState();
  const out = JSON.parse(env.STRUCTURED_OUTPUT || 'null');
  if (!out || typeof out.body !== 'string' || !out.body.trim()) {
    recordFailure('pr', 'the pr agent returned no PR body');
    process.exit(1);
  }
  const existing = await openPullFor(api, state.issue);
  if (existing) {
    recordFailure('pr', `PR #${existing.number} was opened for this issue while the run was in progress`);
    process.exit(1);
  }
  const closes = new RegExp(`\\bCloses #${state.issue}\\b`);
  const body = closes.test(out.body) ? out.body : `${out.body.trim()}\n\nCloses #${state.issue}\n`;
  const pull = await api.createPull({
    title: state.title,
    head: state.branch,
    base: 'main',
    body,
    draft: false,
    maintainer_can_modify: true,
  });
  const report = readFileSync(join(FACTORY_DIR, 'review', 'report.md'), 'utf8');
  await api.createComment(pull.number, `## Factory review report\n\nFinal \`code-review\` of ${env.HEAD_SHA}: no blocking findings.\n\n${report}`);
  writeFile(join(OUT_DIR, 'note.txt'), `opened #${pull.number}`);
  setOutput('url', pull.html_url);
  summary(`Opened ${pull.html_url}`);
}

// ---------------------------------------------------------------- finish

function readReasons(dir) {
  const reasons = {};
  for (const stage of ['start', 'implement', 'verify', 'review', 'pr']) {
    const file = join(dir, stage === 'start' ? 'factory-state' : `outcome-${stage}`, 'reason.txt');
    if (existsSync(file)) reasons[stage] = readFileSync(file, 'utf8').trim();
  }
  return reasons;
}

/** Decides the transition after a run. Writes $FACTORY_DIR/out/state.json (next state) and decision.json. */
function finishDecide() {
  const artifacts = join(FACTORY_DIR, 'artifacts');
  const jobs = JSON.parse(env.NEEDS);
  const state = readJson(join(artifacts, 'factory-state', 'state.json'), null);
  const counters = state?.counters ?? { verifyFailures: 0, reviewRounds: 0 };
  const decision = decideNext({
    entry: state?.entry ?? 'implement',
    jobs,
    counters,
    caps: parseCaps(env),
    reasons: readReasons(artifacts),
  });
  console.log(JSON.stringify(decision, null, 2));
  writeFile(join(OUT_DIR, 'decision.json'), decision);
  if (state && decision.action === 'continue') {
    writeFile(join(OUT_DIR, 'state.json'), {
      ...state,
      counters: decision.counters,
      lastTransition: decision.reason,
    });
  }
  setOutput('action', decision.action);
}

async function finishAct() {
  const api = gh();
  const issue = issueNumber();
  const artifacts = join(FACTORY_DIR, 'artifacts');
  const decision = readJson(join(OUT_DIR, 'decision.json'));
  const state = readJson(join(artifacts, 'factory-state', 'state.json'), null);
  const branch = state?.branch ?? '(not created)';

  if (decision.action === 'continue') {
    await updateStatus(api, state, { stage: decision.stage, state: 'rework', note: decision.reason });
    await api.dispatch({ issue: String(issue), stage: 'implement', from_run: String(RUN_ID) });
    summary(`Dispatched a rework run: ${decision.reason}`);
    return;
  }

  if (decision.action === 'done') {
    if (state) await updateStatus(api, state, null, `✅ Opened ${decision.url}`);
    await handOff(api, issue);
    summary(`Done: ${decision.url}`);
  } else {
    const message = [
      '<!-- factory:failure -->',
      `🏭 **The software factory stopped and needs a human.**`,
      '',
      `- **Stage:** \`${decision.stage}\``,
      `- **What failed:** ${decision.reason}`,
      `- **Branch:** \`${branch}\``,
      `- **Run:** ${RUN_URL}`,
      '',
      `Moved to \`${LABEL.human}\`. To resume a stage, dispatch the factory workflow with \`issue=${issue}\` and \`stage\` (see \`docs/agents/factory.md\`); to start from scratch, relabel \`${LABEL.ready}\`.`,
    ].join('\n');
    await api.createComment(issue, message);
    if (state) await updateStatus(api, state, null, `❌ Stopped at \`${decision.stage}\`: ${decision.reason}`);
    if (env.CLAIMED === 'true') await handOff(api, issue);
    await api.addLabels(issue, [LABEL.human]);
    summary(`Failed at ${decision.stage}: ${decision.reason}`);
  }

  await dispatchNextQueued(api, issue);
}

// ---------------------------------------------------------------- queue

async function queuedCandidates(api, exclude) {
  const ready = (await api.listOpenIssuesWithLabel(LABEL.ready)).filter(
    (i) => i.number !== exclude && !i.labels.some((l) => l.name === LABEL.running),
  );
  const out = [];
  for (const i of ready) {
    if (await openPullFor(api, i.number)) continue;
    const labelled = (await api.listIssueEvents(i.number))
      .filter((e) => e.event === 'labeled' && e.label?.name === LABEL.ready)
      .at(-1);
    out.push({ issue: i.number, queuedAt: labelled?.created_at ?? i.created_at });
  }
  return out;
}

async function dispatchNextQueued(api, justFinished) {
  if ((await api.listOpenIssuesWithLabel(LABEL.running)).some((i) => i.number !== justFinished)) return;
  const next = pickNext(await queuedCandidates(api, justFinished));
  if (!next) return console.log('Queue is empty.');
  await api.dispatch({ issue: String(next.issue), stage: 'start', from_run: '' });
  console.log(`Dispatched queued ticket #${next.issue}`);
  summary(`Started queued ticket #${next.issue}`);
}

/**
 * Scheduled safety net: releases tickets whose run died without reaching
 * `finish` (runner lost, workflow disabled), then starts the queue if idle.
 */
async function sweep() {
  const api = gh();
  const staleAfterMs = 15 * 60 * 1000;
  const runs = await api.listRecentRuns();
  const runsFor = (n) => runs.filter((r) => r.display_title.startsWith(`factory #${n} `));

  for (const i of await api.listOpenIssuesWithLabel(LABEL.running)) {
    const mine = runsFor(i.number);
    const live = mine.some((r) => r.status !== 'completed');
    const lastEnded = Math.max(0, ...mine.map((r) => Date.parse(r.updated_at)));
    if (live || Date.now() - lastEnded < staleAfterMs) continue;
    await api.createComment(
      i.number,
      [
        '<!-- factory:failure -->',
        '🏭 **The software factory stopped and needs a human.**',
        '',
        `- **What failed:** \`${LABEL.running}\` is set but no factory run is active for this issue (the run died before it could report).`,
        `- **Last run:** ${mine[0]?.html_url ?? 'none found'}`,
        '',
        `Moved to \`${LABEL.human}\`.`,
      ].join('\n'),
    );
    await handOff(api, i.number);
    await api.addLabels(i.number, [LABEL.human]);
    console.log(`Released stale claim on #${i.number}`);
  }

  if ((await api.listOpenIssuesWithLabel(LABEL.running)).length > 0) return;
  // Don't race a start that is already queued or running.
  if (runs.some((r) => r.status !== 'completed' && r.id !== Number(RUN_ID) && !r.display_title.startsWith('factory sweep'))) return;
  await dispatchNextQueued(api, 0);
}

// ---------------------------------------------------------------- main

const commands = {
  start,
  status,
  prompt,
  'agent-outcome': agentOutcome,
  push,
  verify,
  'review-result': reviewResult,
  'open-pr': openPr,
  'finish-decide': finishDecide,
  'finish-act': finishAct,
  sweep,
};

const name = process.argv[2];
if (!commands[name]) {
  console.error(`Usage: cli.mjs <${Object.keys(commands).join('|')}>`);
  process.exit(2);
}
try {
  await commands[name]();
} catch (err) {
  console.error(err);
  if (OUT_DIR && name !== 'status') {
    try {
      recordFailure(name, `unexpected error in \`${name}\`: ${err.message.split('\n')[0]}`);
    } catch {}
  }
  process.exit(1);
}

