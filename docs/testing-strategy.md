# Testing Strategy

How Trip Booking is tested. Every issue follows this document. Domain terms (Trip, Leg, Stay, Traveller…) are defined in [`CONTEXT.md`](../CONTEXT.md).

## 1. Test levels

| Level | Tool | What it covers | Where it lives |
|---|---|---|---|
| **Unit** | Vitest | Pure domain logic: validations, distance-based transport mode, Stay derivation, Trip state transitions, Search Link builders, coverage rules. | Next to the code: `apps/*/src/**/*.test.ts` |
| **API** | Playwright Test (`request` fixture), Service Objects, ajv for schema assertions | Fastify endpoints against a real PostgreSQL. | `e2e/tests/api/<area>.spec.ts` |
| **E2E (UI)** | Playwright Test, Page Object Model | Travel Manager flows in the browser. | `e2e/tests/ui/<area>.spec.ts` |

No component tests for now: UI components (e.g. City autocomplete) are covered by E2E.

## 2. Workflow per issue

### 2.1 Implementation PR — TDD outside-in (unit + API)

Tests are written **before** the code, in the same PR as the implementation:

1. **Outer loop — API test.** Write the API test(s) for the issue's acceptance criteria. They must fail (red).
2. **Inner loop — unit tests.** Red → green → refactor on the domain logic until the API test passes.
3. Issues with no endpoint (pure logic or UI-only logic) use the unit loop only.

**Evidence of test-first:** the PR history shows the test commit before the code commit:

```
test(#N): <what is specified>      ← red
feat(#N): <what is implemented>    ← green
refactor(#N): …                    ← optional
```

The implementer also creates `docs/test-cases/issue-N.md` (unit + API cases) and its rows in `docs/test-cases/traceability.md`.

### 2.2 E2E ticket — after the merge

E2E tests are written **once the implementation PR is merged**, against the real app:

1. A ticket `E2E: <issue title> (#N)` is created, linked to the original issue.
2. `ui-inspector` explores the merged app and produces `DOM.md`.
3. The E2E section is added to `docs/test-cases/issue-N.md`, plus its traceability rows.
4. `ui-test-writer-native` binds the cases to Playwright code (Page Objects + step functions).
5. PR from branch `e2e/issue-N` closes the E2E ticket.

Issue #1 (walking skeleton) has no separate E2E ticket: its health E2E test is part of its own acceptance criteria.

**Rule for implementers:** use semantic elements with accessible roles and names (buttons, links, labelled inputs, headings). E2E locators rely on them (`getByRole`, `getByLabel`); `data-testid` only as a last resort.

## 3. Case taxonomy (API and E2E)

| Tag | Meaning |
|---|---|
| `@nominal` | Expected behaviour: the main path, other valid variants **and negative cases** (invalid input, error flows, rejected operations). |
| `@edge` | Boundaries (BVA) and error guessing (accents, whitespace, same-day trips, end of month, DST change…). |
| `@smoke` | Separate, shallow checks: one per page ("loads and shows its main element") and per endpoint ("responds 2xx"). Run first in CI, fail fast. |
| `@issue-N` | Traceability to the GitHub issue. Every API/E2E test has one. |
| `@a11y` | Accessibility check of a page (see §8). |
| `@external` | Hits a real third-party site (see §6). Not part of the PR pipeline. |

**Unit tests have no tags.** They are traced by file and test name in `traceability.md`.

## 4. Test design techniques (ISTQB)

Minimum technique per kind of rule. Several usually apply to the same issue.

| Kind of rule | Technique | Example in this project |
|---|---|---|
| Field validation | Equivalence Partitioning + Boundary Value Analysis | Return date vs outbound date (same day, day before, day after) |
| Combined conditions | Decision table | Default transport mode: distance × both Cities in Spain |
| Lifecycle | State transition: every valid transition + at least one invalid one per state | Planning → Booked → Completed / Cancelled |
| User flow | Use case (main + alternative flows) | Create a Return Trip and see both Legs |
| Always | Error guessing | "Malaga" finds "Málaga"; trailing spaces; duplicate email with different case |

Distance and date thresholds (e.g. ~600 km, "soon" = 7 days) live in one place in the code and are tested at the boundary: value − 1, value, value + 1.

## 5. Coverage criteria — Definition of Done

An issue is fully tested when **all three** hold:

1. **Acceptance-criteria traceability:** 100 % of the issue's AC map to at least one test in `traceability.md`. Checked when the E2E ticket is closed (the implementation PR covers the unit/API part).
2. **Code coverage:** ≥ 90 % lines and branches on the domain module. No global threshold.
3. **Techniques:** the minimum techniques of §4 are applied for every kind of rule in the issue.

### Test-case documents

```
docs/test-cases/issue-N.md       ← cases per issue (sections: Unit, API, E2E)
docs/test-cases/traceability.md  ← AC → case → test file / test name
```

Cases are written in plain language as describe/it headings (format of the `ui-spec-to-cases` / `api-spec-to-cases` skills).

## 6. Search Links (Skyscanner, Booking.com, Trainline)

Two layers:

- **In CI (blocking):**
  - Unit test of each URL builder asserting the **exact** URL.
  - E2E: clicking the link opens a new tab whose URL is exactly the expected one. External domains are intercepted (`page.route`), so tests never reach the internet.
  - The Trainline location search (#11) is mocked.
- **`@external` suite (non-blocking, on demand or scheduled):** navigates to the real site and checks it responds without error and the final URL keeps origin, destination and dates (no redirect to the home page). A failure warns, it does not block merges. Manual verification noted in the PR, as the issues ask, still applies.

## 7. Test data, time and language

- **Database:** real PostgreSQL (docker compose). State is reset between tests (truncate). Data is created with factories/fixtures (`test-data-manager` skill).
- **City seed for tests:** small and deterministic, not the full OurAirports dataset:

  | City | Why it is in the set |
  |---|---|
  | Madrid, Valencia, Barcelona | Spanish Cities; train-distance pairs |
  | Málaga | Accent-insensitive search |
  | Lisboa | Europe but not Spain |
  | Londres, París, Milán | Multi-airport Cities |
  | Nueva York | Outside Europe (negative case for #16) |

  Extended per issue only when a case needs it.
- **Time:** the clock is frozen in tests (`vi.useFakeTimers` in unit, `page.clock` in E2E). Domain dates have no time part (`YYYY-MM-DD`). Explicit edge cases for DST change and end of month.
- **Bilingual UI:** locators are language-agnostic (roles). The suite runs in the default language, plus one `@smoke` per page in the other language. A unit test checks that ES and EN translation files have the same keys.

## 8. Accessibility

- Every page has an `@a11y` E2E test using `@axe-core/playwright`. It fails on WCAG 2.1 AA violations with impact **serious** or **critical**.
- Security testing is out of scope for the MVP (internal tool, no authentication). Malicious input (XSS, injection strings) is covered as error-guessing cases.

## 9. Folder layout

```
apps/web/src/**/*.test.ts         ← unit (Vitest)
apps/api/src/**/*.test.ts         ← unit (Vitest)
e2e/
  tests/ui/<area>.spec.ts         ← E2E (Page Objects)
  tests/api/<area>.spec.ts        ← API (Service Objects + ajv)
  tests/external/*.spec.ts        ← @external, outside the PR pipeline
  pages/  services/  steps/  fixtures/  data/
docs/test-cases/issue-N.md
docs/test-cases/traceability.md
```

## 10. CI pipeline

Every PR runs everything, in this order:

1. Lint
2. Unit + domain coverage threshold (≥ 90 %)
3. `@smoke` (API + E2E), fail fast
4. API suite
5. E2E suite + `@a11y`
6. Traceability check: every row in `traceability.md` points to a test that exists

`@external` runs outside the PR pipeline.

