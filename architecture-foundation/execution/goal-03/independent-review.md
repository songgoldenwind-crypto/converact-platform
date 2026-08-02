# G03 Independent Review

Review status: `remediation_complete_re_review_pending`
Production eligibility: `false`

The independent second review examined exact commit
`3559afca6ea322ad84a72d357edfc61356c5684b` read-only and reported
`Critical 0 / High 2 / Important 2 / Minor 0`, therefore **REJECT**:

1. a Promise-returning Call-registry handler continued after being classified
   forbidden;
2. fork winner selection did not cancel already-early siblings because attempt
   membership was learned only at final response;
3. legacy CallId attestation accepted a caller-supplied structural lookup;
4. the control contract listed field names/prose without closed concrete
   request/result/error/event payload schemas.

Runtime remediation for findings 1–3 is committed at `44a2a68`; the Call
registry no longer executes callbacks, legacy IDs require a module-issued
adapter bound to the exact `PostgresVoiceCallStore`, and fork branches are
registered before INVITE with bounded per-Leg CANCEL effects. Finding 4 is
remediated in the current review candidate with a compiled Draft 2020-12 closed
message schema covering concrete command requests/results/errors and every
event payload. These are locally verified implementation statements, not
reviewer acceptance.

Until a reviewer examines a new exact commit/diff and reports zero unresolved
Critical, High, Important and Minor findings, `G03-E15-REVIEW` remains
`not_run`.

External evidence that may remain `not_run` must be listed separately and may
not be converted into review acceptance or production eligibility.
