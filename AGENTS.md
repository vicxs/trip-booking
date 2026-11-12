## Agent skills

### Issue tracker

Issues are tracked in GitHub Issues through the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

Uses the five default labels: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single context: one `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

### Testing

Every issue follows `docs/testing-strategy.md`: unit (Vitest) and API (Playwright) tests are written test-first in the implementation PR (`test(#N)` commit before `feat(#N)`); E2E tests come afterwards in a separate `E2E: <title> (#N)` ticket. Use accessible roles and names in the UI.
