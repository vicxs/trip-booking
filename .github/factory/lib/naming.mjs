// Branch naming for agent work. Pure: no I/O.
//
// The active branch for issue <n> is `agent/<n>-<slug>`. When a ticket is
// restarted from scratch, the previous active branch is kept under
// `agent/<n>-<slug>-attempt-<k>` (never deleted).

const ATTEMPT_SUFFIX = /-attempt-(\d+)$/;

export function slugify(title, maxLength = 40) {
  const slug = title
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (slug.length <= maxLength) return slug || 'ticket';
  // Cut on a word boundary when there is one.
  const cut = slug.slice(0, maxLength + 1);
  const boundary = cut.lastIndexOf('-');
  return (boundary > 0 ? cut.slice(0, boundary) : cut.slice(0, maxLength)).replace(/-+$/g, '');
}

export function agentBranch(issue, title) {
  return `agent/${issue}-${slugify(title)}`;
}

export function branchPrefix(issue) {
  return `agent/${issue}-`;
}

/** Splits the issue's agent branches into the active one(s) and archived attempts. */
export function classifyBranches(issue, branchNames) {
  const prefix = branchPrefix(issue);
  const mine = branchNames.filter((b) => b.startsWith(prefix));
  return {
    active: mine.filter((b) => !ATTEMPT_SUFFIX.test(b)).sort(),
    attempts: mine
      .map((b) => b.match(ATTEMPT_SUFFIX))
      .filter(Boolean)
      .map((m) => Number(m[1])),
  };
}

/**
 * Archive names for the active branches, numbered after the highest attempt
 * already present so an archived attempt is never overwritten.
 */
export function archiveNames(issue, branchNames) {
  const { active, attempts } = classifyBranches(issue, branchNames);
  let next = Math.max(0, ...attempts) + 1;
  return active.map((from) => ({ from, to: `${from}-attempt-${next++}` }));
}
