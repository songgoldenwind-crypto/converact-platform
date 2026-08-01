# G02 full-suite raw evidence

- Exact source: `4f9ea6f94a8e0740975c801aff5a6a180124a62b`
- Command: `npm test`
- Exit code: `0`
- Raw log bytes: `470808`
- Raw log lines: `5432`
- Raw log SHA-256: `ffc569ed594e55af67c5a5e4e7b14d01fceedc9bc3e51f753ba9c442ece3100c`
- Deterministic XZ stream SHA-256: `3bf89d55eaec390fbbd21013b3680e89a42b5fd617989533076381982ca91a5d`
- Secret scan: passed before compression
- Result: 4,911 tests; 4,896 passed; 0 failed; 15 skipped

The four files are ordered base64 fragments of `xz -9` output. On GNU
systems, reconstruct and verify without writing an intermediate file:

```bash
awk '{printf "%s", $0}' full-suite.log.xz.b64.part-* |
  base64 --decode | xz --decompress | sha256sum
```

On macOS, use `base64 -D` and `shasum -a 256`. The expected decompressed
digest is the raw-log SHA-256 above. `part-manifest.sha256` independently
binds each retained fragment.
