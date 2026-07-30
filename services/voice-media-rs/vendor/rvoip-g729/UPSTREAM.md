# rvoip G.729 exact-source slice

This directory contains an exact, non-runtime-enabled extraction of the G.729
codec source selected by the Revision 4 contract.

- Repository: `https://github.com/eisenzopf/rvoip`
- Commit: `4ced02b7f6e73041c848f1765dc2bcf7588796f0`
- Tree: `74dabd314841d99e1a87dbdaca6050fc4e8ed923`
- Commit signature: `unsigned`
- Archive SHA-256:
  `16caf07273a1cd04fa126af242ad54892580818b5e7fa3c10d010e4917be437e`
- Archive size: `8594565` bytes
- Selected Rust files: `136`
- Selected-source SHA-256:
  `bbc645b365a3b0d86fd2c05881d7911d65b880b695b1483dba856903bae223ad`

`SOURCE_FILES.json` is the extraction-time copy of the canonical candidate
manifest. The upstream `mod.rs` and `impls/` files are byte-for-byte copies at
their planned target paths. `LICENSE`, `THIRD_PARTY_NOTICES.md`, and
`UPSTREAM_CARGO.toml` preserve the three pinned upstream support files;
`UPSTREAM_CARGO.toml` is provenance only and is not the crate manifest used by
this adapter.

Local files are limited to `Cargo.toml`, `Cargo.lock`, `src/`, this document,
and future rights-reviewed vector artifacts under `testdata/`. The local crate
compiles only the upstream fixed-buffer `impls/` surface and deliberately does
not expose the upstream allocation-returning facade.

The public adapter has one wire identity, `G729/8000`, and two internal modes,
`G729A` and `G729AB`. It is not connected to the production voice-media
runtime. Reference-vector, interoperability, quality, capacity, allocation,
legal-distribution, runtime-enablement, and production-eligibility gates
remain `not_run`.

The upstream MIT notice is preserved, but that notice alone is not a legal
conclusion about code derived or adapted from ITU reference material. Legal
review gates production distribution and enablement only; it does not prevent
local engineering, compilation, or testing.

Rust 1.94.1 Clippy reports `manual_contains` at the exact upstream file
`impls/codec/decode.rs:52`. The source is intentionally unchanged; local
Clippy verification allows only that pinned upstream lint. No allocation,
latency, or capacity conclusion is inferred from the lint waiver.
