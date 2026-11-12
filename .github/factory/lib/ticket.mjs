// Builds the ticket file the agents read. Pure: no I/O.
//
// The repo is public, so anyone can comment on an issue after it is labelled.
// Only content from people with write access reaches the agents.

export const TRUSTED_ASSOCIATIONS = new Set(['OWNER', 'MEMBER', 'COLLABORATOR']);

export function renderTicket(issue, comments) {
  const trusted = comments.filter((c) => TRUSTED_ASSOCIATIONS.has(c.author_association) && !isFactoryComment(c));
  const labels = issue.labels.map((l) => (typeof l === 'string' ? l : l.name));
  return [
    `# #${issue.number}: ${issue.title}`,
    '',
    `Labels: ${labels.join(', ') || '(none)'}`,
    '',
    '## Issue body',
    '',
    issue.body?.trim() || '(empty)',
    '',
    ...trusted.flatMap((c) => [
      `## Comment by @${c.user.login} (${c.created_at})`,
      '',
      c.body.trim(),
      '',
    ]),
    trusted.length < comments.length
      ? `_${comments.length - trusted.length} comment(s) omitted: factory status comments and comments from accounts without write access._`
      : '',
  ].join('\n');
}

function isFactoryComment(c) {
  return c.body.includes('<!-- factory:');
}

/** Fills `{{name}}` placeholders; an unknown placeholder is a bug, so it throws. */
export function fillTemplate(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in values)) throw new Error(`Template placeholder {{${key}}} has no value`);
    return String(values[key]);
  });
}
