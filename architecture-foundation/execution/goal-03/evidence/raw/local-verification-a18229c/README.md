# G03 local verification evidence

- Exact source commit: `a18229cde752e2fbd4a3ffa3b8d8a8cc7cef7beb`
- Production eligibility: `false`
- G03 contract command: `node --test architecture-foundation/execution/goal-03/goal-03-contract.test.mjs`
- Contract result: 9 passed, 0 failed; raw SHA-256 `ab36ff826e117234cf8a46ed3bc4cc304ca10709ef1f45b18f6901c2de50baee`
- Focused command: the serial Call/Leg, SipFoundation, Effect/PostgreSQL, recovery/drain, rsipstack/RustPBX patch and restart-probe suite frozen in the execution report
- Focused result: 118 passed, 0 failed, 1 physical-only skip; raw SHA-256 `9d212173335acf075dd07ab0ef198b8e76b1fd97dacc820f8b5c6f5c071025b9`
- Typecheck command: `npm run typecheck`
- Typecheck result: passed; raw SHA-256 `40bc31d5c95fb879712acd5d1ffc8bcac91b04826d82c408f5246ca6e9bdcea9`
- Full-suite command: `npm test`
- Full-suite result: 4,950 tests; 4,935 passed; 0 failed; 15 skipped
- Full-suite raw log: 474,446 bytes, 5,471 lines; SHA-256 `40aa77621bd95b6528dcbe4e9770238a589ea4098a9cb57ffe790fcf3f5a6892`
- Deterministic XZ SHA-256: `f83e34860097eb79ef4f0178843de16ee86f447950a564b2088ca1af8ffff691`

The three `full-suite.log.xz.b64.part-*` files are ordered base64 fragments.
On macOS, reconstruct and verify with:

```bash
awk '{printf "%s", $0}' full-suite.log.xz.b64.part-* |
  base64 -D | xz --decompress | shasum -a 256
```

The expected decompressed digest is the full-suite raw-log SHA above. These
results prove local source behavior only; they do not prove real SIP peers,
host capacity, long calls or production eligibility.
