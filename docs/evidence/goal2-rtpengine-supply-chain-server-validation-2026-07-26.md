# Goal 2 RTPengine Supply-Chain Server Validation

## Result

- Date: 2026-07-26
- Server: `64.225.122.227`
- Scope: RTPengine userspace runtime image used by Goal 2
- Result: `passed`
- Capacity claim: `none`
- Evidence generator source: `a23ae1c`
- Runtime image source: `4b67a26f42a8753eaa215567eb3e4ab8b8c16bd5`

The gate passed because both package-aware SBOM formats were present, both
Trivy reports were bound to an immutable scanner image, every Critical finding
had an unexpired recorded exception, no secret was found, and the provenance
bound the exact runtime image to its source and build inputs. This is a
supply-chain result, not a capacity result.

## Immutable Identities

| Item | Identity |
| --- | --- |
| RTPengine image | `sha256:6690e23db010b23ae9da680c842e7ece1a0a0723562d771ffe37af76b090f4a7` |
| RTPengine upstream commit | `506cfa74386a5373e40fca139a932917f22f0524` |
| Upstream archive | `a6d23de8f656c3ad54e4060813c230861d100b79fb45ba1ce728ad2cef780143` |
| iveKit patch set | `51f842076f044d5d914ef8f89ad0a72a9ab1e6a2d26ee5899a5e457d09efd0f3` |
| Toolchain and builder image | `sha256:1b858f21573a2a5322825ee566a204ed34d093b447392d910d4b99e5771c9752` |
| Trivy 0.72.0 image | `sha256:cffe3f5161a47a6823fbd23d985795b3ed72a4c806da4c4df16266c02accdd6f` |
| Runtime architecture | `amd64` |
| Runtime package inventory | `dpkg-status-v1` |

The vulnerability and secret reports use the same pinned Trivy image. The
Trivy vulnerability database timestamp is
`2026-07-26T01:15:28.600Z`.

## Package Coverage

- CycloneDX 1.7 components: 285
- SPDX 2.3 packages: 286
- Debian packages discovered by Trivy: 284
- Package-manager executables in the runtime image: none
- Read-only package metadata retained for scanners:
  `/var/lib/dpkg/status`

The first scan of the old scratch-style image found zero packages. That result
was rejected as package-blind and was not recorded as a pass. The runtime
contract was then changed to retain read-only dpkg status while still removing
`apt`, `dpkg`, package caches, and package-manager state not required by
scanners.

For this isolated server validation, the acceptance image was derived from the
previous immutable runtime image by synthesizing dpkg status from its retained
runtime package manifest. It is therefore evidence for scanner coverage and
runtime behavior, not evidence of a fresh end-to-end toolchain rebuild. Normal
future builds use the committed `Dockerfile.toolchain` path, which preserves
the real dpkg status directly.

## Vulnerability And Secret Policy

- Vulnerabilities reported: 24
- Critical vulnerabilities: 1
- Critical vulnerabilities with valid exceptions: 1
- Secret findings: 0

The Critical finding is `CVE-2026-6653` in `libxml2`. RTPengine reaches
`libxml2` transitively through `libavformat`, Debian did not provide a fixed
package in the scanned database, and deleting the library would break the
media runtime. The exception expires at `2026-08-09T00:00:00.000Z` and must
be removed or renewed from new evidence before that time. Unexcepted or
expired Critical findings fail the gate.

## Signing Status

Image signing is `not_run`. The isolated server validation had neither a
production registry digest nor a configured keyless signing identity. The
evidence generator does not convert an absent signature into a pass. A future
release registry run must provide a signature reference and optional bundle
before signing can be promoted to `passed`.

## Runtime Regression

The package-inventory image reran the full real-media acceptance suite:

- 20/20 checks passed.
- Plain RTP/RTCP and SDES-SRTP relay checks passed.
- SRTP wire plaintext detection found no matches.
- Established media survived the isolated control-plane outage.
- WAL restart recovery and idempotent delete passed.
- Drain, hard-capacity rejection, owner epoch, and failure classification
  checks passed.

Kernel forwarding, recording, transcoding, and physical capacity remain
explicit `not_run` items. No benchmark or concurrency claim is made here.

## Evidence Files

| File | SHA-256 |
| --- | --- |
| `goal2-rtpengine-sbom-cyclonedx-2026-07-26.json` | `a262932fa3dbc3dee3ed10f8a4754da60653458df533b01b3a7f2b6b68a6c65e` |
| `goal2-rtpengine-sbom-spdx-2026-07-26.json` | `958607ab60d4ba16afbea418cc17bc9d3976049b14f4f1e6a8b25dde738d6244` |
| `goal2-rtpengine-trivy-vulnerabilities-2026-07-26.json` | `f308c2e33e48dde6ca94134bac358cc6db88a97a34f50ebd6d87db67f444c2b6` |
| `goal2-rtpengine-trivy-secrets-2026-07-26.json` | `219ca16513221a35f21db520142d5a3bb572bd1a6d9f09f04fee82c789d3941c` |
| `goal2-rtpengine-supply-chain-2026-07-26.json` | `9da44ce3c22fc65c586cf98d32aac8956aab8e554b02213a9ac0a36d7366dc85` |
| `goal2-rtpengine-provenance-2026-07-26.json` | `9271730250d36ebb69aa39aa4ec7fc796e3df88d7a1cdd523b0d05cac9cf19df` |
| `goal2-rtpengine-package-inventory-media-regression-2026-07-26.json` | `7e6589a9f23b908983410977179c035ce1f30b3791efb33fff19063a6a7461cf` |

The original server-side evidence files were created exclusively with mode
`0600`. Repository copies are immutable audit artifacts and are verified by
the hashes above.
