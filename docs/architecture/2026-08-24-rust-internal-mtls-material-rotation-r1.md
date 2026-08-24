# Rust Internal mTLS Material Loading and Rotation R1

| Field | Value |
| --- | --- |
| Scope | RM01 R1/R3 offline secret loading, publication and readiness |
| Current state | TypeScript route remains online; Rust listener uses injected immutable DER |
| Target state | Bounded PEM bundle loading and atomic last-known-good Rust config publication |
| Production eligible | No |
| Runtime rollout | Forbidden in this slice |

## 1. Decision

Add a filesystem-authorized `converact-internal-mtls-runtime` crate around the
existing transport crate. The transport crate continues to own TLS,
certificate verification and connection identity. The runtime crate alone may
open secret files, resolve one projected bundle generation, parse bounded PEM,
publish a completely validated replacement and derive readiness.

Do not load four independent user-visible Kubernetes Secret symlinks. A
Kubernetes projected volume exposes files through `..data`, and Kubernetes
atomically renames that symlink to a timestamped generation. The loader reads
`..data` once, validates its single-component relative target, opens that
generation directory, and opens all fixed bundle files relative to the same
directory descriptor. A concurrent projection can therefore produce either
one complete old generation, one complete new generation, or a retryable load
failure; it cannot produce a mixed certificate/key/root/CRL bundle.

This follows the Kubernetes AtomicWriter layout and its atomic `..data`
replacement rather than rejecting all symlinks. Kubernetes documents Secret
volume propagation as eventually consistent and explicitly warns that
`subPath` mounts do not receive updates, so Converact deployment contracts
must mount the complete Secret volume, never individual `subPath` files:

- <https://github.com/kubernetes/kubernetes/blob/master/pkg/volume/util/atomic_writer.go>
- <https://kubernetes.io/docs/concepts/configuration/secret/>

No file watcher, config publisher or readiness state may route a command,
authorize a tenant, publish a business event or write a database.

## 2. Bundle contract

The loader consumes exactly these fixed files from one immutable generation
directory; unrelated entries are neither scanned nor granted authority:

| File | Content | Required |
| --- | --- | --- |
| `tls.crt` | PEM server leaf followed by intermediates | yes |
| `tls.key` | exactly one PKCS#8, PKCS#1 or SEC1 PEM private key | yes |
| `client-ca.crt` | one or more PEM client trust roots | yes |
| `client-ca.crl` | one or more PEM X.509 CRLs | yes in R1 |

R1 deliberately requires a current CRL. A future short-lived-SPIFFE mode may
replace CRLs only after it freezes maximum workload-certificate lifetime,
issuer behavior and direct expiry evidence. An absent CRL must not silently
select that future mode.

PEM is decoded from already bounded byte slices using the existing
`rustls-pki-types` `PemObject` implementation reached through rustls. Do not
add the archived `rustls-pemfile` crate. Every PEM section is enumerated and an
unexpected section type, zero items, extra private key or trailing invalid PEM
fails closed.

The decoded DER is passed to `InternalMtlsServerConfig`; raw bytes and PEM
parser types never reach an HTTP handler. The file buffer containing the
private key is overwritten on drop. Public Debug, Display, readiness and
metrics contain stable categories only.

## 3. Filesystem boundary

Two explicit source layouts exist:

1. `KubernetesAtomicWriter`: an absolute mount root containing the `..data`
   symlink and timestamped generation directories;
2. `ImmutableDirectory`: an absolute, already immutable generation directory,
   intended for offline tests and non-Kubernetes secret injectors. It has no
   automatic rotation claim.

For `KubernetesAtomicWriter`, the loader:

1. opens the mount root as a directory;
2. uses descriptor-relative `readlinkat` for `..data`;
3. accepts one non-empty relative filename component only, never `/`, `.`,
   `..`, `..data` or an absolute target;
4. opens that generation using `openat` with directory, close-on-exec and
   no-follow flags;
5. opens each fixed filename from the generation descriptor with read-only,
   close-on-exec and no-follow flags;
6. validates descriptor metadata before allocating by reported size;
7. reads at most the fixed file budget plus one byte and fails on overflow.

If Kubernetes removes the old generation between steps 2 and 4, loading fails
without replacing last-known-good state and the next bounded poll retries the
new generation. Once the generation descriptor is open, later `..data` swaps
cannot mix files into that read.

Directories must be regular directories and not group/other writable. Every
entry must be a regular file and not group/other writable or executable. The
private key additionally requires owner read, no other permissions, and either
owner-only access or group read by one explicitly configured service GID.
Root-owned, exact service-group-readable Kubernetes files are supported;
world-readable private keys are rejected.

Non-Unix targets fail closed as unsupported in R1. Linux physical validation
and other target support remain separate gates.

## 4. Resource bounds

| Resource | R1 bound |
| --- | --- |
| mount-root path | absolute, maximum 4,096 bytes |
| generation target | one component, maximum 255 bytes |
| `tls.crt` PEM | maximum 512 KiB |
| `tls.key` PEM | maximum 128 KiB |
| `client-ca.crt` PEM | maximum 512 KiB |
| `client-ca.crl` PEM | maximum 2 MiB |
| total loaded PEM | maximum 3,200 KiB |
| server certificates | existing maximum 8 / 256 KiB DER total |
| client roots | existing maximum 8 / 256 KiB DER total |
| CRLs | existing maximum 8 / 1 MiB DER total |
| reload interval | `1 s..=5 min`, default `10 s` |
| certificate/CRL safety margin | `1 min..=24 h`, default `15 min` |
| observation freshness | exactly `3 * reload interval`, maximum `15 min` |
| blocking loads | exactly one at a time per config slot |
| scheduler tasks | exactly one per config slot |

The scheduler uses one bounded `HealthTaskGroup` child and at most one Tokio
blocking-pool job for one local bounded load. It never overlaps loads, queues
missed ticks, retries inside a tick or scans a directory. It opens only the
four exact names. The blocking job never owns a config publisher: only the
awaiting scheduler may publish its returned candidate. Cancellation drops that
result path, so a late filesystem completion cannot change process state. A
filesystem operation that does not return is still a target-host Gate; R1 does
not claim kernel-level cancellation of regular-file I/O.

## 5. Material validation

Before publication, a candidate must pass all existing material limits plus:

- exactly one server private key and matching server leaf;
- server leaf validity contains injected wall time and exceeds the configured
  readiness safety margin;
- server leaf has server-auth purpose and exactly the configured DNS identity;
- every supplied CRL parses, has `nextUpdate`, is current, and exceeds the same
  safety margin;
- the CRL-backed webpki client verifier builds successfully;
- TLS 1.2/1.3, mandatory client authentication, fixed ALPN and disabled
  resumption remain unchanged.

rustls warns that server configs with different client verifiers or identities
must not share resumption state. R1 keeps session storage and TLS 1.3 tickets
disabled across every generation:
<https://docs.rs/rustls/0.23.43/rustls/server/struct.ServerConfig.html>.

The wall clock is injected into validation. Monotonic time controls polling,
load deadlines and freshness of the last observation. Clock regression never
extends certificate or CRL validity.

## 6. Atomic publication and listener consumption

`InternalMtlsConfigSlot` owns one Tokio watch value containing an immutable
`Arc<InternalMtlsServerConfig>` and non-sensitive revision metadata. A
candidate is fully read, decoded and validated before `send_replace`.

The listener clones one complete published generation immediately after TCP
accept and before any await in the TLS handshake. The watch borrow is dropped
before awaiting, as Tokio warns that long-lived watch borrows hold a read lock:
<https://docs.rs/tokio/1.53.1/tokio/sync/watch/index.html>.

- handshakes already started retain the old generation;
- later accepted sockets use the new generation;
- established HTTP connections are unaffected and remain under the existing
  drain lifecycle;
- same-fingerprint reload is an idempotent no-op;
- a changed valid bundle increments one process-local checked revision;
- revision exhaustion fails closed;
- failed load/validation retains the exact last-known-good generation.

This is configuration replacement, not durable business dual-write. Rollback
is an operator projection of previous material as another changed bundle; it
receives a later process-local revision.

## 7. Readiness and failure behavior

The runtime adapter exposes a closed snapshot:

- `not_loaded` — no valid config has ever been published;
- `ready` — current config and required CRLs exceed the safety margin;
- `degraded` — a reload failed but last-known-good material still exceeds the
  safety margin;
- `not_ready` — no config, expired/not-yet-valid material, expiry inside the
  margin, scheduler staleness or revision exhaustion.

A failed rotation does not immediately abort established connections or erase
last-known-good material. When sufficient validity remains, it is degraded and
observable. Once the safety margin is reached, admission readiness fails
closed for new deployment routing. Established Human Communication is still
drained by its owning process and is not terminated by this status.

Errors reveal only categories such as `internal_mtls_bundle_path_invalid`,
`internal_mtls_bundle_permissions_invalid`, `internal_mtls_bundle_too_large`,
`internal_mtls_bundle_pem_invalid`, `internal_mtls_bundle_time_invalid` and
`internal_mtls_bundle_reload_failed`.

## 8. Test and rollout gates

Offline tests must cover immutable directories and a synthetic AtomicWriter
layout, symlink swap before/during load, old-generation removal, path escape,
file symlink, FIFO/non-file, permissions, ownership policy, every byte/count
bound, mixed PEM types, multiple keys, expired/not-yet-valid server identity,
wrong DNS/purpose, absent/stale CRL, same-bundle idempotency, successful
replacement, failed replacement retention, concurrent handshake generation
isolation, scheduler cancellation and readiness margin transitions.

The next implementation remains offline. Online route wiring, mounted real
Secrets, Kubernetes propagation timing, inotify/fanotify, Linux process tests,
filesystem-stall/process-exit behavior, fleet rotation, rollout, drain,
active-zero, performance and production
eligibility remain `not_run`.
