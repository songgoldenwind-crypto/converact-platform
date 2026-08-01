# G02 full-suite raw evidence

- Exact source: `86bf9255f7be597677bc3fb086e824b50db782eb`
- Command: `npm test`
- Exit code: `0`
- Raw log bytes: `470915`
- Raw log lines: `5431`
- Raw log SHA-256: `fae845ed49536f7e2102d2307d8214376b3a1523e57a324ae6bdef5418efc8ec`
- Deterministic XZ stream SHA-256: `899ef7a7ea432a4f70e83318afdda6791ab85120003b09d4cd073d26c1e7afc6`
- Secret scan: passed before compression
- Result: 4,910 tests; 4,895 passed; 0 failed; 15 skipped

The four files are ordered base64 fragments of `xz -9` output. On GNU
systems, reconstruct and verify without writing an intermediate file:

```bash
awk '{printf "%s", $0}' full-suite.log.xz.b64.part-* |
  base64 --decode | xz --decompress | sha256sum
```

On macOS, use `base64 -D` and `shasum -a 256`. The expected decompressed
digest is the raw-log SHA-256 above. `part-manifest.sha256` independently
binds each retained fragment.
