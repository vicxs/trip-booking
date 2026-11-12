## Rules for this run

- Commit your work on the current branch. **Every commit message references #{{issue}}** (for example `Add trip creation endpoint (#{{issue}})`).
- Never push, amend, rebase, reset, force-push, or switch branches. The workflow pushes your commits when you finish.
- Do not change `.github/factory/`, `.github/workflows/factory*.yml` or `.claude/skills/`. The verify stage rejects any diff that touches them.
- Before finishing, run the same gate the verify stage runs, if it exists: `pnpm install --frozen-lockfile && pnpm verify`. Verify runs it on a fresh `ubuntu-latest` runner with no other setup, so `pnpm verify` must be self-contained (for example, it starts the services and installs the browsers it needs).
- The verify stage also rejects diffs that:
  - add `.only`, `.skip` or `.fixme` to tests, or `fit`/`xit`-style focused or skipped tests;
  - add lint or type-check suppressions (`eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `biome-ignore`, `oxlint-disable`);
  - change no test files (unless the issue is labelled `no-tests-needed`);
  - contain a commit that does not reference #{{issue}}.
- Use the domain vocabulary in `CONTEXT.md` (the glossary) for names in code and tests. Read `AGENTS.md` and `docs/agents/` for repo conventions.
- Leave the working tree clean: commit what belongs in the change, and make sure generated files are ignored rather than committed.
