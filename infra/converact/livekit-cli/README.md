# LiveKit CLI capacity tool

iveKit pins the official LiveKit CLI as a capacity load generator. It is not
part of the runtime service graph and is not bundled into the iveKit API image.

## Scope

- `lk load-test` supplies efficient pre-encoded audio/video publishers and
  subscribers for SFU throughput, track fan-out and packet-loss campaigns.
- `scripts/ivekit-linux-process-observer.ts` records generator-process, SUT
  process, host CPU, network and drop evidence.
- Browser and native endpoint tests remain authoritative for join, first media,
  glass-to-glass latency, A/V synchronization, freezes, reconnect and playout.
- A capacity run is invalid when the generator exceeds 60% CPU, the generator
  host exceeds 85% CPU, the declared NIC exceeds 70%, or host drops increase.
- Generator and SUT should run on separate hosts for production capacity
  qualification. Same-host runs are controlled development evidence only.

## Fetch

```bash
infra/converact/livekit-cli/fetch.sh /opt/ivekit/tools/livekit-cli/2.18.1
```

The script downloads one pinned Linux amd64 release asset and verifies its
SHA-256 before extraction. It does not modify system paths.

## Host preparation

Follow the official LiveKit benchmark requirements on both the SUT and load
generator. At minimum, use a per-process file descriptor limit of 65535 and
record the effective socket buffer settings with every campaign.
