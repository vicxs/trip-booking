## This is a retry after a failed verify

The previous attempt on this branch failed the verify stage. The failing checks and the tail of the command output are in `{{feedback_dir}}/feedback.md` (full log: `{{feedback_dir}}/verify.log`). The work so far is already committed on the branch.

Fix the cause of the failure. Do not weaken the gates to get past them: no skipped or focused tests, no lint or type suppressions, no loosened lint, type-check or test configuration.
