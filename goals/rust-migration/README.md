# Converact Rust Runtime Migration Goals

This is an additive Goal program for the user-authorized server-runtime
migration. It does not mutate the frozen 18-Goal manifest in `goals/` and does
not change existing G00-G17 hashes, dependencies or evidence.

Start RM01 only by:

1. reading `goals/PROGRAM-RULES.md` and this directory's `PROGRAM-RULES.md`;
2. validating `manifest.json` and exact file hashes;
3. running `node --test goals/rust-migration/rm01-contract.test.mjs`;
4. passing the complete `create_goal summary` from the Goal file together with
   the absolute file path and manifest SHA-256 to `create_goal`;
5. executing RM01 to a valid terminal status without starting G04.

The existing 18-Goal program remains the product and communication feature
program. RM01 changes implementation language and deployment/fault boundaries,
not business scope or Authority.
