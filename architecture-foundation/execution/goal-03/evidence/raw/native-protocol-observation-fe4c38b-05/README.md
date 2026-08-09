# G03 native protocol observation — controlled server evidence

## Scope and identity

- Status: `verified_controlled`
- Production eligible: `false`
- Captured: `2026-08-09T18:31:07Z`
- Validation host: `ubuntu@101.42.7.139`
- Canonical parent commit: `2001b8e872a48648d01ba2df9f4d642479ae2755`
- Pre-commit verification snapshot: `76ce32922ad61784efebeb29bad827ab27e937d0`
- Pre-commit verification tree: `fe4c38b5aac92524c68711be73d6a7299969cd6d`
- Target patchset: `ivekit.59`
- Full patch-set SHA-256: `04f0ed06adc740b8a65a19970ba71a8c4fa042832a327e9d0b288cbfb0b4272d`

The pre-commit snapshot exists only to bind the exact dirty candidate copied to
the isolated validation directory. It is not a canonical release commit, an
image identity, or permission to push. The successful tests used the pinned
upstream RustPBX, rsipstack and rustrtc commits and the exact source hashes in
`host-manifest.txt`.

## Proved boundary

The complete RustPBX library suite ran on the authorized Linux validation host
under the pinned Rust 1.94.1 image and completed with:

```text
1998 passed; 0 failed; 7 ignored
```

Five separately selected physical PostgreSQL tests passed in one run:

1. pool recreation and replay;
2. atomic prepare plus `TransportCompleted` replay and reconnect;
3. atomic receipt transition and recovery;
4. fenced `Unknown` claim and reconcile after pool recovery;
5. bounded repair exhaustion after eight attempts.

A sixth physical PostgreSQL test separately passed with caller clocks skewed by
plus and minus 365 days, proving that the tested prepare and terminal receipt
ordering uses database time. These six tests used the isolated current G03
PostgreSQL container. One ignored RustPBX test requires the complete PBX
infrastructure and remains `not_run`; the other six ignored tests are the six
physical cases proved here.

Before transfer to the server, a fresh reconstruction from the three pinned
upstream commits accepted every patch in build order. The resulting `.59`
rsipstack and RustPBX files were byte-identical to the exact-source trees used
by the focused tests. Local exact-source results were rsipstack `300/300` and
RustPBX `1998 passed; 7 ignored`; the full server RustPBX result independently
repeated the latter count. This is component conformance evidence, not a
capacity result.

The full RustPBX library suite includes the current G.729 component regression.
That proves only compilation and component behavior in this source tree. It
does not replace the later exact-source G.729 interoperability, quality,
licensing/distribution, long-call, or production-activation gates.

## Attempt history

Every retained setup failure is disclosed:

1. `server-rustpbx-lib-r7.log` stopped before source execution because `cargo`
   was not on the temporary container command path.
2. `server-rustpbx-lib-r8.log` stopped during crates.io index access before
   compilation. The next harness used the server's retained Cargo cache and an
   isolated temporary rsproxy source configuration.
3. Two subsequent offline preflight attempts stopped before source execution
   because the cache did not yet contain the mapped `anyhow` source. They did
   not produce retained source-test logs and are not counted as test failures.
4. `server-rustpbx-lib-r11.log` is the first complete server library run and
   passed all non-ignored tests.

No production assertion relies on the setup attempts. Their disclosure keeps
the successful result auditable without misclassifying harness configuration
as a code regression.

## Server isolation

Read-only checks after the test found only
`converact-g03-current-pg-7f4cd00c` running. It was healthy. nginx was inactive,
all retained PM2 application definitions were stopped, and all pre-existing
OPC, RustPBX, LiveKit and unrelated application containers remained exited.
The idle PM2 control daemons were not killed because doing so was unnecessary
to stop the applications and would alter retained server control state.

The old containers, service definitions and data were not deleted or modified.
Current G03 work used isolated names. Finished temporary Rust test containers
were removed after their logs were copied; the isolated source and Cargo target
cache were retained to avoid repeating a large build on the nearly full host.

## Explicit non-claims

This bundle does **not** prove or activate:

- an exact `.59` release image or canonical release commit;
- live RustPBX endpoint composition or a real SIP peer;
- automatic derived ACK intent, automatic 200-to-CANCEL, or UAS-Core 2xx ACK
  ownership;
- stale `send_attempted` or `transport_accepted` recovery after observer-process
  crash;
- mixed-binary rolling activation, drain, or fleet active-zero;
- long-call, fault/OOM, allocator, 2/4/8-core scaling, capacity, or 100K
  acceptance;
- media, RTPengine, recording, AI, G.729 production eligibility, or fleet
  observability.

Those items remain `not_run`. `G03-E16-NATIVE-AUTHORITY` is not promoted and
production eligibility remains false. `remote-artifacts.sha256` binds the five
retained raw logs plus the two text manifests; it deliberately excludes this
annotation and itself.
