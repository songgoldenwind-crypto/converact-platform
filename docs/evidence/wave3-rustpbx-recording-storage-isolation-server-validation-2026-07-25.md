# Wave 3 RustPBX recording storage isolation server validation

> Date: 2026-07-25
> Result: controlled ENOSPC isolation and post-fault recording recovery passed

## Scope

This validation proves that exhausting the local RustPBX recording spool does
not interrupt an already established bidirectional PCMU/RTP call. It also
proves that the failed recording does not publish a completion marker and that
a later call can record successfully after storage capacity is restored.

The SUT, SIPp UAC/UAS, PostgreSQL and the owner fixture shared one 4-vCPU,
8-GB Linux host. This is a one-call fault-isolation gate, not a capacity,
production-availability, PSTN or physical mouth-to-ear result. The machine
evidence therefore declares `capacity_claim=none`.

## Runtime identity

| Item | Value |
| --- | --- |
| RustPBX source | `6c49ee76baa54fdbf8f98020cc9bee158c7c15de` |
| rsipstack source | `8318e97b1170de4e5245b120afec1cdf53e3d716` |
| rustrtc source | `166c6d22984429eb6b509920c14fcd69f974f0b3` |
| Patch set | `ivekit.21` |
| Local image | `ivekit/rustpbx:0.4.11-ivekit.21-6c49ee76` |
| Image ID | `sha256:b119f7a174cd3be9b34c1c516a097a421229c701dfa498460c513f439db57dba` |
| Image size | `71,065,985` bytes |
| Route snapshot patch | `affa18e5ed9b25ba102213cd7f015ef4c0f4a72b913dc48a87ca02e707a1a5b5` |
| SIPp | `3.7.7`, SHA-256 `8e8ecdbe923bf608c844038adfa35c8595400c4629d629f00d51539ac24cdfef` |

The image was produced with the pinned Rust `1.94.1` builder and
`cargo build --locked --release --features cross`. OCI labels match all three
source commits and `ivekit.21`. It remains a server-local candidate without an
immutable registry digest, SBOM, signature or provenance.

## Fault procedure

1. Start an isolated PostgreSQL, RustPBX, loopback owner sidecar and 16-MiB
   tmpfs recording spool without publishing host ports.
2. Bootstrap an inbound trunk and establish a 30-second bidirectional PCMU
   call between separate SIPp UAC and UAS containers.
3. Require at least five generated and received RTP packets in all four
   observations before injecting a fault.
4. Fill the shared recording spool until `ENOSPC`, require RustPBX's explicit
   recorder write-failure marker, and require all four RTP counters to keep
   increasing after that marker.
5. Let the call end, verify the failed recording has no completion marker,
   remove only the fault filler, and place a second 12-second call.
6. Require the recovery recording payload, segment manifest and completion
   marker, then verify RustPBX and all pre-existing baseline containers did not
   restart or suffer OOM.

## Result

| Gate | Result | Evidence |
| --- | --- | --- |
| Fault call | `passed` | Call duration `32,610 ms`; SIPp completed the established media session |
| Spool exhaustion | `passed` | Available bytes changed from `16,777,216` to `0`; two recorder write-failure markers observed |
| RTP before fault | `passed` | UAC generated/received `11/9`; UAS generated/received `10/11` |
| RTP during ENOSPC | `passed` | Counters advanced to `31/29` and `29/30` |
| RTP after recorder failure | `passed` | Counters advanced again to `49/46` and `48/48` |
| Failed recording semantics | `passed` | Terminal status `failed`, code `local_spool_enospc`, no completion marker |
| Recovery recording | `passed` | Terminal status `complete`, payload `528,324` bytes, 7 segments |
| RustPBX process | `passed` | Restart count `0`, OOM killed `false` |
| Isolation cleanup | `passed` | Acceptance containers, network and volume all absent after completion |
| Existing baselines | `passed` | Nine HOMER, LiveKit and RustPBX baseline containers running, restart `0`, OOM `false` |

## Defects closed during the gate

- The acceptance Compose still used a historical `nofile=65536`; the current
  image correctly refused to start below `262144`. The topology and regression
  contract now use the production minimum.
- The shared SIPp RTP plan rejected canonical E.164 values with a leading `+`.
  It now accepts one optional leading `+` while still rejecting URI injection.
- The owner fixture returned a provider SIP Call-ID as the internal interaction
  ID and used an invalid unencoded owner epoch. It now mirrors the platform's
  `vcall-*` identity and `cell_lease_epoch << 32 | local_epoch` contract.
- RustPBX route snapshot parsing rejected a legal display-name
  `To: name <sip:+number@host>` header. The `ivekit.21` fork extracts the URI
  inside angle brackets and its embedded Rust route test covers that form.
- Startup failures now persist bounded `0600` diagnostics after URL,
  authorization, token, password and secret redaction, before isolated
  resources are removed.

## Evidence

| File | SHA-256 |
| --- | --- |
| `wave3-rustpbx-recording-storage-isolation-server-validation-2026-07-25.json` | `9e2189ff2144cd2b0746519b9ffa75147037bfa40f983a91a81da1e2baed69cb` |

The original server result was also `0600` and 1,326 bytes. The repository copy
is intentionally non-secret and contains no endpoint, credential or
authorization material.

## Remaining boundaries

This gate does not cover concurrent recording saturation, slow or blocked
filesystem writes, inode exhaustion, read-only remounts, multi-hour storage
outage, spool watermark admission, uploader/object-storage failure under load,
SRTP, transcoding, IVR, conference mixing, PSTN, long soak, independent
generator/SUT, 1/2/4-node scaling, Cell-10K or MIX-100K. Those remain separate
capacity and production acceptance gates.
