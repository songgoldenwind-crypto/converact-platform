# G03 controlled PostgreSQL restart evidence

## Identity

- Campaign: `converact-g03-pg-restart-a18229cd-02`
- Exact source: `a18229cde752e2fbd4a3ffa3b8d8a8cc7cef7beb`
- Source archive SHA-256: `88d23273225b472ec3fc7775af43ea301c5c82c6b350122a3173d39da2e1511c`
- Source tree manifest SHA-256: `e29e5898768938779ff723c4acc0d68e1463510f301ea808f56054bde76c17e5`
- Executed probe SHA-256: `5300dc08d72403c534f0a032f2c943f125966bcb9cd6a402e9278bf7ddcf1137`
- Campaign harness SHA-256: `bb5a8a2fac28aae0976b04e5468e38a7ffb114cf892721b3dfebfe8325ba4d1f`
- Remote raw archive SHA-256: `edbf38b27dd795e5d86c9cddc4b750119d8f07037e3b7ab706a97fe6efff3c09`
- Host identity: `VM-0-3-ubuntu`, Linux 6.8.0-71 x86_64, 2 CPUs, 7,870,468 KiB memory
- PostgreSQL: pinned image in `execution-identity.json`, server 16.14
- Node.js: pinned image in `execution-identity.json`, v24.18.0
- Status: `verified_controlled`
- Production eligible: `false`

## Proved boundary

- the physical executor-role ACL test passed against PostgreSQL;
- one accepted Effect at revision 4 and its three pre-restart Receipts were
  durable before the database restart;
- the PostgreSQL container ID and system identifier stayed the same while both
  container start time and `pg_postmaster_start_time()` changed;
- recovery ran in a different Node container and process instance;
- recovery replayed the pre-restart prepare and accepted Receipt without a
  revision increase, then committed and replayed one observed Receipt at
  revision 5;
- `verify.json` independently accepted the restart/replay tuple;
- the outage query failed while PostgreSQL was stopped;
- campaign cleanup left zero tenant, Effect and Receipt rows and disabled both
  campaign-owned registries;
- the exact campaign left zero containers, networks and volumes; the validation
  host returned to 9 stopped pre-existing containers and zero running ones;
- the campaign-specific secret scan passed.

## Sensitive inspect retention rule

The remote harness compared full pre/post `docker inspect` documents after
sorting only the semantically unordered mount/bind collections. Both normalized
documents had SHA-256
`2c2e52c277d62288cb6cae684d2c1ddd6382137453235b7dde8412f29636e8fd`.
Full inspect JSON can contain unrelated service environment values, so those
four documents and the containing temporary archive are deliberately not
retained in Git. Only their equal digests, the unchanged container-ID lists and
the remote manifest remain. `retained-output.sha256` binds every retained file.

## Non-claims

This evidence does not prove SIP peer interoperability, `100 Trying` latency,
long-call stability, host capacity, rolling N/N+1 deployment or production
eligibility. It does not touch or qualify the frozen production server.
