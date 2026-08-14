# RM01 R1 — tenant access policy replay evidence

Status: `implemented_offline`, not production eligible.

This narrow vertical slice freezes and replays the current TypeScript
`evaluatePlatformAccess` policy in the Rust `converact-tenant-auth` crate. It
decides tenant, audience, capability, purpose, wall-clock validity, policy/
revocation epoch and strong non-human identity requirements. It does not route
authentication traffic or change a running server.

## Boundary and compatibility

- The frozen corpus contains 26 allow/deny cases, nine canonical timestamp
  cases and ten raw safe-integer number forms. The active TypeScript source
  and Rust crate both replay the same checked-in bytes.
- Bounded text is stored as UTF-16 units, uses JavaScript length and trim
  characters, and preserves the current lone-surrogate behavior. String sets
  are non-empty, duplicate-free and limited to 64 items.
- Canonical wall timestamps match JavaScript `Date.parse` plus
  `toISOString()` equality, including signed extended years and the
  ECMAScript time-clip limits.
- Policy/revocation numbers retain the current JavaScript `Number.isSafeInteger`
  semantics, including integral decimal/exponent forms, negative zero and the
  decimal-rounding boundary immediately below `2^53`.
- Non-human identities fail closed unless the already-verified credential
  strength is `mtls`.
- The Rust evaluator deliberately runs after signature, issuer and signing-key
  verification. It does not claim that a string field proves an issuer or an
  mTLS peer.
- Parsed JSON projections are capped at 512 KiB before parsing and expose
  validation only; validation also applies every bounded claim value rule.
  Verified claims are opaque, have no public constructor, and `AccessRequest`
  cannot be constructed by an external caller before the in-crate credential
  verifier exists.
- Extra fields in this internal projection remain ignored because the current
  TypeScript evaluator ignores them. The future JWT wire boundary remains a
  separate closed, versioned contract and is still `not_run`.

The target `tenant-auth` foundation is larger than this checkpoint. HS256 and
RS256/JWKS verification, issuer/key binding, JWKS lifecycle, local token
issuance, HTTP extraction/error compatibility, certificate-to-workload peer
mapping, tenant membership/RBAC and physical PostgreSQL RLS remain `not_run`.
Those boundaries will be migrated separately before any writer or request
route moves.

## Direct verification

The TDD RED run failed because the Rust access request, claims, evaluator and
canonical timestamp parser did not exist. Review-driven RED tests then exposed
unbounded projection parsing and Serde/JavaScript numeric differences at
integral float, exponent, negative-zero and `2^53` boundaries. The current
implementation passes all 26 policy, nine timestamp and ten raw-number vectors
plus explicit UTF-16, trim, set, projection-size and clock-bound tests. Focused
Rust tests and Clippy with warnings denied passed; the active TypeScript source
replay and affected TypeScript suite/typecheck passed. The full Rust workspace
passed 71 tests with six physical PostgreSQL tests intentionally ignored in the
ordinary run.

Five read-only review rounds closed every reported compatibility, authorization
boundary, bounded-work and evidence issue. The final exact-diff review reported
`0 Critical / 0 Important` and independently reran the focused Rust tests and
Clippy.

No Docker, running server, network dependency, load test or performance
campaign was used. Production routing, shadow traffic, mTLS proof, fleet fault
validation, performance and production eligibility remain `not_run`.
