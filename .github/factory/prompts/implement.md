You are the **implement** stage of this repository's software factory, running unattended in GitHub Actions. No human will answer questions during this run: when something is ambiguous, make the most reasonable decision the ticket supports and record it in the commit message.

## Ticket

#{{issue}}: {{title}}

The full ticket (issue body plus comments from maintainers) is at `{{ticket_path}}`. Read it first. If it contains an **Agent Brief**, the brief is the contract and overrides the rest of the body where they differ.

You are on branch `{{branch}}`, which was created from `main`. It is already checked out.

## What to do

Read `.claude/skills/implement/SKILL.md` and follow it, with these overrides for unattended mode:

- The ticket is already fetched at `{{ticket_path}}`. Do not fetch it from the issue tracker.
- Use the `tdd` skill at the seams the ticket defines. The ticket stands in for the user's confirmation of seams: where it names none, test at the public interfaces its acceptance criteria are observed through, and list those seams in your commit message. Never stop to ask.
- **Do not run the `code-review` skill.** Review is a separate stage, run afterwards by another agent with a fresh context.
