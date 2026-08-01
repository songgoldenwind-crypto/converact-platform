# G02 full-suite raw evidence

- Exact source: `3108ecf03d850a2c97f88e1507982305b0b522fa`
- Command: `npm test`
- Exit code: `0`
- Raw log bytes: `470887`
- Raw log lines: `5430`
- Raw log SHA-256: `6f21a4ca94fc0e255810498559a1590fa87bc21c8982181b3f3ba0a16fe9c456`
- Deterministic XZ stream SHA-256: `1bfcb56ae58ba7f931a421d50fffde128443ade5e5e864b4ee6b788d15ffde7b`
- Secret scan: passed before compression
- Result: 4,909 tests; 4,894 passed; 0 failed; 15 skipped

The four files are ordered base64 fragments of `xz -9` output. On GNU
systems, reconstruct and verify without writing an intermediate file:

```bash
awk '{printf "%s", $0}' full-suite.log.xz.b64.part-* |
  base64 --decode | xz --decompress | sha256sum
```

On macOS, use `base64 -D` and `shasum -a 256`. The expected decompressed
digest is the raw-log SHA-256 above. `part-manifest.sha256` independently
binds each retained fragment.
