import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const patchPath =
  'infra/converact/rustpbx/patches/rustpbx-ivekit-dual-leg-cdr.patch';

test('RustPBX dual-leg CDR patch durably spools terminal state before legacy reporting', () => {
  const patch = readFileSync(patchPath, 'utf8');
  const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');

  assert.match(build, /rustpbx-ivekit-dual-leg-cdr\.patch/);
  assert.match(patch, /src\/ivekit_dual_leg_cdr\.rs/);
  assert.match(patch, /IVEKIT_RUSTPBX_CDR_SPOOL_DIR/);
  assert.match(patch, /IVEKIT_RUSTPBX_CDR_ENDPOINT/);
  assert.match(patch, /IVEKIT_RUSTPBX_CDR_SERVICE_KEY_FILE/);
  assert.match(patch, /IVEKIT_RUSTPBX_CDR_REGION_ID/);
  assert.match(patch, /assert_admission_ready/);
  assert.match(patch, /start_uploader\(\)\?/);
  assert.match(patch, /projected_service_key_allows_group_read_but_rejects_group_write/);
  assert.match(patch, /projected_service_key_symlink_must_resolve_inside_mount/);
  assert.match(patch, /MAX_UPLOAD_CONCURRENCY/);
  assert.match(patch, /MAX_SPOOL_WRITER_QUEUE/);
  assert.match(patch, /MAX_SPOOL_WRITE_BATCH/);
  assert.match(patch, /spawn_spool_writer/);
  assert.match(patch, /async fn persist_with_writer/);
  assert.match(patch, /tokio::sync::mpsc/);
  assert.match(patch, /oneshot::channel/);
  assert.match(
    patch,
    /start_uploader\(\)[\s\S]*spool_writer\(&config\)[\s\S]*UPLOADER\.set/
  );
  assert.match(
    patch,
    /TrySendError::Full\(request\)[\s\S]*writer\.send\(request\)\.await/
  );
  const queueFullBranch = patch.match(
    /TrySendError::Full\(request\)([\s\S]*?)TrySendError::Closed/
  )?.[1] || '';
  assert.doesNotMatch(queueFullBranch, /SPOOL_HEALTHY\.store\(false/);
  assert.match(patch, /saturated_spool_writer_backpressure_does_not_block_os_threads/);
  assert.match(patch, /spool_writer_retries_failed_batch_without_acknowledging_loss/);
  assert.match(patch, /reporter\.report\(snapshot\)\.await/);
  assert.match(patch, /report_in_background/);
  assert.doesNotMatch(patch, /block_in_place/);
  assert.doesNotMatch(patch, /UPLOAD_LOCK: AsyncMutex|upload_lock\(\)\.lock\(\)\.await/);
  assert.match(patch, /REGION_COMMIT_MAX_CONCURRENT/);
  assert.match(patch, /try_acquire_owned/);
  assert.match(patch, /recover_region_upload_claims/);
  assert.match(patch, /upload_one\(config, &service_key, path\)\.await/);
  assert.match(patch, /availability_profile == PROFILE_T1/);
  assert.match(
    patch,
    /begin_termination_pair\("normal_session_cleanup"\)[\s\S]*reporter\.report\(snapshot\)\.await[\s\S]*if !t1_cdr_committed[\s\S]*terminate_pair\("normal_session_cleanup"\)/
  );
  assert.match(patch, /recovery_mode[\s\S]*finalize/);
  assert.match(patch, /finalize_recovered_dialog_pair/);
  assert.match(
    patch,
    /emit_recovered_terminal_cdr\([\s\S]*\.await[\s\S]*shadow remains recoverable[\s\S]*return;[\s\S]*recovered_shadow_pair_request/
  );
  const dropSafetyNet = patch.match(
    /impl Drop for SipSession[\s\S]*?(?=diff --git)/
  )?.[0] || '';
  const addedDropSafetyNet = dropSafetyNet
    .split('\n')
    .filter((line) => line.startsWith('+'))
    .join('\n');
  assert.match(addedDropSafetyNet, /report_in_background/);
  assert.doesNotMatch(addedDropSafetyNet, /cdr_sent[\s\S]*store\(true/);
  assert.match(patch, /SPOOL_HEALTHY/);
  assert.match(patch, /SpoolScanner/);
  assert.match(patch, /spawn_blocking/);
  assert.match(patch, /missing_callee_terminal_data_stays_independent_from_the_caller/);
  assert.doesNotMatch(patch, /unwrap_or\\(status_code\\)/);
  assert.doesNotMatch(patch, /unwrap_or_else\\(\\|\\| caller_cause\\.clone\\(\\)\\)/);
  assert.match(patch, /RetrySchedule/);
  assert.match(patch, /schedule_retry/);
  assert.match(patch, /retry_ready/);
  assert.match(patch, /service_key_path/);
  assert.match(patch, /read_secret\(&service_key_path\)/);
  assert.match(patch, /quarantine_permanent_failure/);
  assert.match(patch, /remove_stale_temporary_files/);
  assert.match(patch, /TerminalCdrLegInput/);
  assert.match(patch, /recovered_sequence_is_fenced_by_owner_epoch/);
  assert.match(patch, /pending_unacknowledged/);
  assert.match(patch, /sync_all/);
  assert.match(patch, /std::fs::rename/);
  assert.match(patch, /acknowledged_payload_hash/);
  assert.match(patch, /committed_sequence/);
  assert.match(patch, /durability_contract_id/);
  assert.match(patch, /receipt_id/);
  assert.match(
    patch,
    /receipt\.region_id\.as_deref\(\) != Some\(expected_region_id\)/
  );
  assert.match(patch, /remove_file/);
  assert.match(patch, /dialog_id_hash/);
  assert.match(patch, /sip_final_code/);
  assert.match(patch, /hangup_cause/);
  assert.match(patch, /media_result/);
  assert.match(patch, /reservation_ref/);
  assert.match(patch, /owner_epoch/);
  assert.match(patch, /route_snapshot_revision/);
  assert.match(patch, /winning_branch_hash/);
  assert.doesNotMatch(
    patch,
    /\.or\(Some\(callee_dialog_id_hash\)\)/,
    'an unallocated callee identity must not be reported as a winning SIP branch'
  );
  assert.match(patch, /early_media/);
  assert.match(patch, /transfer_chain_hashes/);
  assert.match(patch, /media_timeout/);
  assert.match(patch, /cdr_sequence/);
  assert.match(patch, /emit_recovered_terminal_cdr/);
  assert.doesNotMatch(
    changedFiles(patch).join('\n'),
    /src\/media\/|rustrtc|transport\/udp|forwarding_track/
  );
});

test('RustPBX CDR patch binds admission to the exact route snapshot revision', () => {
  const patch = readFileSync(patchPath, 'utf8');

  assert.match(patch, /route_snapshot_revision: u64/);
  assert.match(patch, /snapshot_result_with_revision/);
  assert.match(
    patch,
    /admitted\.data\.route_snapshot_revision != route_snapshot_revision/
  );
  assert.match(patch, /route_snapshot_revision: admitted\.data\.route_snapshot_revision/);
  assert.match(
    patch,
    /existing\.contract\.route_snapshot_revision != contract\.route_snapshot_revision/
  );
});

test('RustPBX hash-binds the configured Region before uploading a terminal CDR', () => {
  const patch = readFileSync(patchPath, 'utf8');

  assert.match(
    patch,
    /struct DualLegCdrEnvelope \{[\s\S]*expected_region_id: String/
  );
  assert.match(
    patch,
    /expected_region_id: expected_region_id\.to_string\(\)/
  );
  assert.match(
    patch,
    /payload\(input, &config\.region_id\)/
  );
});

test('RustPBX CDR deployment uses a persistent per-node spool and file-backed service key', () => {
  const compose = readFileSync('services/converact-service/docker-compose.voice.yml', 'utf8');
  const apiCompose = readFileSync('services/converact-service/docker-compose.yml', 'utf8');
  const values = readFileSync('services/converact-service/helm/converact/values.yaml', 'utf8');
  const apiDeployment = readFileSync(
    'services/converact-service/helm/converact/templates/deployment.yaml',
    'utf8'
  );
  const statefulSet = readFileSync(
    'services/converact-service/helm/converact/templates/rustpbx-deployment.yaml',
    'utf8'
  );
  const legacyCompose = readFileSync('infra/converact/docker-compose.voice.yml', 'utf8');
  const legacyValues = readFileSync('infra/k8s/values.yaml', 'utf8');
  const legacyStatefulSet = readFileSync(
    'infra/k8s/templates/rustpbx-deployment.yaml',
    'utf8'
  );
  const legacyApiDeployment = readFileSync(
    'infra/k8s/templates/opc-deployment.yaml',
    'utf8'
  );
  const workflow = readFileSync('.github/workflows/ivekit-rustpbx-image.yml', 'utf8');

  assert.match(compose, /IVEKIT_RUSTPBX_CDR_SPOOL_DIR: \/app\/storage\/cdr-spool/);
  assert.equal(
    occurrences(compose, 'RUSTPBX_ENV: ${RUSTPBX_ENV:-production}'),
    2
  );
  assert.equal(
    occurrences(
      compose,
      'IVEKIT_RUSTPBX_CDR_ENDPOINT: ${RUSTPBX_CDR_ENDPOINT:?RUSTPBX_CDR_ENDPOINT is required}'
    ),
    2
  );
  assert.match(
    compose,
    /CONVERACT_FABRIC_CDR_REGION_ID: \$\{CONVERACT_FABRIC_CDR_REGION_ID:\?CONVERACT_FABRIC_CDR_REGION_ID is required\}/
  );
  assert.equal(
    occurrences(
      compose,
      'IVEKIT_RUSTPBX_CDR_REGION_ID: ${CONVERACT_FABRIC_CDR_REGION_ID:?CONVERACT_FABRIC_CDR_REGION_ID is required}'
    ),
    2
  );
  assert.match(compose, /IVEKIT_RUSTPBX_CDR_SERVICE_KEY_FILE: \/run\/secrets\/rustpbx-cdr-service-key/);
  assert.match(compose, /rustpbx-cdr-service-key:[\s\S]*RUSTPBX_CDR_SERVICE_KEY_FILE/);
  assert.match(
    apiCompose,
    /CONVERACT_FABRIC_CDR_REGION_ID: \$\{CONVERACT_FABRIC_CDR_REGION_ID:-\}/
  );

  assert.match(
    values,
    /cdr:\s*\n\s+regionId: ""\s*\n\s+endpoint: ""\s*\n\s+pollIntervalMs: "500"/
  );
  assert.match(
    apiDeployment,
    /voice\.cdr\.regionId is required when voice is enabled/
  );
  assert.match(
    apiDeployment,
    /name: CONVERACT_FABRIC_CDR_REGION_ID\s*\n\s+value: \{\{ \.Values\.voice\.cdr\.regionId \| quote \}\}/
  );
  assert.doesNotMatch(
    apiDeployment,
    /name: CONVERACT_FABRIC_CDR_REGION_ID[\s\S]{0,120}\.Values\.placement\.homeRegionId/
  );
  assert.match(statefulSet, /voice\.cdr\.endpoint is required when voice is enabled/);
  assert.match(statefulSet, /name: RUSTPBX_ENV\s*\n\s+value: production/);
  assert.match(statefulSet, /IVEKIT_RUSTPBX_CDR_SPOOL_DIR[\s\S]*\/app\/storage\/cdr-spool/);
  assert.match(statefulSet, /IVEKIT_RUSTPBX_CDR_ENDPOINT[\s\S]*\.Values\.voice\.cdr\.endpoint/);
  assert.match(
    statefulSet,
    /name: IVEKIT_RUSTPBX_CDR_REGION_ID\s*\n\s+value: \{\{ \.Values\.voice\.cdr\.regionId \| quote \}\}/
  );
  assert.match(statefulSet, /IVEKIT_RUSTPBX_CDR_SERVICE_KEY_FILE[\s\S]*\/run\/cdr-secrets\/service-key/);
  assert.match(statefulSet, /name: cdr-secrets[\s\S]*defaultMode: 0440/);
  assert.match(statefulSet, /name: storage[\s\S]*mountPath: \/app\/storage/);
  assert.match(
    statefulSet,
    /voice\.persistence\.enabled must be true for the durable CDR spool/
  );

  assert.match(legacyCompose, /IVEKIT_RUSTPBX_CDR_SPOOL_DIR: \/app\/storage\/cdr-spool/);
  assert.match(legacyCompose, /RUSTPBX_ENV: \$\{RUSTPBX_ENV:-production\}/);
  assert.match(
    legacyCompose,
    /IVEKIT_RUSTPBX_CDR_ENDPOINT: \$\{RUSTPBX_CDR_ENDPOINT:\?RUSTPBX_CDR_ENDPOINT is required\}/
  );
  assert.match(
    legacyCompose,
    /CONVERACT_FABRIC_CDR_REGION_ID: \$\{CONVERACT_FABRIC_CDR_REGION_ID:\?CONVERACT_FABRIC_CDR_REGION_ID is required\}/
  );
  assert.match(
    legacyCompose,
    /IVEKIT_RUSTPBX_CDR_REGION_ID: \$\{CONVERACT_FABRIC_CDR_REGION_ID:\?CONVERACT_FABRIC_CDR_REGION_ID is required\}/
  );
  assert.match(
    legacyCompose,
    /IVEKIT_RUSTPBX_CDR_SERVICE_KEY_FILE: \/run\/secrets\/rustpbx-cdr-service-key/
  );
  assert.match(legacyCompose, /rustpbx-cdr-service-key:[\s\S]*RUSTPBX_CDR_SERVICE_KEY_FILE/);
  assert.match(
    legacyValues,
    /cdr:\s*\n\s+regionId: ""\s*\n\s+endpoint: ""\s*\n\s+pollIntervalMs: "500"/
  );
  assert.match(
    legacyApiDeployment,
    /voice\.cdr\.regionId is required when voice is enabled/
  );
  assert.match(
    legacyApiDeployment,
    /name: CONVERACT_FABRIC_CDR_REGION_ID\s*\n\s+value: \{\{ \.Values\.voice\.cdr\.regionId \| quote \}\}/
  );
  assert.match(
    legacyStatefulSet,
    /voice\.persistence\.enabled must be true for the durable CDR spool/
  );
  assert.match(legacyStatefulSet, /name: RUSTPBX_ENV\s*\n\s+value: production/);
  assert.match(
    legacyStatefulSet,
    /IVEKIT_RUSTPBX_CDR_SPOOL_DIR[\s\S]*\/app\/storage\/cdr-spool/
  );
  assert.match(
    legacyStatefulSet,
    /name: IVEKIT_RUSTPBX_CDR_REGION_ID\s*\n\s+value: \{\{ \.Values\.voice\.cdr\.regionId \| quote \}\}/
  );
  assert.match(
    legacyStatefulSet,
    /IVEKIT_RUSTPBX_CDR_SERVICE_KEY_FILE[\s\S]*\/run\/cdr-secrets\/service-key/
  );
  assert.match(legacyStatefulSet, /name: cdr-secrets[\s\S]*defaultMode: 0440/);
  assert.match(workflow, /VERSION: 0\.4\.11-ivekit\.40-6c49ee76/);
});

test('RustPBX CDR patch is syntactically valid and hash-bound', () => {
  const parsed = spawnSync(
    'git',
    ['apply', '--numstat', patchPath],
    { encoding: 'utf8' }
  );
  assert.equal(parsed.status, 0, parsed.stderr);
  assert.match(parsed.stdout, /src\/ivekit_dual_leg_cdr\.rs/);
  assert.match(parsed.stdout, /src\/proxy\/proxy_call\/reporter\.rs/);
  assert.match(parsed.stdout, /src\/ivekit_dialog_shadow\.rs/);
  assert.match(parsed.stdout, /src\/proxy\/routing\/http\.rs/);

  const manifest = JSON.parse(
    readFileSync('docs/capacity/forks/ivekit-forks-v1.json', 'utf8')
  ) as {
    components: Array<{
      component_id: string;
      patches: Array<{ path: string; sha256: string }>;
      implemented_changes: Array<{ change_id: string }>;
    }>;
  };
  const rustpbx = manifest.components.find(
    (component) => component.component_id === 'rustpbx'
  );
  assert.ok(rustpbx);
  const patch = rustpbx.patches.find((item) => item.path === patchPath);
  assert.ok(patch);
  assert.equal(
    patch.sha256,
    createHash('sha256').update(readFileSync(patchPath)).digest('hex')
  );
  assert.equal(
    rustpbx.implemented_changes.some(
      (change) => change.change_id === 'rustpbx-dual-leg-cdr-v1'
    ),
    true
  );
});

function changedFiles(patch: string): string[] {
  return [...patch.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)]
    .map((match) => match[2] || match[1])
    .filter((value): value is string => Boolean(value));
}

function occurrences(value: string, needle: string): number {
  return value.split(needle).length - 1;
}
