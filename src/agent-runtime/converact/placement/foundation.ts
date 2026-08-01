import { createHash } from 'node:crypto';

import type { PgQueryable } from '../../../db-pg.js';
import {
  ComponentPlacementAdapter,
  componentPlacementPolicyConfig
} from './component-placement.js';
import { InteractionPlacementCoordinator } from './interaction-placement.js';
import {
  LiveKitEgressPlacementAdapter,
  liveKitEgressPlacementPolicies
} from './livekit-egress-placement.js';
import { MediaCallPlacementAdapter, mediaCallPlacementPolicyConfig } from './media-call-placement.js';
import { PlacementSnapshotSigner } from './snapshot.js';
import {
  FilePlacementRuntime,
  placementRuntimeConfig
} from './runtime.js';

export interface ConveractFabricPlacementFoundation {
  runtime: FilePlacementRuntime;
  coordinator: InteractionPlacementCoordinator;
  media: MediaCallPlacementAdapter;
  egress: LiveKitEgressPlacementAdapter;
  voice: ComponentPlacementAdapter;
  tinode: ComponentPlacementAdapter;
  rustdesk: ComponentPlacementAdapter;
  worker_id: string;
}

export function createConfiguredPlacementFoundation(input: {
  pg: PgQueryable;
  instance_id: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  now?: () => Date;
}): ConveractFabricPlacementFoundation | null {
  const env = input.env || process.env;
  const config = placementRuntimeConfig(env);
  if (!config.enabled) return null;
  const runtime = new FilePlacementRuntime({
    snapshot_file: config.snapshot_file,
    snapshot_signer: new PlacementSnapshotSigner(config.snapshot_hmac_keys),
    token_keys: config.token_hmac_keys,
    token_key_id: config.token_key_id,
    admission_service_token: config.admission_service_token,
    home_region_id: config.home_region_id,
    failover_region_ids: config.failover_region_ids,
    snapshot_refresh_ms: config.snapshot_refresh_ms,
    stale_grace_ms: config.stale_grace_ms,
    admission_timeout_ms: config.admission_timeout_ms,
    snapshot_max_bytes: config.snapshot_max_bytes,
    fetch: input.fetch,
    now: input.now
  });
  const coordinator = new InteractionPlacementCoordinator({
    planner: runtime,
    root_pg: input.pg,
    admission_service_token: config.admission_service_token,
    admission_timeout_ms: config.admission_timeout_ms,
    now: input.now
  });
  return {
    runtime,
    coordinator,
    media: new MediaCallPlacementAdapter({
      coordinator,
      policy: mediaCallPlacementPolicyConfig(env)
    }),
    egress: new LiveKitEgressPlacementAdapter({
      coordinator,
      policies: liveKitEgressPlacementPolicies(env)
    }),
    voice: new ComponentPlacementAdapter({
      coordinator,
      interaction_kind: 'sip_voice',
      owner_component: 'rustpbx',
      policy: componentPlacementPolicyConfig(
        env,
        'CONVERACT_FABRIC_PLACEMENT_VOICE_POLICY_JSON'
      )
    }),
    tinode: new ComponentPlacementAdapter({
      coordinator,
      interaction_kind: 'tinode_im',
      owner_component: 'tinode',
      policy: componentPlacementPolicyConfig(
        env,
        'CONVERACT_FABRIC_PLACEMENT_TINODE_POLICY_JSON'
      )
    }),
    rustdesk: new ComponentPlacementAdapter({
      coordinator,
      interaction_kind: 'rustdesk_remote',
      owner_component: 'rustdesk',
      policy: componentPlacementPolicyConfig(
        env,
        'CONVERACT_FABRIC_PLACEMENT_RUSTDESK_POLICY_JSON'
      )
    }),
    worker_id: `placement:${identifierDigest(input.instance_id)}`
  };
}

function identifierDigest(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error('Converact Fabric placement instance ID is required');
  return createHash('sha256').update(normalized).digest('hex').slice(0, 32);
}
