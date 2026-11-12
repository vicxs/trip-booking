# Software factory

The software factory takes an issue labelled `ready-for-agent` and opens a reviewed pull request without a human in between. People are involved only at the two ends: **triage** (plus grilling when needed) before, and **PR review and merge** after.

```
human:   /triage  →  (/grilling)  →  label ready-for-agent
factory: start → implement → verify → review → pr        (loops: verify→implement, review→rework)
human:   review + merge the PR
```

It runs entirely on GitHub: Issues as the tracker, Actions as orchestrator and runner, and a custom GitHub App as the bot identity. The factory never merges and never pushes to `main` (the `protect-main` ruleset would refuse it anyway).

## Where things live

| Path | What |
|---|---|
| `.github/workflows/factory.yml` | The workflow: one job per stage, plus `finish` and `sweep`. |
| `.github/factory/cli.mjs` | Orchestrator: every job calls one subcommand. |
| `.github/factory/lib/` | Pure logic: state machine (`pipeline.mjs`), diff guards, branch naming, status comment, ticket file. |
| `.github/factory/prompts/` | Stage prompts (`implement`, `rework`, `verify-feedback`, `rules`, `review`, `pr`). |
| `.github/factory/schemas/` | JSON schemas for the structured output of the review and pr agents. |
| `.github/factory/test/` | `node --test` suite, including the CLI run against a fake GitHub API. |
| `.github/workflows/factory-selftest.yml` | CI for the factory itself: tests and actionlint. |
| `.claude/skills/{implement,tdd,code-review,pr}` | Pinned copies of the skills the agents use. |

Changes to any of these go through a normal PR. The verify stage rejects agent diffs that touch `.github/factory/`, `.github/workflows/factory*.yml` or `.claude/skills/`, so the factory cannot change its own rules.

## Flow

One workflow run executes a slice of the pipeline. Loops are new runs: when a run ends in rework, `finish` dispatches the next run with `from_run` set to itself, so the next run can carry the state, counters and feedback forward.

```
start ─► implement ─► verify ─┬─ failed ──► finish ─► dispatch implement (feedback: verify output)
                              └─ passed ─► review ─┬─ rework ──► finish ─► dispatch implement (rework: review findings)
                                                   └─ approve ─► pr ─► finish ─► done
any job fails, times out, or is cancelled ─────────────────────────────► finish ─► hand to a human
```

### Trigger and claiming

- Adding `ready-for-agent` to an issue starts a run (`issues: labeled`). Label events for any other label start a run whose jobs are all skipped (it is named `factory · ignored label …`).
- Runs for the same issue share a concurrency group with `queue: max`: they are serialized and never cancelled.
- **One ticket at a time.** The `start` job runs in a global `factory-claim` concurrency group and claims the issue by adding `agent-running`. If another issue already has `agent-running`, the new issue is **queued**: it gets a comment, keeps `ready-for-agent`, and is started automatically when the factory frees up (first labelled, first served).
- `agent-running` is removed whenever a pipeline ends, whatever the outcome. While a rework run is pending the label stays, so the issue stays claimed between runs.
- **Relabelling** (remove and re-add `ready-for-agent`):
  - during a run: ignored with a comment; no second run, no second PR.
  - after a failed run: starts fresh from `main`. The previous branch is renamed `agent/<n>-<slug>-attempt-<k>`, never deleted.
  - while an open PR exists for the issue (head `agent/<n>-…` or a body that closes `#<n>`): refused with a comment linking the PR, and the issue moves to `ready-for-human`.

### Stages and their contracts

Every job writes its results as workflow artifacts. Artifacts are the only thing stages share, so the topology could change (for example, to label-chained workflows) without rewriting the stages.

| Stage | Agent? | Inputs | Outputs |
|---|---|---|---|
| `start` | no | issue, `stage`, optional `from_run` (that run's artifacts are downloaded to `carry/`) | Job outputs `proceed`, `claimed`, `stage`, `branch`. Artifact **`factory-state`**: `state.json`, `ticket.md`, `feedback/` (implement retries), `review/` (pr resume), `src/` (the factory code from `main`), `reason.txt` on crash. |
| `implement` | yes | `factory-state` | Commits pushed to the agent branch. Artifact **`outcome-implement`** (`reason.txt`) on failure. |
| `verify` | no | `factory-state`, agent branch | Job outputs `passed`, `head_sha`. Artifact **`verify`**: `result.json` (`{passed, headSha, checks}`), `verify.log`, `feedback.md`. |
| `review` | yes | `factory-state`, `head_sha` | Job output `verdict` (`approve` or `rework`). Artifact **`review`**: `result.json` (`{verdict, headSha, blockingFindings}`), `report.md`. |
| `pr` | yes (writes the body only) | `factory-state`, `verify`, `review` | Job output `url`. The PR itself and a PR comment with the review report. |
| `finish` | no | every artifact of the run, `needs` | The transition: dispatch the next run (and upload **`factory-next`**: `state.json` with the updated counters), or close the pipeline. |

`state.json` holds: `issue`, `title`, `branch`, `labels`, `pipeline` (id and URL of the run that started the pipeline), `statusCommentId`, `entry` (the stage this run started at), `counters` (`verifyFailures`, `reviewRounds`), `feedback` (`verify`, `review` or `null`) and `lastTransition`.

The jobs that touch the agent branch (`implement`, `verify`, `review`, `pr`) run the factory code from the `factory-state` artifact (a copy of `main`), never from the branch. The workflow file itself always comes from `main`.

**Implement.** A fresh agent on `agent/<n>-<slug>` follows the `implement` skill, using `tdd` at the seams the ticket defines. It does not run `code-review` (the prompt says so and `Skill(code-review)` is a denied tool). It commits with messages that reference the issue; the workflow pushes, and rejects history rewrites. On a retry after a failed verify, it gets the failing output. On a rework round, a separate `rework` prompt tells it to fix only what the review named.

The agent reads the ticket from a file built by `start`: the issue body plus comments from accounts with write access. Comments from anyone else are left out, because the repo is public.

**Verify** (deterministic, no agent). On a fresh `ubuntu-latest` runner: install the `pnpm` pinned in `packageManager`, then `pnpm install --frozen-lockfile && pnpm verify`. That is the same command CI runs, so **`pnpm verify` must be self-contained** (format, lint, typecheck, unit and E2E tests, build; it starts whatever services and browsers it needs). A missing `package.json`, missing `verify` script or unpinned `packageManager` is a failure, with no fallback. Then the diff guards against `main` run:

- no added `.only` / `.skip` / `.fixme`, or `fit` / `xit`-style focused or skipped tests;
- no added lint or TS suppressions (`eslint-disable`, `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck`, `biome-ignore`, `oxlint-disable`, `tslint:disable`);
- the diff touches test files, unless the issue is labelled `no-tests-needed`;
- every commit references `#<n>`;
- no changes to the factory or its pinned skills.

A gate failure does not fail the job: `passed=false` sends the ticket back to implement with the output.

**Review** (separate agent, fresh context). It runs the `code-review` skill against `origin/main...HEAD`, with the ticket (and its Agent Brief) as the spec. Its token is read-only, and its edit tools are denied. It returns the full report and a list of **blocking** findings: on the Spec axis, anything missing, wrong or out of scope; on the Standards axis, hard violations of a documented standard. Baseline smells and other judgement calls stay in the report and do not block. The verdict is computed by `cli.mjs`: `rework` if any finding blocks, otherwise `approve`.

**PR.** An agent with a read-only token writes only the body, using the `pr` skill (Summary / Evidence / Merge Danger), with the verify log as evidence. `cli.mjs` opens the PR as the App (title = issue title, `Closes #<n>` guaranteed, ready for review, base `main`) and posts the final review report as a PR comment. Because the App opens it, the PR triggers the repo's normal CI. The factory never merges.

### Brakes

| Repo variable | Default | What |
|---|---|---|
| `FACTORY_IMPLEMENT_MAX_TURNS` | 80 | `--max-turns` for implement and rework runs |
| `FACTORY_IMPLEMENT_TIMEOUT_MINUTES` | 45 | implement job timeout |
| `FACTORY_REVIEW_MAX_TURNS` | 40 | `--max-turns` for review |
| `FACTORY_REVIEW_TIMEOUT_MINUTES` | 20 | review job timeout |
| `FACTORY_VERIFY_RETRIES` | 3 | implement retries after a failed verify, counted since the last verify that passed |
| `FACTORY_REVIEW_ROUNDS` | 2 | review → rework rounds per pipeline |
| `FACTORY_VERIFY_TIMEOUT_MINUTES` | 30 | verify job timeout |
| `FACTORY_PR_MAX_TURNS` / `FACTORY_PR_TIMEOUT_MINUTES` | 20 / 15 | pr stage limits |
| `FACTORY_MODEL` | (unset) | optional `--model` for every agent |

There is no dollar budget, because auth uses a subscription. When a cap, turn limit or timeout is hit, or anything else fails unexpectedly, `finish` comments on the issue with the stage, what failed, the branch and the run link. It then moves the issue to `ready-for-human`, removes `ready-for-agent` and `agent-running`, and starts the next queued ticket. An implement agent that stops early (turn limit, error) still has its commits pushed, so a human can pick up from the branch; a job timeout kills the runner before that push.

The hourly `sweep` is the safety net for runs that die without reaching `finish` (lost runner, disabled workflow). If an issue has had `agent-running` with no live factory run for 15 minutes, `sweep` releases it the same way. When the factory is idle, it also starts the queue.

### Status comment

Each pipeline has one status comment on the issue, edited in place at every stage transition: a table of stages with their state, run link and note, and the outcome at the end. Failures, refusals and queueing are separate comments, so they notify subscribers.

## Setup

### 1. GitHub App

Create a custom GitHub App owned by the repo owner (Settings → Developer settings → GitHub Apps). Turn off its webhook. Give it these **repository permissions**:

| Permission | Access | Why |
|---|---|---|
| Contents | Read & write | create, rename and push agent branches |
| Workflows | Read & write | push changes under `.github/workflows/` (the walking skeleton adds CI) |
| Pull requests | Read & write | open PRs |
| Issues | Read & write | labels, status and failure comments |
| Actions | Read & write | dispatch rework runs, download artifacts of earlier runs |
| Metadata | Read | required |

Install it on this repository only. Generate a private key.

The official Claude GitHub App is not needed: the factory's own App is the only bot identity (branches, commits, comments, labels, PRs).

### 2. Secrets and variables

| Kind | Name | Value |
|---|---|---|
| Variable | `FACTORY_APP_CLIENT_ID` | the App's Client ID |
| Secret | `FACTORY_APP_PRIVATE_KEY` | the App's private key (PEM) |
| Secret | `CLAUDE_CODE_OAUTH_TOKEN` | output of `claude setup-token`, run by the maintainer |

```sh
gh variable set FACTORY_APP_CLIENT_ID --body "<client id>"
gh secret set FACTORY_APP_PRIVATE_KEY < path/to/private-key.pem
gh secret set CLAUDE_CODE_OAUTH_TOKEN   # paste the token
```

The brake variables above are optional.

### 3. Labels

`ready-for-agent`, `ready-for-human`, `agent-running` and `no-tests-needed` must exist (see `triage-labels.md`).

### Auth caveats

- `CLAUDE_CODE_OAUTH_TOKEN` is the maintainer's **personal subscription** token. Anthropic's terms are ambiguous about unattended CI use of a personal subscription. Treat this as a PoC choice and revisit it (API key or workload identity federation) before relying on the factory.
- The token **expires one year** after `claude setup-token`. To rotate it, run `claude setup-token` again and `gh secret set CLAUDE_CODE_OAUTH_TOKEN`. When it expires, every agent stage fails and the issue lands in `ready-for-human` with the run link.
- App installation tokens last one hour and are minted per job, scoped to what that job needs. The review and pr agents get read-only tokens. To rotate the App key, generate a new private key, update `FACTORY_APP_PRIVATE_KEY`, then delete the old key.

### Security notes

- Agents run with `--permission-mode bypassPermissions` on ephemeral runners. What they can reach is limited by the token each job mints, not by tool prompts.
- The implement agent can push workflow files to its branch, and workflows on that branch run with the repo's secrets. This is accepted because only maintainers can apply `ready-for-agent`, and the ticket file only contains maintainer-written text. Review agent-authored workflow changes in the PR before merging.

## Operating it

**Start a ticket:** add `ready-for-agent` to the issue. Nothing else is needed. The next thing to look at is the PR, or a `ready-for-human` comment explaining why there is none.

**Watch it:** the status comment on the issue, or Actions → *factory*. Runs are named `factory #<issue> · <stage>`.

**Stop a run:** cancel the workflow run in Actions. `finish` still runs, records the cancellation, releases the claim and moves the issue to `ready-for-human`. To stop the factory entirely, disable the *factory* workflow (Actions → factory → ⋯ → Disable workflow).

**Resume a single stage** on the existing agent branch: Actions → *factory* → *Run workflow*, with:

- `issue`: the issue number;
- `stage`: `implement`, `verify`, `review` or `pr`;
- `from_run` (optional): the id of an earlier run whose artifacts to carry. For `implement`, it feeds that run's failed verify output or review findings to the agent. For `pr`, it is **required** and must be a run whose review approved the branch's current head (otherwise resume at `review`).

```sh
gh workflow run factory.yml -f issue=17 -f stage=verify
gh workflow run factory.yml -f issue=17 -f stage=implement -f from_run=123456789
```

A manual resume needs the factory to be idle, and gets fresh retry counters. `verify`, `review` and `pr` resumes still run verify first, so a PR is never opened while `pnpm verify` or the guards fail.

**Retry from scratch:** remove `ready-for-agent` and add it again (or dispatch with `stage=start`). The old branch is archived as `…-attempt-<k>`.

**Update a pinned skill:** copy the new upstream version over `.claude/skills/<name>/` in a PR, and update the pin below. The prompts override two behaviours of the upstream skills for unattended runs: `implement` must not call `code-review`, and `tdd` takes its seams from the ticket instead of asking the user. Check that both overrides still hold.

| Skill | Source | Pin |
|---|---|---|
| `implement`, `tdd`, `code-review`, `pr` | [`mattpocock/skills`](https://github.com/mattpocock/skills) `skills/engineering/` | plugin `mattpocock-skills` 1.3.2, commit `a496f5513d4a4cf889bc48e189e579f4b0bdf6aa` (copied verbatim) |

**Test the factory locally:** `node --test '.github/factory/test/*.test.mjs'`.
