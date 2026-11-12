// Diff guards run by the verify stage on top of `pnpm verify`. Pure: no I/O.
//
// They catch the cheap ways an agent can make a gate pass without doing the
// work: focusing or skipping tests, silencing the linter or type checker,
// shipping code without tests, or editing the factory that judges it.

const CODE_FILE = /\.(?:[cm]?[jt]sx?|vue|svelte|astro)$/;

const TEST_FILE = [/(?:^|\/)(?:__tests__|tests?|e2e|specs?)\//, /\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/];

// Paths the agent must never change: the factory itself and the skills it is judged by.
const PROTECTED = [/^\.github\/factory\//, /^\.github\/workflows\/factory[^/]*\.ya?ml$/, /^\.claude\/skills\//];

const FOCUS_OR_SKIP = [
  /\b(?:describe|context|suite|it|test|bench)(?:\.\w+)*\.(?:only|skip|fixme)\b/,
  /\b(?:fdescribe|fit|xdescribe|xit|xtest)\s*\(/,
];

const SUPPRESSION = /(?:eslint-disable|oxlint-disable|biome-ignore|tslint:disable|@ts-ignore|@ts-expect-error|@ts-nocheck)/;

/**
 * Parses `git diff --unified=0` output into added lines per file.
 * @returns {Map<string, {line: number, text: string}[]>}
 */
export function addedLines(unifiedDiff) {
  const files = new Map();
  let current = null;
  let lineNo = 0;
  for (const raw of unifiedDiff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      current = null;
    } else if (raw.startsWith('+++ ')) {
      const path = raw.slice(4).trim();
      current = path === '/dev/null' ? null : path.replace(/^b\//, '');
      if (current && !files.has(current)) files.set(current, []);
    } else if (raw.startsWith('@@')) {
      const m = raw.match(/\+(\d+)/);
      lineNo = m ? Number(m[1]) : 0;
    } else if (current && raw.startsWith('+')) {
      files.get(current).push({ line: lineNo++, text: raw.slice(1) });
    }
  }
  return files;
}

/**
 * Parses `git diff --name-status -M` output.
 * @returns {{status: string, path: string, from?: string}[]}
 */
export function changedFiles(nameStatus) {
  return nameStatus
    .split('\n')
    .filter(Boolean)
    .map((row) => {
      const [status, a, b] = row.split('\t');
      return b ? { status: status[0], path: b, from: a } : { status: status[0], path: a };
    });
}

/**
 * Parses `git log --format=%H%x1f%B%x1e` output.
 * @returns {{sha: string, message: string}[]}
 */
export function commits(log) {
  return log
    .split('\x1e')
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => {
      const [sha, message = ''] = c.split('\x1f');
      return { sha: sha.trim(), message: message.trim() };
    });
}

export const isTestFile = (path) => TEST_FILE.some((re) => re.test(path));

/**
 * @returns {{rule: string, detail: string}[]} one entry per violation; empty means the diff passes.
 */
export function checkDiff({ issue, labels, files, added, commitList }) {
  const violations = [];

  if (files.length === 0) {
    violations.push({ rule: 'empty-diff', detail: 'The branch has no changes compared to main.' });
    return violations;
  }

  for (const f of files) {
    for (const p of [f.path, f.from].filter(Boolean)) {
      if (PROTECTED.some((re) => re.test(p))) {
        violations.push({
          rule: 'protected-path',
          detail: `\`${p}\` is part of the factory or its pinned skills; agents must not change it.`,
        });
      }
    }
  }

  for (const [path, lines] of added) {
    if (!CODE_FILE.test(path)) continue;
    for (const { line, text } of lines) {
      if (FOCUS_OR_SKIP.some((re) => re.test(text))) {
        violations.push({ rule: 'focused-or-skipped-test', detail: `${path}:${line}: \`${text.trim()}\`` });
      }
      if (SUPPRESSION.test(text)) {
        violations.push({ rule: 'lint-or-type-suppression', detail: `${path}:${line}: \`${text.trim()}\`` });
      }
    }
  }

  const touchesTests = files.some((f) => f.status !== 'D' && isTestFile(f.path));
  if (!touchesTests && !labels.includes('no-tests-needed')) {
    violations.push({
      rule: 'no-tests',
      detail: 'The diff adds or changes no test files (the issue is not labelled `no-tests-needed`).',
    });
  }

  const ref = new RegExp(`#${issue}\\b`);
  for (const c of commitList) {
    if (!ref.test(c.message)) {
      violations.push({
        rule: 'commit-without-issue-ref',
        detail: `${c.sha.slice(0, 7)} "${c.message.split('\n')[0]}" does not reference #${issue}.`,
      });
    }
  }

  return violations;
}
