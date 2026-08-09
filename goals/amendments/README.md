# Binding Goal amendments

Amendments are additive, exact-input overlays used when a frozen Goal or manifest cannot be rewritten
without invalidating an already authorized execution chain.

| Amendment | Applies to | Status |
| --- | --- | --- |
| [G02/G03 Gate split V1](./2026-08-02-g02-g03-gate-split-v1.md) | G03 entry only | active for the current G03 execution |
| [AI Interaction/Speech/Action program amendment V1](./2026-08-09-ai-speech-action-program-amendment-v1.md) | G10、G12、G13、G14、G15、G16 | binding when a listed future Goal starts |

An amendment may add requirements but must not silently weaken Authority, dependencies, Evidence,
production eligibility or an existing acceptance Gate. Each amendment binds exact base files and has
a schema, resolver/test or an equally strict validation mechanism.

The V1 AI Speech/Action schema is deliberately version-specific and exact: scope, target order,
clauses, addenda, invariants and artifact identities are frozen. Any semantic change requires a new
amendment version instead of mutating V1 in place; the resolver additionally pins the exact amendment
and manifest bytes, requires the exact target Goal bytes, and provides an objective builder containing
both base and amendment path/SHA-256 identities.

Before starting a Goal, inspect this directory for an amendment that names the target Goal. If one
exists, include both the base Goal and the amendment identity in `create_goal`.
