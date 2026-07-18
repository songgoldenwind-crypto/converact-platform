import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildIveKitStandaloneContext,
  validateIveKitStandaloneContext
} from './ivekit-standalone-build-context.js';
import {
  createIveKitReleaseOperations,
  validateIveKitReleaseOperations,
  type IveKitReleaseContract
} from './ivekit-release-operations.js';
import {
  createIveKitStage2ReleaseEvidence,
  validateIveKitStage2ReleaseEvidence,
  type IveKitStage2ReleaseEvidence
} from './ivekit-stage2-release-evidence.js';
import {
  VOICE_REQUIRED_ACCEPTANCE_CHECKS,
  createIveKitVoiceAcceptanceTemplate,
  renderIveKitVoiceAcceptanceRunbook
} from './ivekit-voice-acceptance.js';
import {
  createIveKitV6RealAcceptanceTemplate,
  validateIveKitV6RealAcceptanceManifest,
  type IveKitV6RealAcceptanceManifest
} from './ivekit-v6-real-acceptance.js';

export interface DeliverySourceFile {
  source: string;
  destination: string;
}

export interface IveKitDeliveryManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

export interface IveKitDeliveryManifest {
  schema_version: 1;
  product: 'iveKit';
  foundation_version: 'V5';
  status: 'ready_for_handoff';
  source_commit: string;
  generated_at: string;
  contents: {
    sdk: string;
    reference_client: string;
    deployment: string;
    database: string;
    documentation: string;
    acceptance: string;
    provider_profiles: string;
    operations: string;
    release_operations: string;
    completion_audit: string;
    intelligence_preflight: string;
    voice_preflight: string;
    voice_compose: string;
    voice_helm: string;
    voice_acceptance_template: string;
    voice_acceptance_runbook: string;
    v6_real_acceptance_template: string;
    rustpbx_image_build: string;
    rustpbx_acceptance: string;
    capacity_runtime: string;
    service_source: string;
  };
  artifacts: {
    sdk_package: { path: string; sha256: string };
    reference_client: { path: string; tree_sha256: string };
    service_build_context: { path: string; manifest_sha256: string };
    migration_manifest: { path: string; sha256: string };
    image_metadata: { path: string; sha256: string };
    sbom: { path: string; sha256: string };
    acceptance_status: { path: string; sha256: string };
    v6_real_acceptance_template: { path: string; sha256: string };
    provider_profiles_example: { path: string; sha256: string };
    release_contract: { path: string; sha256: string };
    stage2_deployment_evidence: { path: string; sha256: string };
    upgrade_runbook: { path: string; sha256: string };
  };
  provider_ownership: {
    livekit: string;
    tinode: string;
    rustdesk: string;
    rustpbx: string;
  };
  real_environment_acceptance: {
    livekit: 'not_run';
    tinode: 'not_run';
    rustdesk: 'not_run';
    rustpbx: 'not_run';
    ocr: 'not_run';
    asr: 'not_run';
    quality_review: 'not_run';
    translation: 'not_run';
    notification_providers: 'not_run';
    file_security: 'not_run';
    public_webhook: 'not_run';
    kubernetes: 'not_run';
    backup_restore: 'not_run';
  };
  controlled_environment_acceptance: {
    postgres: IveKitControlledAcceptanceStatus;
    provider_protocol: IveKitControlledAcceptanceStatus;
    browser: IveKitControlledAcceptanceStatus;
    restart_recovery: IveKitControlledAcceptanceStatus;
    full_chain: IveKitControlledAcceptanceStatus;
  };
  capability_matrix: IveKitDeliveryCapability[];
  acceptance_matrix: {
    automated: {
      status: 'required_before_release';
      command: 'npm run verify:ivekit:foundation';
    };
    controlled: IveKitDeliveryManifest['controlled_environment_acceptance'];
    real_environment: IveKitDeliveryManifest['real_environment_acceptance'];
  };
  known_not_run: IveKitKnownNotRun[];
  files: IveKitDeliveryManifestFile[];
}

export interface IveKitDeliveryCapability {
  id: string;
  stage: 1 | 2 | 3 | 4 | 5;
  delivery_status: 'included';
  contract: string;
  real_environment_gates: string[];
}

export interface IveKitKnownNotRun {
  id: string;
  status: 'not_run';
  reason: string;
}

export type IveKitControlledAcceptanceStatus = 'not_run' | 'passed';

export interface IveKitControlledAcceptanceEvidence {
  path: string;
  bytes: number;
  sha256: string;
}

export interface LoadedControlledAcceptancePackage {
  root: string;
  statuses: IveKitDeliveryManifest['controlled_environment_acceptance'];
  checks: Record<keyof IveKitDeliveryManifest['controlled_environment_acceptance'], {
    status: IveKitControlledAcceptanceStatus;
    evidence: string[];
  }>;
  evidence: IveKitControlledAcceptanceEvidence[];
}

export interface BuildIveKitDeliveryBundleOptions {
  repoRoot: string;
  outputDir: string;
  sdkTarball: string;
  clientDist: string;
  imageReference?: string;
  imageDigest?: string;
  controlledAcceptanceDir?: string;
  sourceCommit?: string;
  generatedAt?: string;
}

const STANDALONE_MIGRATIONS = [
  'services/ivekit-service/migrations/000_ivekit_foundation.sql',
  'src/migrations/009_tenant_rls.sql',
  'src/migrations/010_force_rls.sql',
  '011_collaboration_remote_assistance.sql',
  '012_livekit_participants.sql',
  '013_media_recording_business_ref.sql',
  '014_remote_assistance_web_assist_mode.sql',
  '016_collaboration_chat_bindings.sql',
  '017_collaboration_message_attachments.sql',
  '018_rustdesk_devices.sql',
  '019_rustdesk_gateway_sessions.sql',
  '020_rustdesk_gateway_events.sql',
  '021_rustdesk_device_heartbeat.sql',
  '022_rustdesk_tenant_rls.sql',
  '024_rustdesk_device_commands.sql',
  '025_collaboration_message_delivery.sql',
  '026_media_recording_lifecycle.sql',
  '027_collaboration_attachment_processing.sql',
  '028_collaboration_policy_findings.sql',
  '029_collaboration_quality_review.sql',
  '030_collaboration_message_state.sql',
  '033_collaboration_im_features.sql',
  '034_ivekit_media_calls.sql',
  '035_ivekit_media_moderation.sql',
  '036_media_recording_call_room.sql',
  '037_media_call_timeout_worker.sql',
  '038_media_recording_evidence.sql',
  '039_rustdesk_access_policy.sql',
  '040_rustdesk_control_ownership.sql',
  '041_tinode_inbound_sync.sql',
  '042_ivekit_tenant_events.sql',
  '043_ivekit_intelligence_translation.sql',
  '044_quality_review_policy_routing.sql',
  '045_translation_worker_routing.sql',
  '046_ivekit_voice_foundation.sql',
  '047_ivekit_ivr_foundation.sql',
  '048_ivekit_voice_operations.sql',
  '049_ivekit_voice_route_deployment.sql',
  '050_ivekit_ivr_runtime.sql',
  '051_ivekit_ivr_resources.sql',
  '052_ivekit_contact_center.sql',
  '053_ivekit_contact_center_configuration_idempotency.sql',
  '054_ivekit_contact_center_worker.sql',
  '055_ivekit_contact_center_callbacks.sql',
  '056_ivekit_contact_center_overflow.sql',
  '057_ivekit_voice_action_capabilities.sql',
  '058_ivekit_voice_parking.sql',
  '059_ivekit_provider_governance.sql',
  '060_ivekit_content_intelligence.sql',
  '061_ivekit_file_security.sql',
  '062_tinode_file_delivery_operations.sql',
  '063_livekit_media_quality.sql',
  '064_rustdesk_authorization_codes.sql',
  '065_ivekit_notifications.sql',
  '066_ivekit_audit.sql',
  '067_ivekit_rate_limits.sql',
  '068_ivekit_retention.sql',
  '069_ivekit_runtime_heartbeats.sql',
  '070_ivekit_notification_operations.sql',
  '071_ivekit_notification_health.sql',
  '072_ivekit_notification_events.sql',
  '073_ivekit_integration_webhooks.sql',
  '074_tinode_message_mutation_outbox.sql',
  '075_rustdesk_emergency_fallback.sql',
  '076_rustdesk_evidence_intelligence_reconciliation.sql',
  '077_ivekit_capacity_orchestrator.sql',
  '078_ivekit_cell_leases.sql',
  '079_ivekit_voice_route_snapshot_revision.sql',
  '080_ivekit_interaction_placements.sql',
  '081_ivekit_notification_worker_partition.sql',
  '082_ivekit_capacity_worker_checkpoints.sql',
  '083_ivekit_cell_admission_reservations.sql',
  '084_ivekit_cell_lease_topology.sql',
  '085_ivekit_interaction_placement_handoffs.sql',
  '086_ivekit_recording_manifests.sql',
  '087_livekit_egress_jobs.sql',
  '088_livekit_egress_reconciliation.sql',
  '089_livekit_egress_capacity_metrics.sql',
  'services/ivekit-service/migrations/090_ivekit_runtime_security.sql',
  '091_ivekit_capacity_scaling_campaigns.sql',
  '092_ivekit_capacity_platform_campaigns.sql'
];

const CAPACITY_RUNTIME_SOURCE_PATHS = [
  '.github/workflows/ivekit-capacity-ci.yml',
  'infra/capacity/Dockerfile',
  'infra/capacity/README.md',
  'infra/capacity/package.json',
  'infra/capacity/package-lock.json',
  'infra/capacity/tsconfig.json',
  'scripts/ivekit-capacity-controller.ts',
  'scripts/ivekit-capacity-dispatcher.ts',
  'scripts/ivekit-capacity-finalizer.ts',
  'scripts/ivekit-capacity-scaling-finalizer.ts',
  'scripts/ivekit-capacity-platform-finalizer.ts',
  'scripts/ivekit-capacity-worker.ts',
  'scripts/ivekit-cell-admission.ts',
  'scripts/ivekit-cell-capacity-projector.ts',
  'scripts/ivekit-component-node-admission.ts',
  'scripts/ivekit-rustdesk-owner-binding.ts',
  'scripts/capacity/canonical-json.ts',
  'scripts/capacity/evidence-validator.ts',
  'scripts/capacity/frontier-runner.ts',
  'scripts/capacity/generator-qualification.ts',
  'scripts/capacity/generators/external-json.ts',
  'scripts/capacity/generators/external-worker.ts',
  'scripts/capacity/generators/ivekit-event-ws.ts',
  'scripts/capacity/generators/livekit.ts',
  'scripts/capacity/generators/rtp-media-twin.ts',
  'scripts/capacity/generators/rustdesk.ts',
  'scripts/capacity/generators/sipp.ts',
  'scripts/capacity/generators/tinode.ts',
  'scripts/capacity/orchestrator/controller.ts',
  'scripts/capacity/orchestrator/index.ts',
  'scripts/capacity/orchestrator/jetstream-bus.ts',
  'scripts/capacity/orchestrator/postgres-store.ts',
  'scripts/capacity/orchestrator/run-finalizer.ts',
  'scripts/capacity/orchestrator/s3-evidence.ts',
  'scripts/capacity/orchestrator/service.ts',
  'scripts/capacity/orchestrator/types.ts',
  'scripts/capacity/orchestrator/worker-runtime.ts',
  'scripts/capacity/orchestrator/worker.ts',
  'scripts/capacity/probes/component-probe.ts',
  'scripts/capacity/probes/index.ts',
  'scripts/capacity/probes/prometheus.ts',
  'scripts/capacity/probes/types.ts',
  'scripts/capacity/profile-compiler.ts',
  'scripts/capacity/platform-campaign-runtime.ts',
  'scripts/capacity/platform-campaign.ts',
  'scripts/capacity/scaling-campaign-runtime.ts',
  'scripts/capacity/scaling-campaign.ts',
  'scripts/capacity/scaling-curve.ts',
  'scripts/capacity/shard-lease.ts',
  'src/ivekit-component-node-admission.ts',
  'src/ivekit-placement-snapshot-projector.ts',
  'src/agent-runtime/ivekit/placement/admission-http.ts',
  'src/agent-runtime/ivekit/placement/admission-ledger.ts',
  'src/agent-runtime/ivekit/placement/admission.ts',
  'src/agent-runtime/ivekit/placement/cell-lease.ts',
  'src/agent-runtime/ivekit/placement/component-node-admission-http.ts',
  'src/agent-runtime/ivekit/placement/component-node-admission.ts',
  'src/agent-runtime/ivekit/placement/component-node-sync.ts',
  'src/agent-runtime/ivekit/placement/component-node-topology.ts',
  'src/agent-runtime/ivekit/placement/owner-epoch.ts',
  'src/agent-runtime/ivekit/placement/pg-queryable.ts',
  'src/agent-runtime/ivekit/placement/rustdesk-owner-binding.ts',
  'src/agent-runtime/ivekit/placement/snapshot.ts',
  'src/agent-runtime/ivekit/placement/types.ts',
  'src/agent-runtime/ivekit/recordings/recording-manifest.ts',
  'src/agent-runtime/ivekit/recordings/rustpbx-recording-spool-capacity.ts'
] as const;

export const DELIVERY_SOURCE_FILES: readonly DeliverySourceFile[] = [
  ...CAPACITY_RUNTIME_SOURCE_PATHS.map((source) => ({
    source,
    destination: `capacity-runtime/${source}`
  })),
  ...[
    'README.md',
    'docker-compose.yml',
    'docker-compose.voice.yml',
    'env.example',
    'init-rustpbx-database.sh'
  ].map((name) => ({
    source: `services/ivekit-service/${name}`,
    destination: `deploy/application/${name}`
  })),
  ...[
    'Chart.yaml',
    'README.md',
    'values.yaml',
    'templates/_helpers.tpl',
    'templates/backup-cronjob.yaml',
    'templates/deployment.yaml',
    'templates/hpa.yaml',
    'templates/clamav.yaml',
    'templates/migrate-job.yaml',
    'templates/pdb.yaml',
    'templates/prometheus-rule.yaml',
    'templates/rustpbx-deployment.yaml',
    'templates/service.yaml',
    'templates/service-monitor.yaml',
    'templates/grafana-dashboard.yaml',
    'templates/tinode-config.yaml',
    'templates/tinode-deployment.yaml',
    'templates/tinode-network-policy.yaml',
    'templates/tinode-pdb.yaml',
    'templates/tinode-pvc.yaml',
    'templates/tinode-service.yaml',
    'files/prometheus-rules.yaml',
    'files/grafana-dashboard.json'
  ].map((name) => ({
    source: `services/ivekit-service/helm/ivekit/${name}`,
    destination: `deploy/kubernetes/ivekit/${name}`
  })),
  ...[
    'README.md',
    'docker-compose.yml',
    'docker-compose.storage.yml',
    'env.example',
    'config/redis.conf'
  ].map((name) => ({ source: `infra/livekit/${name}`, destination: `deploy/livekit/${name}` })),
  ...STANDALONE_MIGRATIONS.map((source) => ({
    source: source.includes('/') ? source : `src/migrations/${source}`,
    destination: `database/migrations/${basename(source)}`
  })),
  ...[
    'iveKit\u89c6\u9891IM\u901a\u7528\u80fd\u529b\u8be6\u7ec6\u8bbe\u8ba1.md',
    'openapi.yaml',
    'ivekit-openapi.md',
    'ivekit-led-integration-guide.md',
    'ivekit-m5-unified-collaboration-plan.md',
    'ivekit-client-delivery-v1-roadmap.md',
    'ivekit-voice-foundation-v1-design.md',
    'ivekit-v3-intelligence-operations.md',
    'ivekit-v3-completion-audit.md',
    'ivekit-v5-shared-foundation-design.md',
    'ivekit-v5-stage1-content-intelligence-plan.md',
    'ivekit-v5-stage1-provider-resilience-plan.md',
    'ivekit-v5-stage2-im-livekit-file-plan.md',
    'ivekit-v5-stage3-rustdesk-windows-plan.md',
    'ivekit-v5-stage4-voice-notification-operations-plan.md',
    'ivekit-v5-stage5-integration-delivery-plan.md',
    'ivekit-backup-restore-runbook.md',
    'ivekit-notification-operations-runbook.md',
    'ivekit-monitoring-runbook.md',
    'ivekit-integration-event-webhook-runbook.md',
    'ivekit-rustdesk-windows-deployment.md',
    'ivekit-v6-production-closure-design.md',
    'ivekit-v6-production-closure-plan.md',
    'ivekit-v6-real-environment-acceptance.md',
    'livekit-im-full-capability-plan.md',
    'rustdesk-client-version-matrix.md'
  ].map((name) => ({ source: `docs/${name}`, destination: `docs/${name}` })),
  ...[
    'README.md',
    'campaign-finalization-runbook.md',
    'cell-10k-pilot-budget.md',
    'component-node-admission-protocol-v1.md',
    'forks/ivekit-forks-v1.json',
    'implementation-plan-phase1.md',
    'implementation-plan-phase2.md',
    'phase1-controlled-status.json',
    'phase2-code-status.json',
    'profiles/cell-10k-v1.json',
    'profiles/mix-100k-v1.json',
    'run-config.example.json',
    'schemas/capacity-vector.schema.json',
    'schemas/fork-manifest.schema.json',
    'schemas/scaling-efficiency.schema.json',
    'schemas/workload-profile.schema.json',
    'targets/mix-100k-efficiency-v1.json'
  ].map((name) => ({
    source: `docs/capacity/${name}`,
    destination: `docs/capacity/${name}`
  })),
  ...[
    'ccaas-1-cell-placement.md',
    'ccaas-2-dual-zone-quorum.md',
    'ccaas-3-recording-evidence.md',
    'ccaas-4-open-source-fork-governance.md',
    'ccaas-5-distributed-load-generation.md',
    'ccaas-6-single-node-density-and-scaling-efficiency.md'
  ].map((name) => ({
    source: `docs/adr/${name}`,
    destination: `docs/adr/${name}`
  })),
  ...[
    'docker-compose.yml',
    'env.example',
    'kubernetes/cell-admission-deployment.yaml',
    'kubernetes/component-node-admission-sidecar.yaml',
    'kubernetes/controller-deployment.yaml',
    'kubernetes/dispatcher-deployment.yaml',
    'kubernetes/finalizer-job.yaml',
    'kubernetes/livekit-statefulset.yaml',
    'kubernetes/platform-finalizer-job.yaml',
    'kubernetes/rustdesk-statefulset.yaml',
    'kubernetes/scaling-finalizer-job.yaml',
    'kubernetes/tinode-statefulset.yaml',
    'kubernetes/worker-statefulset.yaml'
  ].map((name) => ({
    source: `infra/capacity/${name}`,
    destination: `infra/capacity/${name}`
  })),
  ...[
    'go.mod',
    'README.md',
    'hook.go',
    'http_authorizer.go',
    'hook_test.go',
    'http_authorizer_test.go'
  ].map((name) => ({
    source: `integrations/component-hook-go/${name}`,
    destination: `fork-hooks/go/${name}`
  })),
  ...[
    'go.mod',
    'README.md',
    'registry.go',
    'registry_test.go'
  ].map((name) => ({
    source: `integrations/livekit-v1.13.3/${name}`,
    destination: `fork-hooks/livekit-v1.13.3/${name}`
  })),
  ...[
    'go.mod',
    'README.md',
    'registry.go',
    'registry_test.go'
  ].map((name) => ({
    source: `integrations/tinode-v0.25.3/${name}`,
    destination: `fork-hooks/tinode-v0.25.3/${name}`
  })),
  ...[
    'Cargo.toml',
    'Cargo.lock',
    'README.md',
    'src/lib.rs'
  ].map((name) => ({
    source: `integrations/component-hook-rs/${name}`,
    destination: `fork-hooks/rust/${name}`
  })),
  ...[
    'ivekit-led-integration-example.ts',
    'ivekit-rustdesk-led-example.ts'
  ].map((name) => ({ source: `scripts/${name}`, destination: `examples/${name}` })),
  {
    source: 'sdk/ivekit/examples/webhook-receiver.ts',
    destination: 'examples/ivekit-webhook-receiver.ts'
  },
  ...[
    'README.md',
    'Dockerfile.runtime',
    'Cargo.lock',
    'build.sh'
  ].map((name) => ({ source: `infra/ivekit/rustpbx/${name}`, destination: `deploy/rustpbx/${name}` })),
  ...[
    'rsipstack-tcp-reconnect.patch',
    'rsipstack-ivekit-capacity.patch',
    'rustpbx-ivekit-ami-dialogs.patch',
    'rustpbx-ivekit-rwi-originate-hangup.patch',
    'rustpbx-ivekit-route-snapshot.patch',
    'rustpbx-ivekit-inbound-admission.patch',
    'rustpbx-ivekit-owner-epoch.patch',
    'rustpbx-ivekit-recording-spool.patch',
    'rustpbx-local-rsipstack.patch',
    'rustpbx-ivekit-sip-capacity.patch',
    'rustpbx-ivekit-media-hot-path.patch'
  ].map((name) => ({
    source: `infra/ivekit/rustpbx/patches/${name}`,
    destination: `deploy/rustpbx/patches/${name}`
  })),
  ...[
    'README.md',
    'apply-overlay.mjs',
    'build.sh'
  ].map((name) => ({
    source: `infra/ivekit/livekit/${name}`,
    destination: `deploy/livekit-fork/${name}`
  })),
  {
    source: 'infra/ivekit/livekit/patches/livekit-ivekit-small-room-hot-path.patch',
    destination: 'deploy/livekit-fork/patches/livekit-ivekit-small-room-hot-path.patch'
  },
  ...[
    'README.md',
    'apply-overlay.mjs',
    'build.sh',
    'ivekit_metrics.go'
  ].map((name) => ({
    source: `infra/ivekit/livekit-egress/${name}`,
    destination: `components/livekit-egress/infra/ivekit/livekit-egress/${name}`
  })),
  ...[
    'go.mod',
    'policy.go',
    'policy_test.go'
  ].map((name) => ({
    source: `integrations/livekit-egress-v1.13.0/${name}`,
    destination: `components/livekit-egress/integrations/livekit-egress-v1.13.0/${name}`
  })),
  ...[
    ['Chart.yaml', 'Chart.yaml'],
    ['values.yaml', 'values.yaml'],
    ['templates/_helpers.tpl', 'templates/_helpers.tpl'],
    ['templates/livekit-egress-deployment.yaml', 'templates/livekit-egress-deployment.yaml']
  ].map(([source, destination]) => ({
    source: `infra/k8s/${source}`,
    destination: `components/livekit-egress/infra/k8s/${destination}`
  })),
  ...[
    'README.md',
    'apply-overlay.mjs',
    'build.sh',
    'server-hook.go'
  ].map((name) => ({
    source: `infra/ivekit/tinode/${name}`,
    destination: `deploy/tinode-fork/${name}`
  })),
  {
    source: 'infra/ivekit/tinode/patches/tinode-ivekit-session-fanout-hot-path.patch',
    destination: 'deploy/tinode-fork/patches/tinode-ivekit-session-fanout-hot-path.patch'
  },
  ...[
    'README.md',
    'apply-overlay.mjs',
    'build.sh',
    'Dockerfile',
    'Dockerfile.dockerignore',
    'server-hook.rs'
  ].map((name) => ({
    source: `infra/ivekit/rustdesk-server/${name}`,
    destination: `deploy/rustdesk-server-fork/${name}`
  })),
  {
    source: 'infra/ivekit/rustdesk-server/patches/rustdesk-server-ivekit-relay-hot-path.patch',
    destination: 'deploy/rustdesk-server-fork/patches/rustdesk-server-ivekit-relay-hot-path.patch'
  },
  ...['relay-hot-path.rs', 'run.sh'].map((name) => ({
    source: `infra/ivekit/rustdesk-server/bench/${name}`,
    destination: `deploy/rustdesk-server-fork/bench/${name}`
  })),
  {
    source: 'scripts/ivekit-rustdesk-owner-binding.ts',
    destination: 'deploy/rustdesk-server-fork/ivekit-rustdesk-owner-binding.ts'
  },
  {
    source: 'src/agent-runtime/ivekit/placement/rustdesk-owner-binding.ts',
    destination: 'fork-hooks/rustdesk-server/rustdesk-owner-binding.ts'
  },
  {
    source: 'services/ivekit-service/acceptance/rustpbx-router.py',
    destination: 'acceptance/rustpbx/router.py'
  },
  ...[
    'answer-bye-uac.xml',
    'answer-bye-uas.xml',
    'busy-486-uas.xml',
    'delayed-busy-486-uas.xml',
    'early-cancel-uac.xml',
    'early-cancel-uas.xml',
    'expect-486-uac.xml',
    'expect-487-timeout-uac.xml',
    'expect-503-uac.xml',
    'inbound-reject-486-uac.xml',
    'no-answer-uas.xml',
    'options-uas.xml',
    'register-digest-uac.xml',
    'register-invalid-digest-uac.xml',
    'unavailable-503-uas.xml'
  ].map((name) => ({
    source: `services/ivekit-service/acceptance/sipp/${name}`,
    destination: `acceptance/rustpbx/sipp/${name}`
  })),
  {
    source: 'scripts/ivekit-controlled-provider.ts',
    destination: 'acceptance/tools/ivekit-controlled-provider.ts'
  },
  {
    source: 'scripts/ivekit-controlled-voice-provider.ts',
    destination: 'acceptance/tools/ivekit-controlled-voice-provider.ts'
  },
  {
    source: 'scripts/ivekit-voice-acceptance.ts',
    destination: 'acceptance/tools/ivekit-voice-acceptance.ts'
  },
  {
    source: 'scripts/ivekit-v5-controlled-acceptance.ts',
    destination: 'acceptance/tools/ivekit-v5-controlled-acceptance.ts'
  },
  {
    source: 'scripts/ivekit-v6-real-acceptance.ts',
    destination: 'acceptance/tools/ivekit-v6-real-acceptance.ts'
  },
  ...[
    'rustdesk-edge-agent.ts',
    'rustdesk-edge-command.ts',
    'rustdesk-edge-pending-store.ts',
    'rustdesk-owner-epoch-fence.ts',
    'rustdesk-edge-observation-contract.ts',
    'rustdesk-observation-spool.ts',
    'rustdesk-observation-bridge.ts',
    'rustdesk-evidence-uploader.ts',
    'rustdesk-native-evidence-correlator.ts',
    'rustdesk-native-evidence-policy.ts',
    'rustdesk-native-evidence-watcher.ts'
  ].map((name) => ({ source: `scripts/${name}`, destination: `edge/src/${name}` })),
  ...[
    'rustdesk-windows-package.ts',
    'rustdesk-windows-capability-policy.ts'
  ].map((name) => ({ source: `scripts/${name}`, destination: `edge/build/${name}` })),
  ...[
    'Deploy-IveKitRustDesk.ps1',
    'Invoke-IveKitRustDeskSessionDisconnect.ps1',
    'IveKitRustDeskEdge.xml.template',
    'Publish-IveKitRustDeskEvidence.ps1',
    'Resolve-IveKitRustDeskSession.ps1'
  ].map((name) => ({ source: `scripts/rustdesk-windows/${name}`, destination: `edge/windows/${name}` })),
  ...[
    'README.md',
    'apply-overlay.d.ts',
    'apply-overlay.mjs',
    'ivekit_native_control.rs',
    'ivekit_native_evidence.rs'
  ].map((name) => ({ source: `integrations/rustdesk-1.4.7/${name}`, destination: `edge/rustdesk-1.4.7/${name}` })),
  ...[
    'linux-disconnect.sh',
    'linux-restart.sh',
    'macos-disconnect.sh',
    'macos-restart.sh',
    'windows-disconnect.ps1',
    'windows-restart.ps1'
  ].map((name) => ({ source: `scripts/rustdesk-edge-adapters/${name}`, destination: `edge/adapters/${name}` })),
  { source: 'services/rustdesk-edge-agent/package.json', destination: 'edge/package.json' },
  { source: 'services/rustdesk-edge-agent/package-lock.json', destination: 'edge/package-lock.json' },
  { source: 'services/rustdesk-edge-agent/README.md', destination: 'edge/README.md' }
] as const;

const DELIVERY_ROOT_MARKER = '.ivekit-delivery-root';
const RUSTPBX_ACCEPTANCE_GENERATED_FILES = [
  'acceptance/rustpbx/package.json',
  'acceptance/rustpbx/package-lock.json',
  'acceptance/rustpbx/scripts/ivekit-rustpbx-management-acceptance.js',
  'acceptance/rustpbx/scripts/ivekit-rustpbx-rwi-acceptance.js',
  'acceptance/rustpbx/scripts/ivekit-rustpbx-sipp-acceptance.js',
  'acceptance/rustpbx/src/agent-runtime/ivekit/voice/adapters/rustpbx-management.js',
  'acceptance/rustpbx/src/agent-runtime/ivekit/voice/adapters/rustpbx-rwi.js',
  'acceptance/rustpbx/src/agent-runtime/ivekit/voice/canonical.js',
  'acceptance/rustpbx/src/agent-runtime/ivekit/voice/capabilities.js',
  'acceptance/rustpbx/src/agent-runtime/ivekit/voice/errors.js',
  'acceptance/rustpbx/src/agent-runtime/ivekit/voice/ports.js',
  'acceptance/rustpbx/src/agent-runtime/ivekit/voice/secret-resolver.js',
  'acceptance/rustpbx/src/agent-runtime/ivekit/voice/types.js',
  'acceptance/rustpbx/src/db-pg.js',
  'acceptance/rustpbx/src/postgres-migrations.js'
] as const;
const GENERATED_FILES = new Set([
  DELIVERY_ROOT_MARKER,
  'README.md',
  'acceptance/provider-profiles.example.json',
  'acceptance/status.json',
  'acceptance/v6-real-template.json',
  'acceptance/voice-real-template.json',
  'acceptance/voice-real-runbook.md',
  ...RUSTPBX_ACCEPTANCE_GENERATED_FILES,
  'operations/release-contract.json',
  'operations/stage2-deployment-evidence.json',
  'operations/upgrade-runbook.md',
  'manifest.json',
  'SHA256SUMS'
]);
const SECRET_PATTERNS = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/,
  /\bBearer\s+eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/
];
const TEXT_EXTENSIONS = new Set([
  '', '.conf', '.css', '.html', '.js', '.json', '.lock', '.md', '.mjs', '.patch', '.ps1', '.py', '.sh', '.sql', '.toml', '.ts', '.txt', '.xml', '.yaml', '.yml'
]);

const REAL_ENVIRONMENT_ACCEPTANCE = {
  livekit: 'not_run',
  tinode: 'not_run',
  rustdesk: 'not_run',
  rustpbx: 'not_run',
  ocr: 'not_run',
  asr: 'not_run',
  quality_review: 'not_run',
  translation: 'not_run',
  notification_providers: 'not_run',
  file_security: 'not_run',
  public_webhook: 'not_run',
  kubernetes: 'not_run',
  backup_restore: 'not_run'
} as const;

const CONTROLLED_ENVIRONMENT_ACCEPTANCE = {
  postgres: 'not_run',
  provider_protocol: 'not_run',
  browser: 'not_run',
  restart_recovery: 'not_run',
  full_chain: 'not_run'
} as const;

const CONTROLLED_ACCEPTANCE_KEYS = [
  'postgres',
  'provider_protocol',
  'browser',
  'restart_recovery',
  'full_chain'
] as const;

const KNOWN_NOT_RUN: readonly IveKitKnownNotRun[] = [
  { id: 'real_livekit_clients', status: 'not_run', reason: 'Current release requires fresh real browser media and Egress evidence.' },
  { id: 'real_tinode_clients', status: 'not_run', reason: 'Current release requires fresh real Tinode multi-client evidence.' },
  { id: 'real_rustdesk_clients', status: 'not_run', reason: 'Current release requires fresh physical RustDesk client evidence.' },
  { id: 'real_rustpbx', status: 'not_run', reason: 'Current release requires fresh real RustPBX SIP, media, RWI, and webhook evidence.' },
  { id: 'real_ocr_vendor', status: 'not_run', reason: 'No production OCR vendor, credentials, quota, or accuracy corpus is selected.' },
  { id: 'real_asr_vendor', status: 'not_run', reason: 'No production ASR vendor, credentials, quota, or accuracy corpus is selected.' },
  { id: 'real_quality_vendor', status: 'not_run', reason: 'No production AI quality vendor, credentials, or evaluation corpus is selected.' },
  { id: 'real_translation_vendor', status: 'not_run', reason: 'No production translation vendor, credentials, quota, or evaluation corpus is selected.' },
  { id: 'real_notification_providers', status: 'not_run', reason: 'Commercial SMTP, email, SMS providers and delivery receipts require target credentials and network validation.' },
  { id: 'real_file_security', status: 'not_run', reason: 'Production object storage, ClamAV signatures, media tools, quarantine and large resumable uploads require target infrastructure.' },
  { id: 'real_public_webhook', status: 'not_run', reason: 'Public DNS, TLS, receiver availability and retry behavior require a deployed external Webhook endpoint.' },
  { id: 'real_kubernetes', status: 'not_run', reason: 'Target Kubernetes rollout, autoscaling, multi-instance failover and monitoring discovery have not been executed.' },
  { id: 'real_backup_restore', status: 'not_run', reason: 'A source-bound backup and destructive isolated restore drill must run against target PostgreSQL and object storage.' }
] as const;

const CAPABILITY_MATRIX: readonly IveKitDeliveryCapability[] = [
  { id: 'intelligence_and_translation', stage: 1, delivery_status: 'included', contract: 'OCR, ASR, quality review, anti-circumvention and translation with governed Provider routing', real_environment_gates: ['ocr', 'asr', 'quality_review', 'translation'] },
  { id: 'im_and_sessions', stage: 2, delivery_status: 'included', contract: 'Tinode-backed IM, sync, receipts, presence, attachments and durable session state', real_environment_gates: ['tinode'] },
  { id: 'livekit_media', stage: 2, delivery_status: 'included', contract: 'LiveKit audio, video, screen sharing, recording, TURN, QoS and reconnect recovery', real_environment_gates: ['livekit'] },
  { id: 'file_security', stage: 2, delivery_status: 'included', contract: 'MIME detection, malware quarantine, derivatives, multipart upload and cleanup', real_environment_gates: ['file_security'] },
  { id: 'rustdesk_remote_assistance', stage: 3, delivery_status: 'included', contract: 'Windows authorization, control, clipboard, files, multi-display, recording, disconnect and audit', real_environment_gates: ['rustdesk'] },
  { id: 'voice_ivr_contact_center', stage: 4, delivery_status: 'included', contract: 'RustPBX, SIP, IVR, WebPhone, call control and reusable contact-center primitives', real_environment_gates: ['rustpbx'] },
  { id: 'notifications', stage: 4, delivery_status: 'included', contract: 'In-app, signed Webhook, email and SMS durable notification delivery without mobile push', real_environment_gates: ['notification_providers'] },
  { id: 'provider_governance', stage: 4, delivery_status: 'included', contract: 'Health, quota, circuit breaking, fallback and failover across external Providers', real_environment_gates: ['ocr', 'asr', 'quality_review', 'translation', 'notification_providers'] },
  { id: 'security_and_operations', stage: 4, delivery_status: 'included', contract: 'Authorization, immutable audit, rate limit, retention, monitoring, backup and multi-instance deployment', real_environment_gates: ['kubernetes', 'backup_restore'] },
  { id: 'integration_events', stage: 5, delivery_status: 'included', contract: 'HTTP replay, WebSocket, signed event Webhooks, SDK verifier and durable receiver inbox contract', real_environment_gates: ['public_webhook'] },
  { id: 'standalone_delivery', stage: 5, delivery_status: 'included', contract: 'Product-neutral API, SDK, OpenAPI, deployment, migration, acceptance and LED handoff documentation', real_environment_gates: ['kubernetes'] }
] as const;

const CONTROLLED_PROVIDER_PROFILES = [
  ['ocr', 'OPC_IVEKIT_OCR_TOKEN', '/v1/ocr'],
  ['asr', 'OPC_IVEKIT_ASR_TOKEN', '/v1/asr'],
  ['quality_review', 'OPC_IVEKIT_QUALITY_TOKEN', '/v1/quality-review'],
  ['translation', 'OPC_IVEKIT_TRANSLATION_TOKEN', '/v1/translate']
].map(([capability, tokenEnv, endpoint]) => ({
  id: `controlled-${capability.replace('_', '-')}`,
  capability,
  mode: 'self_hosted',
  base_url: 'http://controlled-intelligence-provider:8790',
  endpoint,
  health_endpoint: '/health',
  token_env: tokenEnv,
  timeout_ms: 30_000,
  name: `controlled-${capability.replace('_', '-')}`
}));

export function loadControlledAcceptancePackage(
  inputDir: string,
  sourceCommit: string
): LoadedControlledAcceptancePackage {
  const root = resolve(inputDir);
  assertIveKitDeliverySourceState(sourceCommit, '');
  requireDirectory(root, 'controlled acceptance package');
  assertNoSymlinks(root);
  const reportPath = join(root, 'report.json');
  requireFile(reportPath, 'controlled acceptance report');
  const report = JSON.parse(readFileSync(reportPath, 'utf8')) as {
    schema_version?: unknown;
    product?: unknown;
    foundation_version?: unknown;
    source_commit?: unknown;
    controlled_tests_are_real_vendor_evidence?: unknown;
    controlled_environment?: unknown;
    evidence?: unknown;
    real_environment?: unknown;
  };
  if (report.schema_version !== 1 || report.product !== 'iveKit') {
    throw new Error('invalid controlled acceptance report');
  }
  if (report.source_commit !== sourceCommit) {
    throw new Error('controlled acceptance source commit mismatch');
  }
  if (report.controlled_tests_are_real_vendor_evidence !== false || report.real_environment !== undefined) {
    throw new Error('controlled acceptance cannot claim real vendor evidence');
  }
  if (!isRecord(report.controlled_environment)) {
    throw new Error('controlled acceptance checks are missing');
  }
  const checkKeys = Object.keys(report.controlled_environment).sort();
  if (JSON.stringify(checkKeys) !== JSON.stringify([...CONTROLLED_ACCEPTANCE_KEYS].sort())) {
    throw new Error('controlled acceptance checks are incomplete');
  }

  const evidenceDir = join(root, 'evidence');
  requireDirectory(evidenceDir, 'controlled acceptance evidence');
  const actualFiles = readdirSync(evidenceDir).sort();
  for (const name of actualFiles) {
    const path = join(evidenceDir, name);
    if (lstatSync(path).isSymbolicLink() || !statSync(path).isFile()) {
      throw new Error(`controlled acceptance evidence must be a regular file: ${name}`);
    }
    if (!/^[a-z0-9][a-z0-9._-]{0,127}\.(?:json|log|md|png|txt)$/.test(name)) {
      throw new Error(`controlled acceptance evidence path is invalid: ${name}`);
    }
  }
  if (!Array.isArray(report.evidence)) throw new Error('controlled acceptance evidence manifest is missing');
  const evidence = report.evidence as Array<{ path?: unknown; bytes?: unknown; sha256?: unknown }>;
  const evidencePaths = evidence.map((entry) => String(entry.path || ''));
  if (new Set(evidencePaths).size !== evidencePaths.length ||
      JSON.stringify([...evidencePaths].sort()) !== JSON.stringify(actualFiles)) {
    throw new Error('controlled acceptance evidence file list mismatch');
  }
  let totalBytes = 0;
  const verifiedEvidence: IveKitControlledAcceptanceEvidence[] = [];
  for (const entry of evidence) {
    const path = String(entry.path || '');
    const absolute = join(evidenceDir, path);
    const bytes = statSync(absolute).size;
    totalBytes += bytes;
    if (bytes < 1 || bytes > 10_485_760 || totalBytes > 26_214_400) {
      throw new Error('controlled acceptance evidence size is invalid');
    }
    if (Number(entry.bytes) !== bytes || String(entry.sha256 || '') !== sha256(absolute)) {
      throw new Error(`controlled acceptance evidence checksum mismatch: ${path}`);
    }
    verifiedEvidence.push({ path, bytes, sha256: String(entry.sha256) });
  }

  const evidenceSet = new Set(evidencePaths);
  const referenced = new Set<string>();
  const statuses = {} as IveKitDeliveryManifest['controlled_environment_acceptance'];
  const checks = {} as LoadedControlledAcceptancePackage['checks'];
  for (const key of CONTROLLED_ACCEPTANCE_KEYS) {
    const raw = report.controlled_environment[key];
    if (!isRecord(raw) || (raw.status !== 'passed' && raw.status !== 'not_run') || !Array.isArray(raw.evidence)) {
      throw new Error(`controlled acceptance check is invalid: ${key}`);
    }
    const names = raw.evidence.map((value) => String(value));
    if (new Set(names).size !== names.length || names.some((name) => !evidenceSet.has(name))) {
      throw new Error(`controlled acceptance evidence reference is invalid: ${key}`);
    }
    if ((raw.status === 'passed' && names.length === 0) || (raw.status === 'not_run' && names.length !== 0)) {
      throw new Error(`controlled acceptance evidence state is invalid: ${key}`);
    }
    for (const name of names) referenced.add(name);
    statuses[key] = raw.status;
    checks[key] = { status: raw.status, evidence: names };
  }
  if (referenced.size !== evidenceSet.size) {
    throw new Error('controlled acceptance contains unreferenced evidence');
  }
  return { root, statuses, checks, evidence: verifiedEvidence };
}

function emptyControlledAcceptancePackage(): LoadedControlledAcceptancePackage {
  const statuses = { ...CONTROLLED_ENVIRONMENT_ACCEPTANCE };
  return {
    root: '',
    statuses,
    checks: {
      postgres: { status: statuses.postgres, evidence: [] },
      provider_protocol: { status: statuses.provider_protocol, evidence: [] },
      browser: { status: statuses.browser, evidence: [] },
      restart_recovery: { status: statuses.restart_recovery, evidence: [] },
      full_chain: { status: statuses.full_chain, evidence: [] }
    },
    evidence: []
  };
}

function controlledAcceptanceStatus(
  statuses: IveKitDeliveryManifest['controlled_environment_acceptance']
): 'not_run' | 'partial' | 'passed' {
  const passed = Object.values(statuses).filter((status) => status === 'passed').length;
  return passed === 0 ? 'not_run' : passed === CONTROLLED_ACCEPTANCE_KEYS.length ? 'passed' : 'partial';
}

export function buildIveKitDeliveryBundle(
  options: BuildIveKitDeliveryBundleOptions
): { outputDir: string; manifest: IveKitDeliveryManifest } {
  const repoRoot = resolve(options.repoRoot);
  const outputDir = resolve(options.outputDir);
  const sourceCommit = options.sourceCommit || resolveSourceCommit(repoRoot);
  assertIveKitDeliverySourceState(sourceCommit, '');
  const generatedAt = options.generatedAt || new Date().toISOString();
  const controlledAcceptance = options.controlledAcceptanceDir
    ? loadControlledAcceptancePackage(options.controlledAcceptanceDir, sourceCommit)
    : emptyControlledAcceptancePackage();
  assertSafeOutputDirectory(repoRoot, outputDir);
  requireFile(options.sdkTarball, 'SDK tarball');
  requireDirectory(options.clientDist, 'reference client dist');

  assertReplaceableOutputDirectory(outputDir);
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(join(outputDir, DELIVERY_ROOT_MARKER), 'ivekit-delivery-bundle-v1\n', 'utf8');

  for (const entry of DELIVERY_SOURCE_FILES) {
    const source = resolveInside(repoRoot, entry.source);
    requireFile(source, `delivery source ${entry.source}`);
    copyDeliverySource(outputDir, source, entry.destination);
  }
  const edgeStaging = mkdtempSync(join(tmpdir(), 'ivekit-delivery-edge-'));
  try {
    run('npx', [
      'tsc',
      '--outDir', edgeStaging,
      '--rootDir', 'scripts',
      '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext',
      '--target', 'ES2022',
      '--types', 'node',
      '--skipLibCheck',
      'scripts/rustdesk-edge-agent.ts',
      'scripts/rustdesk-edge-command.ts',
      'scripts/rustdesk-edge-pending-store.ts',
      'scripts/rustdesk-owner-epoch-fence.ts',
      'scripts/rustdesk-edge-observation-contract.ts',
      'scripts/rustdesk-observation-spool.ts',
      'scripts/rustdesk-observation-bridge.ts',
      'scripts/rustdesk-evidence-uploader.ts',
      'scripts/rustdesk-native-evidence-correlator.ts',
      'scripts/rustdesk-native-evidence-policy.ts',
      'scripts/rustdesk-native-evidence-watcher.ts'
    ], repoRoot);
    for (const name of [
      'rustdesk-edge-agent.js',
      'rustdesk-edge-command.js',
      'rustdesk-edge-pending-store.js',
      'rustdesk-owner-epoch-fence.js',
      'rustdesk-edge-observation-contract.js',
      'rustdesk-observation-spool.js',
      'rustdesk-observation-bridge.js',
      'rustdesk-evidence-uploader.js',
      'rustdesk-native-evidence-correlator.js',
      'rustdesk-native-evidence-policy.js',
      'rustdesk-native-evidence-watcher.js'
    ]) copyFile(outputDir, join(edgeStaging, name), `edge/dist/${name}`);
  } finally {
    rmSync(edgeStaging, { recursive: true, force: true });
  }
  const rustPbxAcceptanceStaging = mkdtempSync(join(tmpdir(), 'ivekit-delivery-rustpbx-acceptance-'));
  try {
    run('npx', [
      'tsc',
      '--outDir', rustPbxAcceptanceStaging,
      '--rootDir', '.',
      '--module', 'NodeNext',
      '--moduleResolution', 'NodeNext',
      '--target', 'ES2022',
      '--types', 'node',
      '--skipLibCheck',
      'scripts/ivekit-rustpbx-management-acceptance.ts',
      'scripts/ivekit-rustpbx-rwi-acceptance.ts',
      'scripts/ivekit-rustpbx-sipp-acceptance.ts'
    ], repoRoot);
    cpSync(rustPbxAcceptanceStaging, join(outputDir, 'acceptance', 'rustpbx'), {
      recursive: true,
      dereference: false
    });
    const acceptancePackage = {
      name: 'ivekit-rustpbx-acceptance',
      version: '1.0.0',
      private: true,
      type: 'module',
      dependencies: { ws: '8.21.0' },
      scripts: {
        management: 'node scripts/ivekit-rustpbx-management-acceptance.js',
        rwi: 'node scripts/ivekit-rustpbx-rwi-acceptance.js',
        sipp: 'node scripts/ivekit-rustpbx-sipp-acceptance.js'
      }
    };
    writeFileSync(
      join(outputDir, 'acceptance', 'rustpbx', 'package.json'),
      `${JSON.stringify(acceptancePackage, null, 2)}\n`,
      'utf8'
    );
    const repositoryLock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, Record<string, unknown>>;
    };
    const lockedWs = repositoryLock.packages?.['node_modules/ws'];
    if (lockedWs?.version !== '8.21.0' || typeof lockedWs.integrity !== 'string') {
      throw new Error('repository package lock does not pin ws@8.21.0');
    }
    writeFileSync(
      join(outputDir, 'acceptance', 'rustpbx', 'package-lock.json'),
      `${JSON.stringify({
        name: acceptancePackage.name,
        version: acceptancePackage.version,
        lockfileVersion: 3,
        requires: true,
        packages: {
          '': {
            name: acceptancePackage.name,
            version: acceptancePackage.version,
            dependencies: acceptancePackage.dependencies
          },
          'node_modules/ws': lockedWs
        }
      }, null, 2)}\n`,
      'utf8'
    );
  } finally {
    rmSync(rustPbxAcceptanceStaging, { recursive: true, force: true });
  }

  cpSync(options.clientDist, join(outputDir, 'client'), { recursive: true, dereference: false });
  copyFile(outputDir, options.sdkTarball, `sdk/${basename(options.sdkTarball)}`);
  const serviceStaging = mkdtempSync(join(tmpdir(), 'ivekit-delivery-service-'));
  try {
    const contextDir = join(serviceStaging, 'build-context');
    const context = buildIveKitStandaloneContext({
      repoRoot,
      outputDir: contextDir,
      sourceCommit,
      generatedAt
    });
    cpSync(contextDir, join(outputDir, 'service', 'build-context'), {
      recursive: true,
      dereference: false
    });
    const migrations = context.manifest.files
      .filter((entry) => entry.path.startsWith('migrations/'))
      .map((entry) => ({
        version: basename(entry.path, '.sql').split('_', 1)[0],
        file: basename(entry.path),
        bytes: entry.bytes,
        sha256: entry.sha256
      }));
    writeFileSync(join(outputDir, 'service', 'migration-manifest.json'), `${JSON.stringify({
      schema_version: 1,
      source_commit: sourceCommit,
      migrations
    }, null, 2)}\n`, 'utf8');
  } finally {
    rmSync(serviceStaging, { recursive: true, force: true });
  }
  const imageDigest = validatedImageDigest(options.imageDigest);
  writeFileSync(join(outputDir, 'service', 'image-metadata.json'), `${JSON.stringify({
    schema_version: 1,
    source_commit: sourceCommit,
    reference: String(options.imageReference || `ivekit-service:${sourceCommit.slice(0, 12)}`).trim(),
    digest: imageDigest,
    status: imageDigest ? 'digest_pinned' : 'build_required',
    build_context: 'service/build-context/'
  }, null, 2)}\n`, 'utf8');
  mkdirSync(join(outputDir, 'operations'), { recursive: true });
  const stage2Evidence = createIveKitStage2ReleaseEvidence({
    sourceCommit,
    generatedAt,
    imageDigest,
    migrations: [
      '061_ivekit_file_security.sql',
      '062_tinode_file_delivery_operations.sql',
      '063_livekit_media_quality.sql'
    ].map((file) => ({ file, sha256: sha256(join(outputDir, 'database', 'migrations', file)) })),
    configurationArtifacts: [
      ...['deploy/livekit/env.example', 'deploy/livekit/docker-compose.yml'].map((path) => ({
        profile: 'livekit_turn' as const,
        path,
        sha256: sha256(join(outputDir, path))
      })),
      ...[
        'deploy/livekit/docker-compose.yml',
        'deploy/livekit/docker-compose.storage.yml',
        'deploy/livekit/env.example',
        'components/livekit-egress/infra/ivekit/livekit-egress/README.md',
        'components/livekit-egress/infra/ivekit/livekit-egress/apply-overlay.mjs',
        'components/livekit-egress/infra/ivekit/livekit-egress/build.sh',
        'components/livekit-egress/infra/ivekit/livekit-egress/ivekit_metrics.go',
        'components/livekit-egress/integrations/livekit-egress-v1.13.0/go.mod',
        'components/livekit-egress/integrations/livekit-egress-v1.13.0/policy.go',
        'components/livekit-egress/integrations/livekit-egress-v1.13.0/policy_test.go',
        'components/livekit-egress/infra/k8s/Chart.yaml',
        'components/livekit-egress/infra/k8s/values.yaml',
        'components/livekit-egress/infra/k8s/templates/_helpers.tpl',
        'components/livekit-egress/infra/k8s/templates/livekit-egress-deployment.yaml'
      ].map((path) => ({
        profile: 'livekit_egress' as const,
        path,
        sha256: sha256(join(outputDir, path))
      })),
      ...[
        'deploy/application/docker-compose.yml',
        'deploy/application/env.example',
        'deploy/kubernetes/ivekit/values.yaml',
        'deploy/kubernetes/ivekit/templates/deployment.yaml',
        'deploy/kubernetes/ivekit/templates/clamav.yaml'
      ].map((path) => ({
        profile: 'file_security' as const,
        path,
        sha256: sha256(join(outputDir, path))
      }))
    ]
  });
  writeFileSync(
    join(outputDir, 'operations', 'stage2-deployment-evidence.json'),
    `${JSON.stringify(stage2Evidence, null, 2)}\n`,
    'utf8'
  );
  const releaseOperations = createIveKitReleaseOperations({
    sourceCommit,
    generatedAt,
    imageReference: String(options.imageReference || `ivekit-service:${sourceCommit.slice(0, 12)}`).trim(),
    imageDigest,
    imageMetadataSha256: sha256(join(outputDir, 'service', 'image-metadata.json')),
    migrationManifestSha256: sha256(join(outputDir, 'service', 'migration-manifest.json')),
    stage2EvidenceSha256: sha256(join(outputDir, 'operations', 'stage2-deployment-evidence.json')),
    stage2ReleaseFingerprint: stage2Evidence.release_fingerprint_sha256
  });
  writeFileSync(
    join(outputDir, 'operations', 'release-contract.json'),
    `${JSON.stringify(releaseOperations.contract, null, 2)}\n`,
    'utf8'
  );
  writeFileSync(
    join(outputDir, 'operations', 'upgrade-runbook.md'),
    releaseOperations.runbook,
    'utf8'
  );
  const sbom = JSON.parse(run(
    'npm',
    ['sbom', '--package-lock-only', '--sbom-format', 'spdx'],
    join(repoRoot, 'services', 'ivekit-service')
  )) as Record<string, unknown>;
  writeFileSync(join(outputDir, 'service', 'sbom.spdx.json'), `${JSON.stringify(sbom, null, 2)}\n`, 'utf8');
  writeFileSync(join(outputDir, 'README.md'), renderBundleReadme(), 'utf8');
  mkdirSync(join(outputDir, 'acceptance'), { recursive: true });
  if (controlledAcceptance.evidence.length) {
    const evidenceDir = join(outputDir, 'acceptance', 'evidence');
    mkdirSync(evidenceDir, { recursive: true });
    for (const entry of controlledAcceptance.evidence) {
      copyFileSync(
        join(controlledAcceptance.root, 'evidence', entry.path),
        join(evidenceDir, entry.path)
      );
    }
  }
  writeFileSync(
    join(outputDir, 'acceptance', 'provider-profiles.example.json'),
    `${JSON.stringify(CONTROLLED_PROVIDER_PROFILES, null, 2)}\n`,
    'utf8'
  );
  writeFileSync(
    join(outputDir, 'acceptance', 'voice-real-template.json'),
    `${JSON.stringify(createIveKitVoiceAcceptanceTemplate({
      runId: 'replace-with-run-id',
      environmentId: 'replace-with-environment-id',
      deploymentMode: 'standalone-compose',
      deployedCommit: sourceCommit,
      deploymentFingerprint: 'replace-with-deployment-sha256',
      operator: 'replace-with-operator',
      qaApprover: 'replace-with-independent-qa',
      runStartedAt: '',
      checkedAt: ''
    }), null, 2)}\n`,
    'utf8'
  );
  writeFileSync(
    join(outputDir, 'acceptance', 'voice-real-runbook.md'),
    renderIveKitVoiceAcceptanceRunbook(),
    'utf8'
  );
  writeFileSync(
    join(outputDir, 'acceptance', 'v6-real-template.json'),
    `${JSON.stringify(createIveKitV6RealAcceptanceTemplate({
      source_commit: sourceCommit,
      generated_at: generatedAt
    }), null, 2)}\n`,
    'utf8'
  );
  writeFileSync(join(outputDir, 'acceptance', 'status.json'), `${JSON.stringify({
    schema_version: 2,
    product: 'iveKit',
    foundation_version: 'V5',
    source_commit: sourceCommit,
    generated_at: generatedAt,
    status: controlledAcceptanceStatus(controlledAcceptance.statuses),
    controlled_environment: controlledAcceptance.statuses,
    controlled_checks: controlledAcceptance.checks,
    evidence: controlledAcceptance.evidence,
    real_environment: REAL_ENVIRONMENT_ACCEPTANCE,
    capability_matrix: CAPABILITY_MATRIX,
    known_not_run: KNOWN_NOT_RUN,
    reason: controlledAcceptance.evidence.length
      ? 'Controlled acceptance passed only for checks bound to packaged evidence; real providers and clients remain not_run.'
      : 'Controlled and real provider acceptance must be executed in the target environment.',
    controlled_tests_are_real_vendor_evidence: false
  }, null, 2)}\n`, 'utf8');

  assertNoSymlinks(outputDir);
  scanForSecrets(outputDir);

  const payloadFiles = listDeliveryFiles(outputDir);
  const manifest: IveKitDeliveryManifest = {
    schema_version: 1,
    product: 'iveKit',
    foundation_version: 'V5',
    status: 'ready_for_handoff',
    source_commit: sourceCommit,
    generated_at: generatedAt,
    contents: {
      sdk: 'sdk/',
      reference_client: 'client/',
      deployment: 'deploy/',
      database: 'database/migrations/',
      documentation: 'docs/',
      acceptance: 'acceptance/status.json',
      provider_profiles: 'acceptance/provider-profiles.example.json',
      operations: 'docs/ivekit-v3-intelligence-operations.md',
      release_operations: 'operations/upgrade-runbook.md',
      completion_audit: 'docs/ivekit-v3-completion-audit.md',
      intelligence_preflight: 'service/build-context/src/ivekit-intelligence-preflight.ts',
      voice_preflight: 'service/build-context/src/ivekit-voice-preflight.ts',
      voice_compose: 'service/build-context/docker-compose.voice.yml',
      voice_helm: 'deploy/kubernetes/ivekit/',
      voice_acceptance_template: 'acceptance/voice-real-template.json',
      voice_acceptance_runbook: 'acceptance/voice-real-runbook.md',
      v6_real_acceptance_template: 'acceptance/v6-real-template.json',
      rustpbx_image_build: 'deploy/rustpbx/',
      rustpbx_acceptance: 'acceptance/rustpbx/',
      capacity_runtime: 'capacity-runtime/',
      service_source: 'service/build-context/'
    },
    artifacts: {
      sdk_package: {
        path: `sdk/${basename(options.sdkTarball)}`,
        sha256: sha256(join(outputDir, 'sdk', basename(options.sdkTarball)))
      },
      reference_client: {
        path: 'client/',
        tree_sha256: treeSha256(join(outputDir, 'client'))
      },
      service_build_context: {
        path: 'service/build-context/',
        manifest_sha256: sha256(join(outputDir, 'service', 'build-context', 'context-manifest.json'))
      },
      migration_manifest: {
        path: 'service/migration-manifest.json',
        sha256: sha256(join(outputDir, 'service', 'migration-manifest.json'))
      },
      image_metadata: {
        path: 'service/image-metadata.json',
        sha256: sha256(join(outputDir, 'service', 'image-metadata.json'))
      },
      sbom: {
        path: 'service/sbom.spdx.json',
        sha256: sha256(join(outputDir, 'service', 'sbom.spdx.json'))
      },
      acceptance_status: {
        path: 'acceptance/status.json',
        sha256: sha256(join(outputDir, 'acceptance', 'status.json'))
      },
      v6_real_acceptance_template: {
        path: 'acceptance/v6-real-template.json',
        sha256: sha256(join(outputDir, 'acceptance', 'v6-real-template.json'))
      },
      provider_profiles_example: {
        path: 'acceptance/provider-profiles.example.json',
        sha256: sha256(join(outputDir, 'acceptance', 'provider-profiles.example.json'))
      },
      release_contract: {
        path: 'operations/release-contract.json',
        sha256: sha256(join(outputDir, 'operations', 'release-contract.json'))
      },
      stage2_deployment_evidence: {
        path: 'operations/stage2-deployment-evidence.json',
        sha256: sha256(join(outputDir, 'operations', 'stage2-deployment-evidence.json'))
      },
      upgrade_runbook: {
        path: 'operations/upgrade-runbook.md',
        sha256: sha256(join(outputDir, 'operations', 'upgrade-runbook.md'))
      }
    },
    provider_ownership: {
      livekit: 'audio, video, rooms, screen share, recording and webhooks',
      tinode: 'instant messaging, topics, delivery and presence',
      rustdesk: 'native remote desktop transport and controlled operations',
      rustpbx: 'SIP and PSTN signaling, media, call control, CDR and telephony webhooks'
    },
    real_environment_acceptance: { ...REAL_ENVIRONMENT_ACCEPTANCE },
    controlled_environment_acceptance: { ...controlledAcceptance.statuses },
    capability_matrix: CAPABILITY_MATRIX.map((entry) => ({
      ...entry,
      real_environment_gates: [...entry.real_environment_gates]
    })),
    acceptance_matrix: {
      automated: {
        status: 'required_before_release',
        command: 'npm run verify:ivekit:foundation'
      },
      controlled: { ...controlledAcceptance.statuses },
      real_environment: { ...REAL_ENVIRONMENT_ACCEPTANCE }
    },
    known_not_run: KNOWN_NOT_RUN.map((entry) => ({ ...entry })),
    files: payloadFiles.map((path) => fileEntry(outputDir, path))
  };
  writeFileSync(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
  scanForSecrets(outputDir);

  const checksummedFiles = listDeliveryFiles(outputDir).filter((path) => path !== 'SHA256SUMS');
  writeFileSync(join(outputDir, 'SHA256SUMS'), checksummedFiles
    .map((path) => `${sha256(join(outputDir, path))}  ${path}`)
    .join('\n') + '\n', 'utf8');

  validateIveKitDeliveryBundle(outputDir);
  return { outputDir, manifest };
}

export function validateIveKitDeliveryBundle(outputDirInput: string): IveKitDeliveryManifest {
  const outputDir = resolve(outputDirInput);
  assertNoSymlinks(outputDir);
  const files = listDeliveryFiles(outputDir);
  for (const path of files) assertAllowedDeliveryPath(path);
  for (const required of GENERATED_FILES) {
    if (!files.includes(required)) throw new Error(`missing delivery file: ${required}`);
  }

  const manifest = JSON.parse(readFileSync(join(outputDir, 'manifest.json'), 'utf8')) as IveKitDeliveryManifest;
  if (manifest.schema_version !== 1 || manifest.product !== 'iveKit' ||
      manifest.foundation_version !== 'V5') {
    throw new Error('invalid iveKit delivery manifest');
  }
  if (JSON.stringify(manifest.capability_matrix) !== JSON.stringify(CAPABILITY_MATRIX)) {
    throw new Error('iveKit V5 capability matrix is incomplete');
  }
  if (Object.values(manifest.real_environment_acceptance).some((status) => status !== 'not_run')) {
    throw new Error('delivery generation cannot claim real-environment acceptance');
  }
  validateAcceptanceMetadata(outputDir, manifest);
  if (manifest.acceptance_matrix.automated.status !== 'required_before_release' ||
      manifest.acceptance_matrix.automated.command !== 'npm run verify:ivekit:foundation' ||
      JSON.stringify(manifest.acceptance_matrix.controlled) !==
        JSON.stringify(manifest.controlled_environment_acceptance) ||
      JSON.stringify(manifest.acceptance_matrix.real_environment) !==
        JSON.stringify(manifest.real_environment_acceptance)) {
    throw new Error('iveKit V5 acceptance matrix is incomplete');
  }
  validateVoiceAcceptanceAssets(outputDir, manifest);
  validateV6RealAcceptanceAsset(outputDir, manifest);
  const contextManifest = validateIveKitStandaloneContext(join(outputDir, 'service', 'build-context'));
  if (contextManifest.source_commit !== manifest.source_commit) {
    throw new Error('service build context source commit does not match delivery manifest');
  }
  validateArtifactBindings(outputDir, manifest);

  const payloadFiles = files.filter((path) => path !== 'manifest.json' && path !== 'SHA256SUMS');
  if (JSON.stringify(manifest.files.map((entry) => entry.path)) !== JSON.stringify(payloadFiles)) {
    throw new Error('manifest file list does not match delivery payload');
  }
  for (const entry of manifest.files) {
    const actual = fileEntry(outputDir, entry.path);
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) {
      throw new Error(`delivery checksum mismatch: ${entry.path}`);
    }
  }

  const expectedSums = files
    .filter((path) => path !== 'SHA256SUMS')
    .map((path) => `${sha256(join(outputDir, path))}  ${path}`)
    .join('\n') + '\n';
  if (readFileSync(join(outputDir, 'SHA256SUMS'), 'utf8') !== expectedSums) {
    throw new Error('SHA256SUMS does not match delivery files');
  }
  scanForSecrets(outputDir);
  return manifest;
}

export function listDeliveryFiles(root: string): string[] {
  const files: string[] = [];
  walk(resolve(root), resolve(root), files);
  return files.sort();
}

function prepareBundleFromCli(): { outputDir: string; manifest: IveKitDeliveryManifest } {
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const outputDir = resolve(process.env.OPC_IVEKIT_DELIVERY_DIR || join(repoRoot, '.tmp', 'ivekit-led-delivery'));
  const sourceCommit = resolveSourceCommit(repoRoot);
  assertIveKitDeliverySourceState(
    sourceCommit,
    run('git', ['status', '--porcelain=v1', '--untracked-files=all'], repoRoot)
  );
  const stagingDir = mkdtempSync(join(tmpdir(), 'ivekit-delivery-build-'));
  try {
    run('npm', ['--prefix', 'sdk/ivekit', 'run', 'build'], repoRoot);
    run('npm', ['--prefix', 'clients/ivekit-reference', 'run', 'build'], repoRoot);
    const packed = run('npm', ['pack', './sdk/ivekit', '--json', '--pack-destination', stagingDir], repoRoot);
    const packResult = JSON.parse(packed) as Array<{ filename: string }>;
    const filename = packResult[0]?.filename;
    if (!filename) throw new Error('npm pack did not return an SDK filename');
    return buildIveKitDeliveryBundle({
      repoRoot,
      outputDir,
      sdkTarball: join(stagingDir, filename),
      clientDist: join(repoRoot, 'clients', 'ivekit-reference', 'dist'),
      imageReference: process.env.OPC_IVEKIT_DELIVERY_IMAGE_REFERENCE,
      imageDigest: process.env.OPC_IVEKIT_DELIVERY_IMAGE_DIGEST,
      controlledAcceptanceDir: process.env.OPC_IVEKIT_DELIVERY_CONTROLLED_ACCEPTANCE_DIR,
      sourceCommit
    });
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

export function assertIveKitDeliverySourceState(sourceCommit: string, porcelainStatus: string): void {
  if (!/^[a-f0-9]{40}$/.test(String(sourceCommit || '').trim())) {
    throw new Error('iveKit delivery source must be a full 40-character Git commit');
  }
  const changedEntries = String(porcelainStatus || '').split(/\r?\n/).filter(Boolean).length;
  if (changedEntries) {
    throw new Error(`iveKit delivery worktree is dirty (${changedEntries} entries)`);
  }
}

function renderBundleReadme(): string {
  return [
    '# iveKit LED Delivery Bundle',
    '',
    'This directory is a curated integration handoff for the reusable iveKit communication foundation.',
    'It contains the iveKit V5 shared communication foundation, not OPC or LED business logic, and it contains no credentials.',
    '',
    '## Contents',
    '',
    '- `sdk/`: installable `@opc/ivekit-sdk` npm package.',
    '- `client/`: production reference client static assets.',
    '- `deploy/application/`: standalone iveKit service Compose with PostgreSQL and optional RustPBX overlay.',
    '- `deploy/kubernetes/ivekit/`: standalone digest-pinned Helm Chart with a migration gate.',
    '- `deploy/livekit/`: separately deployable LiveKit media plane.',
    '- `components/livekit-egress/`: exact-source Egress overlay, local pool policy, image build script, and digest-only dual-pool Helm subset in repository-relative layout.',
    '- `deploy/rustpbx/`: pinned RustPBX/rsipstack source patches and reproducible native image build.',
    '- `database/migrations/`: ordered communication-domain overlay migrations used by the application image.',
    '- `docs/`: API, architecture, LED integration, roadmap and provider compatibility documents.',
    '- `examples/`: LED SDK, RustDesk, and signed event Webhook receiver examples.',
    '- `acceptance/status.json`: honest target-environment acceptance state.',
    '- `acceptance/evidence/`: optional source-bound controlled-environment evidence with verified hashes.',
    '- `acceptance/provider-profiles.example.json`: secret-free controlled Provider profiles.',
    '- `acceptance/tools/`: deterministic controlled Provider, Voice, and V5 full-chain acceptance sources.',
    '- `acceptance/voice-real-template.json`: source-bound, intentionally incomplete real Voice evidence template.',
    '- `acceptance/voice-real-runbook.md`: RustPBX/SIP/PSTN/RTP/IVR/bridge real-environment procedure.',
    '- `acceptance/v6-real-template.json`: source-bound eight-group real-environment matrix; every unexecuted group remains `not_run`.',
    '- `acceptance/rustpbx/`: compiled management, RWI/AMI, and SIPp acceptance runners, locked Node dependency, Router fixture, and SIP scenarios. Run `npm ci --omit=dev --ignore-scripts` in this directory before RWI acceptance.',
    '- `service/build-context/`: independently buildable iveKit service source context with its own package lock.',
    '- `service/migration-manifest.json`: ordered standalone migration checksums.',
    '- `service/image-metadata.json`: source-bound image reference/digest state.',
    '- `service/sbom.spdx.json`: npm dependency SBOM in SPDX 2.3 format.',
    '- `operations/release-contract.json`: source, image, migration, deployment and rollback contract.',
    '- `operations/stage2-deployment-evidence.json`: source/image/migration and TURN, Egress, file-security template fingerprints.',
    '- `operations/upgrade-runbook.md`: integrity-gated Compose and Helm upgrade/application rollback procedure.',
    '- `edge/`: RustDesk device agent source, crash-safe spool, package manifest, and OS adapter examples.',
    '',
    '## Integrity',
    '',
    '`manifest.json` records SHA-256 and size for every payload file. `SHA256SUMS` additionally covers the manifest.',
    'The checksum file intentionally cannot checksum itself.',
    '',
    '## Deployment boundary',
    '',
    'Build the iveKit image directly from `service/build-context/`; no OPC root checkout is required.',
    'The context and image metadata are bound to the same source commit recorded in `manifest.json`.',
    'The SQL files are application-owned overlay migrations and must be run by the image migration job in numeric order.',
    'Do not apply them to an unrelated schema without the foundation tables and RLS helpers documented in the integration guide.',
    'Migrations are forward-only. Application rollback may select a compatible prior immutable image; database rollback',
    'requires restoring a verified pre-upgrade backup and is never synthesized as a down migration.',
    'Track/Composite Egress requires the custom image built from `components/livekit-egress/`, an immutable image digest,',
    'and the exact Redis address/authentication/TLS settings used by the external LiveKit Server. The Helm subset fails',
    'closed when the custom digest or shared Redis address is missing; the upstream image does not implement pool fencing.',
    '',
    '## Acceptance',
    '',
    'A generated bundle is ready for engineering handoff, not production acceptance. Controlled PostgreSQL, Provider,',
    'browser, restart, and full-chain checks may be marked passed only when source-bound evidence is packaged and hash verified.',
    '`manifest.json` contains the complete V5 capability matrix; `included` never means real-environment passed.',
    'Controlled results remain separate from real LiveKit, Tinode, RustDesk, RustPBX, Provider, storage, Webhook, Kubernetes, and restore evidence.',
    'Every unexecuted surface remains `not_run`; controlled evidence never upgrades a real vendor result.',
    'RustPBX SIP acceptance requires an external SIPp 3.7.7 binary whose pinned SHA-256 is verified before execution.',
    ''
  ].join('\n');
}

function assertAllowedDeliveryPath(path: string): void {
  const fixed = new Set([
    ...DELIVERY_SOURCE_FILES.map((entry) => entry.destination),
    ...GENERATED_FILES
  ]);
  if (fixed.has(path)) return;
  if (/^acceptance\/evidence\/[a-z0-9][a-z0-9._-]{0,127}\.(?:json|log|md|png|txt)$/.test(path)) return;
  if (path.startsWith('client/') && path.length > 'client/'.length) return;
  if (/^sdk\/[^/]+\.tgz$/.test(path)) return;
  if (path.startsWith('service/build-context/') && path.length > 'service/build-context/'.length) return;
  if (/^edge\/dist\/(?:rustdesk-edge-(?:agent|command|pending-store|observation-contract)|rustdesk-owner-epoch-fence|rustdesk-observation-(?:spool|bridge)|rustdesk-evidence-uploader|rustdesk-native-evidence-(?:correlator|policy|watcher))\.js$/.test(path)) return;
  if (path === 'service/migration-manifest.json' || path === 'service/image-metadata.json' || path === 'service/sbom.spdx.json') return;
  throw new Error(`unexpected delivery file: ${path}`);
}

function assertSafeOutputDirectory(repoRoot: string, outputDir: string): void {
  if (outputDir === repoRoot || outputDir === resolve(repoRoot, '..') || outputDir === resolve('/')) {
    throw new Error('refusing unsafe iveKit delivery output directory');
  }
  for (const protectedPath of ['src', 'scripts', 'sdk', 'clients', 'docs', 'infra', 'test']) {
    const absolute = resolve(repoRoot, protectedPath);
    if (outputDir === absolute || absolute.startsWith(`${outputDir}${sep}`)) {
      throw new Error('refusing delivery output that contains repository source directories');
    }
  }
}

function assertReplaceableOutputDirectory(outputDir: string): void {
  if (!existsSync(outputDir)) return;
  const marker = join(outputDir, DELIVERY_ROOT_MARKER);
  if (!existsSync(marker) || !statSync(marker).isFile()) {
    throw new Error('refusing to replace an existing directory without the iveKit ownership marker');
  }
  if (readFileSync(marker, 'utf8') !== 'ivekit-delivery-bundle-v1\n') {
    throw new Error('refusing to replace a directory with an invalid iveKit ownership marker');
  }
}

function assertNoSymlinks(root: string): void {
  for (const path of listPaths(root)) {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`delivery symlink is not allowed: ${relative(root, path)}`);
  }
}

function scanForSecrets(root: string): void {
  for (const path of listDeliveryFiles(root)) {
    const extension = path.includes('.') ? path.slice(path.lastIndexOf('.')).toLowerCase() : '';
    if (!TEXT_EXTENSIONS.has(extension)) continue;
    const content = readFileSync(join(root, path), 'utf8');
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.test(content)) throw new Error(`secret material detected in delivery file: ${path}`);
    }
    if (basename(path) === 'env.example') scanExampleEnvironment(path, content);
    if (basename(path) === '.npmrc' && /(?:_authToken|_password)\s*=\s*[^\s$<{]/i.test(content)) {
      throw new Error(`secret material detected in delivery file: ${path}`);
    }
  }
}

function scanExampleEnvironment(path: string, content: string): void {
  const sensitiveName = /(?:PASSWORD|SECRET|TOKEN|API_KEY|ACCESS_KEY|PRIVATE_KEY|JWT)/;
  const safePlaceholder = /^(?:|replace[_-]with|change[_-]me|example|your[_-]|<|\$\{)/i;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const assignment = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (!assignment || !sensitiveName.test(assignment[1])) continue;
    if (!safePlaceholder.test(assignment[2].trim())) {
      throw new Error(`secret material detected in delivery file: ${path} (${assignment[1]})`);
    }
  }
}

function fileEntry(root: string, path: string): IveKitDeliveryManifestFile {
  const absolute = join(root, path);
  return { path, bytes: statSync(absolute).size, sha256: sha256(absolute) };
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function treeSha256(root: string): string {
  return createHash('sha256').update(listDeliveryFiles(root)
    .map((path) => `${path}\0${sha256(join(root, path))}\n`)
    .join('')).digest('hex');
}

function validatedImageDigest(value: string | undefined): string {
  const digest = String(value || '').trim();
  if (digest && !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error('imageDigest must be a sha256 digest');
  }
  return digest;
}

function validateArtifactBindings(outputDir: string, manifest: IveKitDeliveryManifest): void {
  const artifacts = manifest.artifacts;
  const checks: Array<[string, string]> = [
    [artifacts.sdk_package.path, artifacts.sdk_package.sha256],
    [artifacts.migration_manifest.path, artifacts.migration_manifest.sha256],
    [artifacts.image_metadata.path, artifacts.image_metadata.sha256],
    [artifacts.sbom.path, artifacts.sbom.sha256],
    [artifacts.acceptance_status.path, artifacts.acceptance_status.sha256],
    [artifacts.v6_real_acceptance_template.path, artifacts.v6_real_acceptance_template.sha256],
    [artifacts.provider_profiles_example.path, artifacts.provider_profiles_example.sha256],
    [artifacts.release_contract.path, artifacts.release_contract.sha256],
    [artifacts.stage2_deployment_evidence.path, artifacts.stage2_deployment_evidence.sha256],
    [artifacts.upgrade_runbook.path, artifacts.upgrade_runbook.sha256],
    ['service/build-context/context-manifest.json', artifacts.service_build_context.manifest_sha256]
  ];
  for (const [path, expected] of checks) {
    if (sha256(join(outputDir, path)) !== expected) throw new Error(`artifact checksum mismatch: ${path}`);
  }
  if (treeSha256(join(outputDir, artifacts.reference_client.path)) !== artifacts.reference_client.tree_sha256) {
    throw new Error('reference client tree checksum mismatch');
  }
  const migrationManifest = JSON.parse(readFileSync(
    join(outputDir, artifacts.migration_manifest.path), 'utf8'
  )) as { source_commit?: unknown };
  const imageMetadata = JSON.parse(readFileSync(
    join(outputDir, artifacts.image_metadata.path), 'utf8'
  )) as { source_commit?: unknown; digest?: unknown };
  if (migrationManifest.source_commit !== manifest.source_commit) {
    throw new Error('migration manifest source commit does not match delivery manifest');
  }
  if (imageMetadata.source_commit !== manifest.source_commit) {
    throw new Error('image metadata source commit does not match delivery manifest');
  }
  const releaseContract = JSON.parse(readFileSync(
    join(outputDir, artifacts.release_contract.path), 'utf8'
  )) as IveKitReleaseContract;
  const stage2Evidence = JSON.parse(readFileSync(
    join(outputDir, artifacts.stage2_deployment_evidence.path), 'utf8'
  )) as IveKitStage2ReleaseEvidence;
  validateIveKitStage2ReleaseEvidence(stage2Evidence);
  validateIveKitReleaseOperations({
    contract: releaseContract,
    runbook: readFileSync(join(outputDir, artifacts.upgrade_runbook.path), 'utf8')
  });
  if (artifacts.release_contract.path !== 'operations/release-contract.json' ||
      artifacts.upgrade_runbook.path !== 'operations/upgrade-runbook.md' ||
      artifacts.stage2_deployment_evidence.path !== 'operations/stage2-deployment-evidence.json' ||
      releaseContract.source_commit !== manifest.source_commit ||
      releaseContract.generated_at !== manifest.generated_at ||
      releaseContract.image.metadata_sha256 !== artifacts.image_metadata.sha256 ||
      releaseContract.migrations.manifest_sha256 !== artifacts.migration_manifest.sha256 ||
      releaseContract.configuration.stage2_evidence_sha256 !== artifacts.stage2_deployment_evidence.sha256 ||
      releaseContract.configuration.release_fingerprint_sha256 !== stage2Evidence.release_fingerprint_sha256 ||
      stage2Evidence.source_commit !== manifest.source_commit ||
      stage2Evidence.generated_at !== manifest.generated_at ||
      stage2Evidence.application_image_digest !== imageMetadata.digest) {
    throw new Error('release operations do not match delivery artifacts');
  }
}

function validateAcceptanceMetadata(outputDir: string, manifest: IveKitDeliveryManifest): void {
  if (!isRecord(manifest.controlled_environment_acceptance) ||
      JSON.stringify(Object.keys(manifest.controlled_environment_acceptance).sort()) !==
        JSON.stringify([...CONTROLLED_ACCEPTANCE_KEYS].sort()) ||
      Object.values(manifest.controlled_environment_acceptance)
        .some((value) => value !== 'not_run' && value !== 'passed')) {
    throw new Error('controlled acceptance contract is incomplete');
  }
  if (
    JSON.stringify(manifest.real_environment_acceptance) !==
    JSON.stringify(REAL_ENVIRONMENT_ACCEPTANCE)
  ) throw new Error('real-environment acceptance contract is incomplete');
  const status = JSON.parse(readFileSync(join(outputDir, 'acceptance', 'status.json'), 'utf8')) as {
    schema_version?: unknown;
    product?: unknown;
    foundation_version?: unknown;
    source_commit?: unknown;
    generated_at?: unknown;
    status?: unknown;
    controlled_environment?: unknown;
    controlled_checks?: unknown;
    evidence?: unknown;
    real_environment?: unknown;
    known_not_run?: unknown;
    capability_matrix?: unknown;
    controlled_tests_are_real_vendor_evidence?: unknown;
  };
  if (status.schema_version !== 2 || status.product !== 'iveKit' ||
      status.foundation_version !== 'V5' ||
      JSON.stringify(status.capability_matrix) !== JSON.stringify(CAPABILITY_MATRIX) ||
      status.status !== controlledAcceptanceStatus(manifest.controlled_environment_acceptance)) {
    throw new Error('invalid V5 acceptance status');
  }
  if (status.source_commit !== manifest.source_commit) {
    throw new Error('acceptance source commit does not match delivery manifest');
  }
  if (status.generated_at !== manifest.generated_at) {
    throw new Error('acceptance generated_at does not match delivery manifest');
  }
  if (JSON.stringify(status.controlled_environment) !== JSON.stringify(manifest.controlled_environment_acceptance)) {
    throw new Error('controlled acceptance state does not match delivery manifest');
  }
  if (!isRecord(status.controlled_checks) || !Array.isArray(status.evidence)) {
    throw new Error('controlled acceptance evidence contract is missing');
  }
  const evidence = status.evidence as Array<{ path?: unknown; bytes?: unknown; sha256?: unknown }>;
  const evidencePaths = evidence.map((entry) => String(entry.path || ''));
  if (new Set(evidencePaths).size !== evidencePaths.length) {
    throw new Error('duplicate controlled acceptance evidence');
  }
  const actualEvidenceDir = join(outputDir, 'acceptance', 'evidence');
  const actualEvidence = existsSync(actualEvidenceDir) ? listDeliveryFiles(actualEvidenceDir) : [];
  if (JSON.stringify([...evidencePaths].sort()) !== JSON.stringify(actualEvidence)) {
    throw new Error('controlled acceptance evidence file list mismatch');
  }
  const referenced = new Set<string>();
  for (const entry of evidence) {
    const path = String(entry.path || '');
    const absolute = join(actualEvidenceDir, path);
    if (Number(entry.bytes) !== statSync(absolute).size || String(entry.sha256 || '') !== sha256(absolute)) {
      throw new Error(`controlled acceptance evidence checksum mismatch: ${path}`);
    }
  }
  for (const key of CONTROLLED_ACCEPTANCE_KEYS) {
    const check = status.controlled_checks[key];
    if (!isRecord(check) || check.status !== manifest.controlled_environment_acceptance[key] ||
        !Array.isArray(check.evidence)) {
      throw new Error(`controlled acceptance check does not match manifest: ${key}`);
    }
    const names = check.evidence.map((value) => String(value));
    if (new Set(names).size !== names.length || names.some((name) => !evidencePaths.includes(name)) ||
        (check.status === 'passed' && names.length === 0) ||
        (check.status === 'not_run' && names.length !== 0)) {
      throw new Error(`controlled acceptance evidence state is invalid: ${key}`);
    }
    for (const name of names) referenced.add(name);
  }
  if (referenced.size !== evidencePaths.length) {
    throw new Error('controlled acceptance contains unreferenced evidence');
  }
  if (JSON.stringify(status.real_environment) !== JSON.stringify(manifest.real_environment_acceptance)) {
    throw new Error('real-environment acceptance state does not match delivery manifest');
  }
  if (status.controlled_tests_are_real_vendor_evidence !== false) {
    throw new Error('controlled tests cannot claim real vendor evidence');
  }
  if (!Array.isArray(status.known_not_run)) throw new Error('known_not_run must be an array');
  const entries = status.known_not_run as Array<{ id?: unknown; status?: unknown; reason?: unknown }>;
  const ids = entries.map((entry) => String(entry.id || ''));
  if (new Set(ids).size !== ids.length) throw new Error('duplicate known_not_run id');
  if (JSON.stringify(ids) !== JSON.stringify(KNOWN_NOT_RUN.map((entry) => entry.id))) {
    throw new Error('known_not_run items do not match the V5 acceptance contract');
  }
  for (const entry of entries) {
    const reason = String(entry.reason || '').trim();
    if (entry.status !== 'not_run') throw new Error(`known_not_run ${entry.id} must remain not_run`);
    if (reason.length < 20 || /\b(?:TBD|TODO|placeholder|replace[_ -]?me)\b/i.test(reason)) {
      throw new Error(`placeholder known_not_run reason: ${entry.id}`);
    }
  }
  if (JSON.stringify(entries) !== JSON.stringify(manifest.known_not_run)) {
    throw new Error('known_not_run items do not match delivery manifest');
  }

  const profiles = JSON.parse(readFileSync(
    join(outputDir, 'acceptance', 'provider-profiles.example.json'), 'utf8'
  )) as Array<Record<string, unknown>>;
  if (!Array.isArray(profiles) || profiles.length !== 4) throw new Error('invalid controlled provider profiles');
  const capabilities = profiles.map((profile) => profile.capability);
  if (JSON.stringify(capabilities) !== JSON.stringify(['ocr', 'asr', 'quality_review', 'translation'])) {
    throw new Error('controlled provider profiles are incomplete or duplicated');
  }
  for (const profile of profiles) {
    if (
      profile.mode !== 'self_hosted' ||
      profile.base_url !== 'http://controlled-intelligence-provider:8790' ||
      typeof profile.token_env !== 'string' ||
      !String(profile.token_env).startsWith('OPC_IVEKIT_')
    ) throw new Error('controlled provider profile is unsafe');
  }
}

function validateVoiceAcceptanceAssets(outputDir: string, manifest: IveKitDeliveryManifest): void {
  const template = JSON.parse(readFileSync(
    join(outputDir, manifest.contents.voice_acceptance_template), 'utf8'
  )) as Record<string, unknown>;
  if (template.schema_version !== 1 || template.source !== 'real_voice_environment' ||
      template.status !== 'incomplete' || template.deployed_commit !== manifest.source_commit) {
    throw new Error('invalid source-bound Voice acceptance template');
  }
  const checks = isRecord(template.checks) ? template.checks : {};
  if (JSON.stringify(Object.keys(checks)) !== JSON.stringify([...VOICE_REQUIRED_ACCEPTANCE_CHECKS])) {
    throw new Error('Voice acceptance template check set is incomplete');
  }
  for (const checkId of VOICE_REQUIRED_ACCEPTANCE_CHECKS) {
    const check = checks[checkId];
    if (!isRecord(check) || check.passed !== false) {
      throw new Error(`Voice acceptance template must remain incomplete: ${checkId}`);
    }
  }
  const runbook = readFileSync(join(outputDir, manifest.contents.voice_acceptance_runbook), 'utf8');
  if (runbook !== renderIveKitVoiceAcceptanceRunbook()) {
    throw new Error('Voice acceptance runbook does not match the validator contract');
  }
}

function validateV6RealAcceptanceAsset(outputDir: string, manifest: IveKitDeliveryManifest): void {
  if (
    manifest.contents.v6_real_acceptance_template !== 'acceptance/v6-real-template.json' ||
    manifest.artifacts.v6_real_acceptance_template.path !== manifest.contents.v6_real_acceptance_template
  ) throw new Error('invalid V6 real acceptance artifact path');
  const template = JSON.parse(readFileSync(
    join(outputDir, manifest.contents.v6_real_acceptance_template),
    'utf8'
  )) as IveKitV6RealAcceptanceManifest;
  validateIveKitV6RealAcceptanceManifest(template, {
    base_dir: outputDir,
    expected_source_commit: manifest.source_commit
  });
  if (
    template.generated_at !== manifest.generated_at ||
    template.groups.some((group) => group.status !== 'not_run')
  ) throw new Error('V6 real acceptance template must remain source-bound and not_run');
}

function copyFile(outputDir: string, source: string, destination: string): void {
  const target = join(outputDir, destination);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function copyDeliverySource(outputDir: string, source: string, destination: string): void {
  if (!['deploy/application/docker-compose.yml', 'deploy/application/docker-compose.voice.yml']
    .includes(destination)) {
    copyFile(outputDir, source, destination);
    return;
  }
  const target = join(outputDir, destination);
  mkdirSync(dirname(target), { recursive: true });
  const portableCompose = readFileSync(source, 'utf8')
    .replace(/\n  build:\n    context: \./, '')
    .replaceAll(
      '${IVEKIT_SERVICE_IMAGE:-ivekit-service:local}',
      '${IVEKIT_SERVICE_IMAGE:?IVEKIT_SERVICE_IMAGE is required}'
    )
    .replaceAll(
      '${CLAMAV_IMAGE:-clamav/clamav:1.4.3_base}',
      '${CLAMAV_IMAGE:?CLAMAV_IMAGE immutable digest reference is required}'
    );
  if (/^\s+build:/m.test(portableCompose) || portableCompose.includes('ivekit-service:local')) {
    throw new Error('failed to remove repository-only build settings from delivery Compose');
  }
  writeFileSync(target, portableCompose, 'utf8');
}

function resolveInside(root: string, path: string): string {
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new Error(`source escapes repository: ${path}`);
  return absolute;
}

function requireFile(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`${label} is missing: ${path}`);
}

function requireDirectory(path: string, label: string): void {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`${label} is missing: ${path}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function walk(root: string, current: string, files: string[]): void {
  if (!existsSync(current)) return;
  for (const name of readdirSync(current).sort()) {
    const absolute = join(current, name);
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) walk(root, absolute, files);
    else files.push(relative(root, absolute).split(sep).join('/'));
  }
}

function listPaths(root: string): string[] {
  const paths: string[] = [];
  const visit = (current: string): void => {
    if (!existsSync(current)) return;
    for (const name of readdirSync(current)) {
      const path = join(current, name);
      paths.push(path);
      if (lstatSync(path).isDirectory()) visit(path);
    }
  };
  visit(root);
  return paths;
}

function resolveSourceCommit(repoRoot: string): string {
  return run('git', ['rev-parse', 'HEAD'], repoRoot).trim();
}

function run(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${result.stdout || ''}${result.stderr || ''}`.trim());
  }
  return result.stdout || '';
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const result = prepareBundleFromCli();
  process.stdout.write(`${JSON.stringify({
    output_dir: result.outputDir,
    status: result.manifest.status,
    source_commit: result.manifest.source_commit,
    payload_files: result.manifest.files.length,
    controlled_environment_acceptance: result.manifest.controlled_environment_acceptance,
    real_environment_acceptance: result.manifest.real_environment_acceptance
  }, null, 2)}\n`);
}
