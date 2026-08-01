import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const scriptPath = new URL(
  '../infra/capacity/homer-hep-ab/run.sh',
  import.meta.url
);
const evidencePath = new URL(
  '../docs/evidence/wave1-homer-hep-ab-server-validation-2026-07-25.json',
  import.meta.url
);

test('HOMER HEP A/B runner preserves topology and records comparable evidence', () => {
  const source = readFileSync(scriptPath, 'utf8');

  assert.match(source, /HEP_MODES="\$\{HEP_MODES:-disabled,enabled\}"/);
  assert.match(source, /case "\$mode" in[\s\S]*enabled\)[\s\S]*disabled\)/);
  assert.match(source, /kamailio -c -f \/etc\/kamailio\/kamailio\.cfg/);
  assert.match(source, /docker restart "\$KAMAILIO_CONTAINER"/);
  assert.match(source, /restore_enabled_config/);
  assert.match(source, /trap cleanup EXIT INT TERM/);
  assert.match(source, /hep_expected_rows/);
  assert.match(source, /hep_actual_rows/);
  assert.match(source, /session_id LIKE/);
  assert.match(source, /CAMPAIGN_ID/);
  assert.match(source, /wait_homer_cooldown/);
  assert.match(source, /HOMER_COOLDOWN_CPU_PERCENT/);
  assert.match(source, /SIPP_WAIT_PID/);
  assert.match(source, /statistics\["CurrentCall"\]/);
  assert.match(source, /sip_route_p95_ms/);
  assert.match(source, /sip_route_p99_ms/);
  assert.match(source, /docker-stats\.csv/);
  assert.match(source, /host-vmstat\.log/);
  assert.match(source, /capacity_claim/);
  assert.match(source, /controlled_server_same_host/);
});

test('HOMER HEP A/B runner validates immutable inputs and bounded load', () => {
  const source = readFileSync(scriptPath, 'utf8');

  assert.match(source, /require_file "\$SIPP_BINARY"/);
  assert.match(source, /require_file "\$SIPP_SCENARIO"/);
  assert.match(source, /require_file "\$KAMAILIO_ENABLED_CONFIG"/);
  assert.match(source, /require_file "\$KAMAILIO_DISABLED_CONFIG"/);
  assert.match(source, /KAMAILIO_CONFIG_UID/);
  assert.match(source, /KAMAILIO_CONFIG_GID/);
  assert.match(source, /os\.chown/);
  assert.match(source, /DURATION_SECONDS.*5.*120/);
  assert.match(source, /REPETITIONS.*1.*5/);
  assert.match(source, /POINTS/);
  assert.match(source, /100_000|100000/);
  assert.match(source, /sha256sum/);
  assert.match(source, /sensitive_inputs_removed/);
});

test('HOMER HEP A/B evidence is source-bound and rejects the 900 CPS point', () => {
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8')) as {
    status: string;
    capacity_claim: string;
    production_capacity_evidence: boolean;
    sensitive_inputs_removed: boolean;
    source: { runner_sha256: string };
    runs: Array<{
      target_cps: number;
      mode: string;
      repetition: number;
      status: string;
      expected_calls: number;
      successful_calls: number;
      failed_calls: number;
      remaining_calls: number;
      retransmissions: number;
      hep_expected_rows: number;
      hep_actual_rows: number;
    }>;
  };

  assert.equal(evidence.status, 'controlled_failed');
  assert.equal(evidence.capacity_claim, 'none');
  assert.equal(evidence.production_capacity_evidence, false);
  assert.equal(evidence.sensitive_inputs_removed, true);
  assert.equal(
    evidence.source.runner_sha256,
    createHash('sha256').update(readFileSync(scriptPath)).digest('hex')
  );
  assert.equal(evidence.runs.length, 12);

  const cleanEnabled = evidence.runs.filter(
    (run) => run.mode === 'enabled' && (run.target_cps === 400 || run.target_cps === 700)
  );
  assert.equal(cleanEnabled.length, 4);
  for (const run of cleanEnabled) {
    assert.equal(run.status, 'controlled_pass');
    assert.equal(run.successful_calls, run.expected_calls);
    assert.equal(run.failed_calls + run.remaining_calls + run.retransmissions, 0);
    assert.equal(run.hep_actual_rows, run.hep_expected_rows);
  }
  assert.equal(
    evidence.runs.some(
      (run) => run.target_cps === 900 && run.mode === 'enabled'
        && run.status === 'controlled_failed'
    ),
    true
  );
});
