# G03 controlled-host evidence — ivekit.53

This bundle records a controlled, non-production G03 campaign against source
commit `b63383bda16bcd9d311c9ce5e0761877d474797b`, RustPBX patchset
`ivekit.53`, and image ID
`sha256:14e51e4f51388c8811e1472426a01840e061ad2ddf639caebe6b0eca4a206eaf`.
The source/image/patch identities and the two-vCPU host fingerprint are retained
under `build-evidence/` and `sip-latency-b63383b-v1/`.

The bundle supports only these controlled-evidence promotions:

- `G03-E06-TRYING`: 100 INVITEs produced exactly 100 initial `100 Trying`
  responses, with no Trying retransmission; measured Trying p50/p95/p99/max was
  0/1/1/1 ms.
- `G03-E07-WIRE`: all 22 frozen cases matched the versioned contract; 18 kept
  accepted semantics and four were explicit security tightenings, with no
  unexplained difference.
- `G03-E11-INTEROP`: ten SIPp scenarios covering 19 calls and one Asterisk 20
  real-peer call completed with no failed call or process restart.
- `G03-E12-LONG-CALL`: one direct-SIP control call ran for 7,201,279 ms. UAC and
  UAS each recorded one successful call, zero failed calls and zero
  retransmissions; router and CDR deltas were both one, process restart deltas
  were zero, and no SIPp container remained. The exact summary SHA-256 is
  `34b0095202f2cff3b7d2ea65e5241a492eefba6a06a6c4a8563b950f60925a90`.

Both long-call SIPp error files contain only the same reviewed process-exit
cleanup warning, `Failed to delete FD from epoll, errno = 1 (Operation not
permitted)`, timestamped after the two-hour scenario completed. The runner
exit code, JUnit/report call counters and retransmission counters all passed.
The raw warning is retained and is not represented as an empty log.

The 50/100/200/1,000-CPS two-vCPU direct-SIP steps passed as a partial
regression baseline. They do **not** promote `G03-E13-PERFORMANCE`: allocator
instrumentation, 2/4/8-core scaling, saturation, Kamailio, RTP/media, bridge,
VOS-equivalence and 100K acceptance were outside this campaign. The long call
also validates SIP control stability only; it is not a two-hour decoded-media,
RTPengine, recording or audio-quality result.

After evidence capture, `harness/isolated-stack.sh` removed only the four exact
campaign container names. `host-evidence/preexisting-containers-before.txt`
and `preexisting-containers-after.txt` are byte-identical, no drift file exists,
and `network-after.json` has zero endpoints. The retained harness hashes are:

- `long-call.sh`: `e89b5fc0ac2d33d5fc46c465aa9a744dd79b33067e4d5e60cd9e1bcca728eeb7`
- `isolated-stack.sh`: `e6ef6d55b1f9c93e16c71d78e936b1ff63d64611d1be7c963b586d59be750e51`

All result-local SHA-256 manifests pass. The generated-runtime-secret scan and
a separate local secret-shape scan passed. `production_eligible` remains
`false`; fault/OOM, complete performance, final independent review and live
durable Native Authority activation remain `not_run`.
