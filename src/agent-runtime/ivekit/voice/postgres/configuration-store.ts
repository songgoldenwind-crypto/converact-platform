import type { PgQueryable } from '../../../../db-pg.js';
import { withPgTenant } from '../../../../db-pg-tenant.js';
import type { VoiceConfigurationRepository } from '../ports.js';
import type {
  VoiceCapabilitySnapshot,
  VoiceConsent,
  VoiceDeploymentProfile,
  VoiceDid,
  VoiceExtension,
  VoiceListInput,
  VoicePage,
  VoicePolicy,
  VoiceProtectedAddress,
  VoiceRoute,
  VoiceRouteVersion,
  VoiceSipTrunk
} from '../types.js';
import {
  booleanValue,
  boundedLimit,
  cursorTuple,
  jsonArray,
  jsonRecord,
  nullableTimestamp,
  numberValue,
  pageFromRows,
  requiredRow,
  textArray,
  timestamp,
  type VoicePgRow
} from './row-utils.js';

const PROFILE_COLUMNS = `
  profile.id, profile.tenant_id, profile.name, profile.adapter, profile.status,
  profile.base_url, profile.desired_version, profile.config, profile.secret_refs,
  profile.revision, profile.created_by, profile.updated_by, profile.created_at, profile.updated_at`;

const TRUNK_COLUMNS = `
  trunk.id, trunk.tenant_id, trunk.profile_id, trunk.name, trunk.provider_ref,
  trunk.direction, trunk.transport, trunk.codecs, trunk.max_channels,
  trunk.credential_secret_ref, trunk.desired_state, trunk.status, trunk.revision,
  trunk.created_by, trunk.updated_by, trunk.created_at, trunk.updated_at`;

const DID_COLUMNS = `
  did.id, did.tenant_id, did.trunk_id, did.route_id, did.e164_redacted,
  did.provider_ref, did.status, did.metadata, did.revision, did.created_at, did.updated_at`;

const EXTENSION_COLUMNS = `
  extension.id, extension.tenant_id, extension.profile_id, extension.identity,
  extension.extension, extension.display_name, extension.credential_secret_ref,
  extension.permissions, extension.webrtc_enabled, extension.status, extension.revision,
  extension.created_at, extension.updated_at`;

const ROUTE_COLUMNS = `
  route.id, route.tenant_id, route.profile_id, route.name, route.direction, route.status,
  route.draft_revision, route.draft_rules, route.current_published_version,
  route.created_by, route.updated_by, route.created_at, route.updated_at`;

export class PostgresVoiceConfigurationStore implements VoiceConfigurationRepository {
  constructor(private readonly pg: PgQueryable) {}

  getProfile(tenantId: string, id: string, options: { for_update?: boolean } = {}): Promise<VoiceDeploymentProfile | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `SELECT ${PROFILE_COLUMNS}
         FROM ivekit_voice_deployment_profiles profile
         WHERE profile.tenant_id = $1 AND profile.id = $2
         ${options.for_update ? 'FOR UPDATE' : ''}`,
        [tenantId, id]
      );
      return result.rows[0] ? decodeProfile(result.rows[0]) : null;
    });
  }

  listProfiles(input: VoiceListInput): Promise<VoicePage<VoiceDeploymentProfile>> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const limit = boundedLimit(input.limit);
      const [cursorAt, cursorId] = cursorTuple(input.cursor);
      const result = await pg.query<VoicePgRow>(
        `SELECT ${PROFILE_COLUMNS}
         FROM ivekit_voice_deployment_profiles profile
         WHERE profile.tenant_id = $1
           AND (profile.created_at, profile.id) < ($2::timestamptz, $3)
         ORDER BY profile.created_at DESC, profile.id DESC
         LIMIT $4`,
        [input.tenant_id, cursorAt, cursorId, limit + 1]
      );
      return pageFromRows(result.rows.map(decodeProfile), limit);
    });
  }

  insertProfile(input: VoiceDeploymentProfile): Promise<VoiceDeploymentProfile> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `INSERT INTO ivekit_voice_deployment_profiles
          (id, tenant_id, name, adapter, status, base_url, desired_version, config,
           secret_refs, revision, created_by, updated_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11, $12, $13, $14)
         RETURNING *`,
        [
          input.id, input.tenant_id, input.name, input.adapter, input.status, input.base_url,
          input.desired_version, JSON.stringify(input.config), JSON.stringify(input.secret_refs),
          input.revision, input.created_by, input.updated_by, input.created_at, input.updated_at
        ]
      );
      return decodeProfile(requiredRow(result.rows[0]));
    });
  }

  updateProfile(input: VoiceDeploymentProfile, expectedRevision: number): Promise<VoiceDeploymentProfile> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `UPDATE ivekit_voice_deployment_profiles
         SET name = $3, adapter = $4, status = $5, base_url = $6, desired_version = $7,
             config = $8::jsonb, secret_refs = $9::jsonb, updated_by = $10,
             updated_at = $11, revision = revision + 1
         WHERE tenant_id = $1 AND id = $2 AND revision = $12
         RETURNING *`,
        [
          input.tenant_id, input.id, input.name, input.adapter, input.status, input.base_url,
          input.desired_version, JSON.stringify(input.config), JSON.stringify(input.secret_refs),
          input.updated_by, input.updated_at, expectedRevision
        ]
      );
      return decodeProfile(requiredRow(result.rows[0], 'revision_conflict'));
    });
  }

  insertCapabilitySnapshot(input: VoiceCapabilitySnapshot): Promise<VoiceCapabilitySnapshot> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `INSERT INTO ivekit_voice_capability_snapshots
          (id, tenant_id, profile_id, provider, provider_version, status, capabilities,
           config_hash, error_code, error_message, checked_at, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
         RETURNING *`,
        [
          input.id, input.tenant_id, input.profile_id, input.provider, input.provider_version,
          input.status, JSON.stringify(input.capabilities), input.config_hash, input.error_code,
          input.error_message, input.checked_at, input.created_at
        ]
      );
      return decodeCapability(requiredRow(result.rows[0]));
    });
  }

  getLatestCapabilitySnapshot(tenantId: string, profileId: string): Promise<VoiceCapabilitySnapshot | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `SELECT * FROM ivekit_voice_capability_snapshots
         WHERE tenant_id = $1 AND profile_id = $2
         ORDER BY checked_at DESC, id DESC LIMIT 1`,
        [tenantId, profileId]
      );
      return result.rows[0] ? decodeCapability(result.rows[0]) : null;
    });
  }

  getTrunk(tenantId: string, id: string, options: { for_update?: boolean } = {}): Promise<VoiceSipTrunk | null> {
    return this.getDesiredState(tenantId, id, TRUNK_COLUMNS, 'ivekit_voice_sip_trunks', 'trunk', decodeTrunk, options);
  }

  listTrunks(input: VoiceListInput & { profile_id?: string }): Promise<VoicePage<VoiceSipTrunk>> {
    return this.listDesiredState(input, TRUNK_COLUMNS, 'ivekit_voice_sip_trunks', 'trunk', 'profile_id', input.profile_id, decodeTrunk);
  }

  insertTrunk(input: VoiceSipTrunk): Promise<VoiceSipTrunk> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `INSERT INTO ivekit_voice_sip_trunks
          (id, tenant_id, profile_id, name, provider_ref, direction, transport, codecs,
           max_channels, credential_secret_ref, desired_state, status, revision,
           created_by, updated_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::text[], $9, $10, $11::jsonb,
                 $12, $13, $14, $15, $16, $17)
         RETURNING *`,
        [
          input.id, input.tenant_id, input.profile_id, input.name, input.provider_ref,
          input.direction, input.transport, input.codecs, input.max_channels,
          input.credential_secret_ref, JSON.stringify(input.desired_state), input.status,
          input.revision, input.created_by, input.updated_by, input.created_at, input.updated_at
        ]
      );
      return decodeTrunk(requiredRow(result.rows[0]));
    });
  }

  updateTrunk(input: VoiceSipTrunk, expectedRevision: number): Promise<VoiceSipTrunk> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `UPDATE ivekit_voice_sip_trunks
         SET name = $3, provider_ref = $4, direction = $5, transport = $6,
             codecs = $7::text[], max_channels = $8, credential_secret_ref = $9,
             desired_state = $10::jsonb, status = $11, updated_by = $12,
             updated_at = $13, revision = revision + 1
         WHERE tenant_id = $1 AND id = $2 AND revision = $14
         RETURNING *`,
        [
          input.tenant_id, input.id, input.name, input.provider_ref, input.direction,
          input.transport, input.codecs, input.max_channels, input.credential_secret_ref,
          JSON.stringify(input.desired_state), input.status, input.updated_by,
          input.updated_at, expectedRevision
        ]
      );
      return decodeTrunk(requiredRow(result.rows[0], 'revision_conflict'));
    });
  }

  getDid(tenantId: string, id: string, options: { for_update?: boolean } = {}): Promise<VoiceDid | null> {
    return this.getDesiredState(tenantId, id, DID_COLUMNS, 'ivekit_voice_dids', 'did', decodeDid, options);
  }

  findDidByAddressHmac(tenantId: string, hmac: string): Promise<VoiceDid | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `SELECT ${DID_COLUMNS} FROM ivekit_voice_dids did
         WHERE did.tenant_id = $1 AND did.e164_hmac = $2 AND did.status = 'active'
         LIMIT 1`,
        [tenantId, hmac]
      );
      return result.rows[0] ? decodeDid(result.rows[0]) : null;
    });
  }

  listDids(input: VoiceListInput & { trunk_id?: string }): Promise<VoicePage<VoiceDid>> {
    return this.listDesiredState(input, DID_COLUMNS, 'ivekit_voice_dids', 'did', 'trunk_id', input.trunk_id, decodeDid);
  }

  insertDid(input: VoiceDid, address: VoiceProtectedAddress): Promise<VoiceDid> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `INSERT INTO ivekit_voice_dids
          (id, tenant_id, trunk_id, route_id, e164_ciphertext, e164_hmac, e164_redacted,
           provider_ref, status, metadata, revision, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12, $13)
         RETURNING id, tenant_id, trunk_id, route_id, e164_redacted, provider_ref,
                   status, metadata, revision, created_at, updated_at`,
        [
          input.id, input.tenant_id, input.trunk_id, input.route_id, address.ciphertext,
          address.hmac, address.redacted, input.provider_ref, input.status,
          JSON.stringify(input.metadata), input.revision, input.created_at, input.updated_at
        ]
      );
      return decodeDid(requiredRow(result.rows[0]));
    });
  }

  updateDid(input: VoiceDid, expectedRevision: number): Promise<VoiceDid> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `UPDATE ivekit_voice_dids
         SET trunk_id = $3, route_id = $4, provider_ref = $5, status = $6,
             metadata = $7::jsonb, updated_at = $8, revision = revision + 1
         WHERE tenant_id = $1 AND id = $2 AND revision = $9
         RETURNING id, tenant_id, trunk_id, route_id, e164_redacted, provider_ref,
                   status, metadata, revision, created_at, updated_at`,
        [
          input.tenant_id, input.id, input.trunk_id, input.route_id, input.provider_ref,
          input.status, JSON.stringify(input.metadata), input.updated_at, expectedRevision
        ]
      );
      return decodeDid(requiredRow(result.rows[0], 'revision_conflict'));
    });
  }

  getExtension(tenantId: string, id: string, options: { for_update?: boolean } = {}): Promise<VoiceExtension | null> {
    return this.getDesiredState(tenantId, id, EXTENSION_COLUMNS, 'ivekit_voice_extensions', 'extension', decodeExtension, options);
  }

  listExtensions(input: VoiceListInput & { profile_id?: string }): Promise<VoicePage<VoiceExtension>> {
    return this.listDesiredState(input, EXTENSION_COLUMNS, 'ivekit_voice_extensions', 'extension', 'profile_id', input.profile_id, decodeExtension);
  }

  insertExtension(input: VoiceExtension): Promise<VoiceExtension> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `INSERT INTO ivekit_voice_extensions
          (id, tenant_id, profile_id, identity, extension, display_name,
           credential_secret_ref, permissions, webrtc_enabled, status, revision,
           created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          input.id, input.tenant_id, input.profile_id, input.identity, input.extension,
          input.display_name, input.credential_secret_ref, JSON.stringify(input.permissions),
          input.webrtc_enabled, input.status, input.revision, input.created_at, input.updated_at
        ]
      );
      return decodeExtension(requiredRow(result.rows[0]));
    });
  }

  updateExtension(input: VoiceExtension, expectedRevision: number): Promise<VoiceExtension> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `UPDATE ivekit_voice_extensions
         SET identity = $3, extension = $4, display_name = $5, credential_secret_ref = $6,
             permissions = $7::jsonb, webrtc_enabled = $8, status = $9,
             updated_at = $10, revision = revision + 1
         WHERE tenant_id = $1 AND id = $2 AND revision = $11
         RETURNING *`,
        [
          input.tenant_id, input.id, input.identity, input.extension, input.display_name,
          input.credential_secret_ref, JSON.stringify(input.permissions), input.webrtc_enabled,
          input.status, input.updated_at, expectedRevision
        ]
      );
      return decodeExtension(requiredRow(result.rows[0], 'revision_conflict'));
    });
  }

  getRoute(tenantId: string, id: string, options: { for_update?: boolean } = {}): Promise<VoiceRoute | null> {
    return this.getDesiredState(tenantId, id, ROUTE_COLUMNS, 'ivekit_voice_routes', 'route', decodeRoute, options);
  }

  listRoutes(input: VoiceListInput & { profile_id?: string }): Promise<VoicePage<VoiceRoute>> {
    return this.listDesiredState(input, ROUTE_COLUMNS, 'ivekit_voice_routes', 'route', 'profile_id', input.profile_id, decodeRoute);
  }

  insertRoute(input: VoiceRoute): Promise<VoiceRoute> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `INSERT INTO ivekit_voice_routes
          (id, tenant_id, profile_id, name, direction, status, draft_revision, draft_rules,
           current_published_version, created_by, updated_by, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          input.id, input.tenant_id, input.profile_id, input.name, input.direction,
          input.status, input.draft_revision, JSON.stringify(input.draft_rules),
          input.current_published_version, input.created_by, input.updated_by,
          input.created_at, input.updated_at
        ]
      );
      return decodeRoute(requiredRow(result.rows[0]));
    });
  }

  updateRoute(input: VoiceRoute, expectedRevision: number): Promise<VoiceRoute> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `UPDATE ivekit_voice_routes
         SET name = $3, direction = $4, status = $5, draft_rules = $6::jsonb,
             current_published_version = $7, updated_by = $8, updated_at = $9,
             draft_revision = draft_revision + 1
         WHERE tenant_id = $1 AND id = $2 AND draft_revision = $10
         RETURNING *`,
        [
          input.tenant_id, input.id, input.name, input.direction, input.status,
          JSON.stringify(input.draft_rules), input.current_published_version,
          input.updated_by, input.updated_at, expectedRevision
        ]
      );
      return decodeRoute(requiredRow(result.rows[0], 'revision_conflict'));
    });
  }

  insertRouteVersion(input: VoiceRouteVersion): Promise<VoiceRouteVersion> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `INSERT INTO ivekit_voice_route_versions
          (id, tenant_id, route_id, version, rules, payload_hash, deployment_state,
           provider_revision, published_by, published_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
         ON CONFLICT (tenant_id, route_id, payload_hash) DO NOTHING
         RETURNING *`,
        [
          input.id, input.tenant_id, input.route_id, input.version, JSON.stringify(input.rules),
          input.payload_hash, input.deployment_state, input.provider_revision,
          input.published_by, input.published_at
        ]
      );
      if (result.rows[0]) return decodeRouteVersion(result.rows[0]);
      const replay = await pg.query<VoicePgRow>(
        `SELECT * FROM ivekit_voice_route_versions
         WHERE tenant_id = $1 AND route_id = $2 AND payload_hash = $3`,
        [input.tenant_id, input.route_id, input.payload_hash]
      );
      return decodeRouteVersion(requiredRow(replay.rows[0], 'idempotency_conflict'));
    });
  }

  listRouteVersions(tenantId: string, routeId: string): Promise<VoiceRouteVersion[]> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `SELECT * FROM ivekit_voice_route_versions
         WHERE tenant_id = $1 AND route_id = $2 ORDER BY version DESC`,
        [tenantId, routeId]
      );
      return result.rows.map(decodeRouteVersion);
    });
  }

  getPolicy(tenantId: string): Promise<VoicePolicy | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `SELECT * FROM ivekit_voice_policies
         WHERE tenant_id = $1 AND status <> 'archived'
         ORDER BY created_at DESC, id DESC LIMIT 1`,
        [tenantId]
      );
      return result.rows[0] ? decodePolicy(result.rows[0]) : null;
    });
  }

  upsertPolicy(input: VoicePolicy, expectedRevision: number | null): Promise<VoicePolicy> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const params = [
        input.tenant_id, input.id, input.require_outbound_consent, input.recording_mode,
        input.recording_retention_days, input.require_ai_disclosure,
        JSON.stringify(input.allowed_calling_windows), JSON.stringify(input.masking_policy),
        input.status, input.created_by, input.updated_by, input.created_at, input.updated_at
      ];
      const result = expectedRevision === null
        ? await pg.query<VoicePgRow>(
          `INSERT INTO ivekit_voice_policies
            (tenant_id, id, require_outbound_consent, recording_mode, recording_retention_days,
             require_ai_disclosure, allowed_calling_windows, masking_policy, status,
             created_by, updated_by, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9, $10, $11, $12, $13)
           RETURNING *`,
          params
        )
        : await pg.query<VoicePgRow>(
          `UPDATE ivekit_voice_policies
           SET require_outbound_consent = $3, recording_mode = $4,
               recording_retention_days = $5, require_ai_disclosure = $6,
               allowed_calling_windows = $7::jsonb, masking_policy = $8::jsonb,
               status = $9, updated_by = $11, updated_at = $13, revision = revision + 1
           WHERE tenant_id = $1 AND id = $2 AND revision = $14
           RETURNING *`,
          [...params, expectedRevision]
        );
      return decodePolicy(requiredRow(result.rows[0], expectedRevision === null ? 'not_found' : 'revision_conflict'));
    });
  }

  insertConsent(input: VoiceConsent): Promise<VoiceConsent> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `INSERT INTO ivekit_voice_consents
          (id, tenant_id, subject_ref_type, subject_ref_id, business_ref_type,
           business_ref_id, consent_type, status, evidence_ref, granted_by,
           expires_at, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         RETURNING *`,
        [
          input.id, input.tenant_id, input.subject_ref_type, input.subject_ref_id,
          input.business_ref_type, input.business_ref_id, input.consent_type, input.status,
          input.evidence_ref, input.granted_by, input.expires_at, input.created_at, input.updated_at
        ]
      );
      return decodeConsent(requiredRow(result.rows[0]));
    });
  }

  listConsents(input: VoiceListInput & { subject_ref_type?: string; subject_ref_id?: string }): Promise<VoicePage<VoiceConsent>> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const limit = boundedLimit(input.limit);
      const [cursorAt, cursorId] = cursorTuple(input.cursor);
      const result = await pg.query<VoicePgRow>(
        `SELECT * FROM ivekit_voice_consents consent
         WHERE consent.tenant_id = $1
           AND (consent.created_at, consent.id) < ($2::timestamptz, $3)
           AND ($4::text IS NULL OR consent.subject_ref_type = $4)
           AND ($5::text IS NULL OR consent.subject_ref_id = $5)
         ORDER BY consent.created_at DESC, consent.id DESC LIMIT $6`,
        [input.tenant_id, cursorAt, cursorId, input.subject_ref_type ?? null, input.subject_ref_id ?? null, limit + 1]
      );
      return pageFromRows(result.rows.map(decodeConsent), limit);
    });
  }

  private getDesiredState<T>(
    tenantId: string,
    id: string,
    columns: string,
    table: string,
    alias: string,
    decode: (row: VoicePgRow) => T,
    options: { for_update?: boolean }
  ): Promise<T | null> {
    return withPgTenant(this.pg, tenantId, async (pg) => {
      const result = await pg.query<VoicePgRow>(
        `SELECT ${columns} FROM ${table} ${alias}
         WHERE ${alias}.tenant_id = $1 AND ${alias}.id = $2
         ${options.for_update ? 'FOR UPDATE' : ''}`,
        [tenantId, id]
      );
      return result.rows[0] ? decode(result.rows[0]) : null;
    });
  }

  private listDesiredState<T extends { id: string; created_at: string }>(
    input: VoiceListInput,
    columns: string,
    table: string,
    alias: string,
    filterColumn: string,
    filterValue: string | undefined,
    decode: (row: VoicePgRow) => T
  ): Promise<VoicePage<T>> {
    return withPgTenant(this.pg, input.tenant_id, async (pg) => {
      const limit = boundedLimit(input.limit);
      const [cursorAt, cursorId] = cursorTuple(input.cursor);
      const result = await pg.query<VoicePgRow>(
        `SELECT ${columns} FROM ${table} ${alias}
         WHERE ${alias}.tenant_id = $1
           AND (${alias}.created_at, ${alias}.id) < ($2::timestamptz, $3)
           AND ($4::text IS NULL OR ${alias}.${filterColumn} = $4)
         ORDER BY ${alias}.created_at DESC, ${alias}.id DESC LIMIT $5`,
        [input.tenant_id, cursorAt, cursorId, filterValue ?? null, limit + 1]
      );
      return pageFromRows(result.rows.map(decode), limit);
    });
  }
}

function decodeProfile(row: VoicePgRow): VoiceDeploymentProfile {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), name: String(row.name),
    adapter: row.adapter as VoiceDeploymentProfile['adapter'], status: row.status as VoiceDeploymentProfile['status'],
    base_url: String(row.base_url ?? ''), desired_version: String(row.desired_version ?? ''),
    config: jsonRecord(row.config), secret_refs: Object.fromEntries(Object.entries(jsonRecord(row.secret_refs)).map(([key, value]) => [key, String(value)])),
    revision: numberValue(row.revision), created_by: String(row.created_by ?? ''), updated_by: String(row.updated_by ?? ''),
    created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at)
  };
}

function decodeCapability(row: VoicePgRow): VoiceCapabilitySnapshot {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), profile_id: String(row.profile_id),
    provider: String(row.provider), provider_version: String(row.provider_version ?? ''),
    status: row.status as VoiceCapabilitySnapshot['status'], capabilities: jsonRecord(row.capabilities) as VoiceCapabilitySnapshot['capabilities'],
    config_hash: String(row.config_hash), error_code: String(row.error_code ?? ''), error_message: String(row.error_message ?? ''),
    checked_at: timestamp(row.checked_at), created_at: timestamp(row.created_at)
  };
}

function decodeTrunk(row: VoicePgRow): VoiceSipTrunk {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), profile_id: String(row.profile_id), name: String(row.name),
    provider_ref: String(row.provider_ref ?? ''), direction: row.direction as VoiceSipTrunk['direction'],
    transport: row.transport as VoiceSipTrunk['transport'], codecs: textArray(row.codecs), max_channels: numberValue(row.max_channels),
    credential_secret_ref: String(row.credential_secret_ref ?? ''), desired_state: jsonRecord(row.desired_state),
    status: row.status as VoiceSipTrunk['status'], revision: numberValue(row.revision), created_by: String(row.created_by ?? ''),
    updated_by: String(row.updated_by ?? ''), created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at)
  };
}

function decodeDid(row: VoicePgRow): VoiceDid {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), trunk_id: String(row.trunk_id),
    route_id: row.route_id == null ? null : String(row.route_id), e164: { kind: 'e164', redacted: String(row.e164_redacted) },
    provider_ref: String(row.provider_ref ?? ''), status: row.status as VoiceDid['status'], metadata: jsonRecord(row.metadata),
    revision: numberValue(row.revision), created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at)
  };
}

function decodeExtension(row: VoicePgRow): VoiceExtension {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), profile_id: String(row.profile_id), identity: String(row.identity),
    extension: String(row.extension), display_name: String(row.display_name ?? ''), credential_secret_ref: String(row.credential_secret_ref ?? ''),
    permissions: jsonRecord(row.permissions), webrtc_enabled: booleanValue(row.webrtc_enabled), status: row.status as VoiceExtension['status'],
    revision: numberValue(row.revision), created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at)
  };
}

function decodeRoute(row: VoicePgRow): VoiceRoute {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), profile_id: String(row.profile_id), name: String(row.name),
    direction: row.direction as VoiceRoute['direction'], status: row.status as VoiceRoute['status'],
    draft_revision: numberValue(row.draft_revision), draft_rules: jsonRecord(row.draft_rules),
    current_published_version: row.current_published_version == null ? null : numberValue(row.current_published_version),
    created_by: String(row.created_by ?? ''), updated_by: String(row.updated_by ?? ''),
    created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at)
  };
}

function decodeRouteVersion(row: VoicePgRow): VoiceRouteVersion {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), route_id: String(row.route_id), version: numberValue(row.version),
    rules: jsonRecord(row.rules), payload_hash: String(row.payload_hash), deployment_state: row.deployment_state as VoiceRouteVersion['deployment_state'],
    provider_revision: String(row.provider_revision ?? ''), published_by: String(row.published_by), published_at: timestamp(row.published_at)
  };
}

function decodePolicy(row: VoicePgRow): VoicePolicy {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), require_outbound_consent: booleanValue(row.require_outbound_consent),
    recording_mode: row.recording_mode as VoicePolicy['recording_mode'], recording_retention_days: numberValue(row.recording_retention_days),
    require_ai_disclosure: booleanValue(row.require_ai_disclosure), allowed_calling_windows: jsonArray(row.allowed_calling_windows),
    masking_policy: jsonRecord(row.masking_policy), status: row.status as VoicePolicy['status'], revision: numberValue(row.revision),
    created_by: String(row.created_by ?? ''), updated_by: String(row.updated_by ?? ''),
    created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at)
  };
}

function decodeConsent(row: VoicePgRow): VoiceConsent {
  return {
    id: String(row.id), tenant_id: String(row.tenant_id), subject_ref_type: String(row.subject_ref_type),
    subject_ref_id: String(row.subject_ref_id), business_ref_type: String(row.business_ref_type ?? ''),
    business_ref_id: String(row.business_ref_id ?? ''), consent_type: row.consent_type as VoiceConsent['consent_type'],
    status: row.status as VoiceConsent['status'], evidence_ref: String(row.evidence_ref), granted_by: String(row.granted_by ?? ''),
    expires_at: nullableTimestamp(row.expires_at), created_at: timestamp(row.created_at), updated_at: timestamp(row.updated_at)
  };
}
