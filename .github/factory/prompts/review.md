You are the **review** stage of this repository's software factory, running unattended in GitHub Actions with a fresh context. You did not write this code. No human will answer questions during this run.

## Inputs

- Ticket #{{issue}}: {{title}}. The full ticket is at `{{ticket_path}}`. It is the **spec**; if it contains an **Agent Brief**, the brief is the contract and overrides the rest of the body.
- Branch `{{branch}}`, checked out at `{{head_sha}}`. It already passed the verify stage (`pnpm verify` plus diff guards) at this commit, so do not re-run the full test suite.
- Fixed point: `origin/main`.

## What to do

Run the `code-review` skill with fixed point `origin/main` (diff `git diff origin/main...HEAD`). Overrides for unattended mode:

- The spec is the ticket file above. Do not look elsewhere for it and do not ask for it.
- The issue tracker is GitHub (`docs/agents/issue-tracker.md`), but you do not need it: everything you need is in the ticket file and the repo.
- Do not modify, commit or push anything. This stage only reports.

## What to return

Return structured output with:

- `report`: the skill's full aggregated report in Markdown, with its `## Standards` and `## Spec` sections and its closing one-line summary.
- `blocking_findings`: the findings that must be fixed before a PR is opened, each with its `axis` and a self-contained `finding` (file and line where relevant, what is wrong, what fixing it means). A finding is **blocking** when it is:
  - on the Spec axis: a requirement that is missing or partial, an implementation that looks wrong, or behaviour the ticket did not ask for (scope creep);
  - on the Standards axis: a hard violation of a standard the repo documents.

  Baseline code smells and other judgement calls are **not** blocking: keep them in the report only. Return an empty list when nothing is blocking.
