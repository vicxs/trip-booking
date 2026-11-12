# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker | Meaning                                  |
| -------------------------- | -------------------- | ---------------------------------------- |
| `needs-triage`             | `needs-triage`       | Maintainer needs to evaluate this issue  |
| `needs-info`               | `needs-info`         | Waiting on reporter for more information |
| `ready-for-agent`          | `ready-for-agent`    | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`    | Requires human implementation            |
| `wontfix`                  | `wontfix`            | Will not be actioned                     |

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

Edit the right-hand column to match whatever vocabulary you actually use.

## Factory labels

Two more labels sit alongside the triage roles. They are not triage states.

| Label | Set by | Meaning |
| ----- | ------ | ------- |
| `no-tests-needed` | the maintainer, during triage | The ticket legitimately changes no tests (docs, config). It lifts the software factory's "the diff touches tests" guard. Apply it only when the ticket truly has no behaviour to test. |
| `agent-running` | the software factory only | The factory has claimed this issue and a pipeline is in progress. It is removed whenever the pipeline ends, whatever the outcome. Don't add or remove it by hand; to stop a run, cancel it in Actions (see `factory.md`). |

Applying `ready-for-agent` starts the software factory (see `factory.md`).
