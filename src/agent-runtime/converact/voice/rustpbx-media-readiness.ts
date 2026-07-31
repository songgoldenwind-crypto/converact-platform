import { readFile, stat } from 'node:fs/promises';
import { request } from 'node:https';

import type { FlatCapacityState } from '../placement/types.js';
import type { ComponentNodeStateSnapshot } from '../placement/component-node-admission.js';
import {
  verifyRustPbxRouteSnapshotEnvelope
} from './rustpbx-route-snapshot-envelope.js';

export type RustPbxMediaReadinessFailureStage =
  | 'route_snapshot'
  | 'media_control'
  | 'profile_capacity';

export interface RustPbxMediaReadinessCheck {
  ready: boolean;
  code: string;
}

export interface RustPbxMediaReadinessProfile {
  id: string;
  required_capacity: Record<string, number>;
  required_for_pod_readiness: boolean;
}

export interface RustPbxMediaProfileReadiness {
  ready: boolean;
  limiting_dimensions: string[];
}

export interface RustPbxMediaReadiness {
  ready: boolean;
  failure_stages: RustPbxMediaReadinessFailureStage[];
  route_snapshot: RustPbxMediaReadinessCheck;
  media_control: RustPbxMediaReadinessCheck;
  profiles: Record<string, RustPbxMediaProfileReadiness>;
}

export interface RustPbxMediaReadinessProbeConfig {
  route_snapshot_file: string;
  route_snapshot_signing_key: string;
  route_tenant_id: string;
  route_profile_id: string;
  media_control_endpoint: string;
  media_control_identity: Buffer;
  media_control_ca: Buffer;
  media_control_timeout_ms: number;
  refresh_interval_ms: number;
  profiles: RustPbxMediaReadinessProfile[];
}

export interface RustPbxMediaReadinessProbeChecks {
  route_snapshot(now: Date): Promise<RustPbxMediaReadinessCheck>;
  media_control(): Promise<RustPbxMediaReadinessCheck>;
}

interface RustPbxMediaDependencyReadiness {
  checked_at_ms: number;
  route_snapshot: RustPbxMediaReadinessCheck;
  media_control: RustPbxMediaReadinessCheck;
}

export class RustPbxMediaReadinessProbe {
  readonly #config: RustPbxMediaReadinessProbeConfig;
  readonly #checks: RustPbxMediaReadinessProbeChecks;
  #lastEvaluation: RustPbxMediaReadiness | null = null;
  #dependencyCache: RustPbxMediaDependencyReadiness | null = null;
  #dependencyRefresh: Promise<RustPbxMediaDependencyReadiness> | null = null;

  constructor(
    config: RustPbxMediaReadinessProbeConfig,
    checks?: RustPbxMediaReadinessProbeChecks
  ) {
    const endpoint = new URL(config.media_control_endpoint);
    if (endpoint.href !== 'https://localhost:3211/' ||
        endpoint.username || endpoint.password ||
        endpoint.search || endpoint.hash) {
      throw new Error('RustPBX media-control readiness endpoint is invalid');
    }
    if (!Buffer.isBuffer(config.media_control_identity) ||
        config.media_control_identity.length < 1 ||
        !Buffer.isBuffer(config.media_control_ca) ||
        config.media_control_ca.length < 1) {
      throw new Error('RustPBX media-control readiness mTLS is required');
    }
    if (!Number.isSafeInteger(config.media_control_timeout_ms) ||
        config.media_control_timeout_ms < 50 ||
        config.media_control_timeout_ms > 5_000) {
      throw new Error('RustPBX media-control readiness timeout is invalid');
    }
    if (!Number.isSafeInteger(config.refresh_interval_ms) ||
        config.refresh_interval_ms < 100 ||
        config.refresh_interval_ms > 30_000) {
      throw new Error('RustPBX media readiness refresh interval is invalid');
    }
    this.#config = {
      ...config,
      profiles: validateProfiles(config.profiles),
      media_control_identity: Buffer.from(config.media_control_identity),
      media_control_ca: Buffer.from(config.media_control_ca)
    };
    this.#checks = checks || {
      route_snapshot: (now) => this.#routeSnapshot(now),
      media_control: () => this.#mediaControl()
    };
  }

  async evaluate(
    state: ComponentNodeStateSnapshot,
    now: Date
  ): Promise<RustPbxMediaReadiness> {
    const dependencies = await this.#dependencies(now);
    const evaluation = evaluateRustPbxMediaReadiness({
      route_snapshot: dependencies.route_snapshot,
      media_control: dependencies.media_control,
      profiles: this.#config.profiles,
      dimensions: state.dimensions
    });
    this.#lastEvaluation = evaluation;
    return evaluation;
  }

  prometheusMetrics(): string {
    return renderRustPbxMediaReadinessMetrics(
      this.#lastEvaluation,
      this.#config.profiles.map((profile) => profile.id)
    );
  }

  async #dependencies(now: Date): Promise<RustPbxMediaDependencyReadiness> {
    const checkedAtMs = now.getTime();
    const cachedAgeMs = this.#dependencyCache
      ? checkedAtMs - this.#dependencyCache.checked_at_ms
      : Number.POSITIVE_INFINITY;
    if (this.#dependencyCache &&
        cachedAgeMs >= 0 &&
        cachedAgeMs < this.#config.refresh_interval_ms) {
      return this.#dependencyCache;
    }
    if (this.#dependencyRefresh) return this.#dependencyRefresh;

    const refresh = Promise.all([
      this.#checks.route_snapshot(now),
      this.#checks.media_control()
    ]).then(([routeSnapshot, mediaControl]) => ({
      checked_at_ms: checkedAtMs,
      route_snapshot: routeSnapshot,
      media_control: mediaControl
    }));
    this.#dependencyRefresh = refresh;
    try {
      const dependencies = await refresh;
      this.#dependencyCache = dependencies;
      return dependencies;
    } finally {
      if (this.#dependencyRefresh === refresh) {
        this.#dependencyRefresh = null;
      }
    }
  }

  async #routeSnapshot(now: Date): Promise<RustPbxMediaReadinessCheck> {
    try {
      const metadata = await stat(this.#config.route_snapshot_file);
      if (!metadata.isFile() || metadata.size < 1 ||
          metadata.size > 64 * 1024 * 1024) {
        return { ready: false, code: 'invalid' };
      }
      const raw = await readFile(this.#config.route_snapshot_file, 'utf8');
      verifyRustPbxRouteSnapshotEnvelope(raw, {
        signing_key: this.#config.route_snapshot_signing_key,
        tenant_id: this.#config.route_tenant_id,
        profile_id: this.#config.route_profile_id,
        now
      });
      return { ready: true, code: 'fresh' };
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      return {
        ready: false,
        code: /expired/i.test(message) ? 'expired' : 'unavailable'
      };
    }
  }

  #mediaControl(): Promise<RustPbxMediaReadinessCheck> {
    return new Promise((resolve) => {
      const endpoint = new URL('/readyz', this.#config.media_control_endpoint);
      const call = request(endpoint, {
        method: 'GET',
        key: this.#config.media_control_identity,
        cert: this.#config.media_control_identity,
        ca: this.#config.media_control_ca,
        rejectUnauthorized: true,
        servername: 'localhost',
        timeout: this.#config.media_control_timeout_ms
      }, (response) => {
        response.resume();
        response.once('end', () => resolve(
          response.statusCode === 200
            ? { ready: true, code: 'available' }
            : { ready: false, code: 'unavailable' }
        ));
      });
      call.once('timeout', () => call.destroy(new Error('timeout')));
      call.once('error', () => resolve({
        ready: false,
        code: 'unavailable'
      }));
      call.end();
    });
  }
}

export function evaluateRustPbxMediaReadiness(input: {
  route_snapshot: RustPbxMediaReadinessCheck;
  media_control: RustPbxMediaReadinessCheck;
  profiles: RustPbxMediaReadinessProfile[];
  dimensions: FlatCapacityState;
}): RustPbxMediaReadiness {
  const profiles = validateProfiles(input.profiles);
  const profileReadiness: Record<string, RustPbxMediaProfileReadiness> = {};
  for (const profile of profiles) {
    const limitingDimensions = Object.entries(profile.required_capacity)
      .filter(([dimension, required]) => {
        const state = input.dimensions[dimension];
        return !state ||
          state.safe_capacity - state.used - state.reserved < required;
      })
      .map(([dimension]) => dimension)
      .sort();
    profileReadiness[profile.id] = {
      ready: limitingDimensions.length === 0,
      limiting_dimensions: limitingDimensions
    };
  }

  const requiredProfilesReady = profiles
    .filter((profile) => profile.required_for_pod_readiness)
    .every((profile) => profileReadiness[profile.id]?.ready);
  const failureStages: RustPbxMediaReadinessFailureStage[] = [];
  if (!input.route_snapshot.ready) failureStages.push('route_snapshot');
  if (!input.media_control.ready) failureStages.push('media_control');
  if (!requiredProfilesReady) failureStages.push('profile_capacity');

  return {
    ready: failureStages.length === 0,
    failure_stages: failureStages,
    route_snapshot: checkedCheck(input.route_snapshot, 'route snapshot'),
    media_control: checkedCheck(input.media_control, 'media control'),
    profiles: profileReadiness
  };
}

export function renderRustPbxMediaReadinessMetrics(
  readiness: RustPbxMediaReadiness | null,
  profileIds: string[]
): string {
  const profiles = validateMetricProfileIds(profileIds);
  const lines = [
    '# HELP ivekit_rustpbx_media_ready Composite RustPBX media admission readiness.',
    '# TYPE ivekit_rustpbx_media_ready gauge',
    `ivekit_rustpbx_media_ready ${readiness?.ready ? 1 : 0}`,
    '# HELP ivekit_rustpbx_media_readiness RustPBX media dependency readiness by bounded failure stage.',
    '# TYPE ivekit_rustpbx_media_readiness gauge'
  ];
  for (const stage of [
    'route_snapshot',
    'media_control',
    'profile_capacity'
  ] as const) {
    const ready = readiness
      ? !readiness.failure_stages.includes(stage)
      : false;
    lines.push(
      `ivekit_rustpbx_media_readiness{failure_stage="${stage}"} ${ready ? 1 : 0}`
    );
  }
  lines.push(
    '# HELP ivekit_rustpbx_media_profile_ready RustPBX media admission readiness by bounded profile.',
    '# TYPE ivekit_rustpbx_media_profile_ready gauge'
  );
  for (const profile of profiles) {
    lines.push(
      `ivekit_rustpbx_media_profile_ready{profile="${profile}"} ` +
      `${readiness?.profiles[profile]?.ready ? 1 : 0}`
    );
  }
  return `${lines.join('\n')}\n`;
}

function validateProfiles(
  profiles: RustPbxMediaReadinessProfile[]
): RustPbxMediaReadinessProfile[] {
  if (!Array.isArray(profiles) || profiles.length < 1 || profiles.length > 32) {
    throw new Error('RustPBX media readiness profiles are invalid');
  }
  const ids = new Set<string>();
  let requiredProfiles = 0;
  for (const profile of profiles) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(profile.id) ||
        ids.has(profile.id)) {
      throw new Error('RustPBX media readiness profile id is invalid');
    }
    ids.add(profile.id);
    if (profile.required_for_pod_readiness) requiredProfiles += 1;
    const capacities = Object.entries(profile.required_capacity);
    if (capacities.length < 1 || capacities.length > 32) {
      throw new Error('RustPBX media readiness profile capacity is invalid');
    }
    for (const [dimension, required] of capacities) {
      if (!/^[a-z][a-z0-9_.-]{0,127}$/.test(dimension) ||
          !Number.isSafeInteger(required) || required < 1 ||
          required > 1_000_000_000) {
        throw new Error('RustPBX media readiness profile capacity is invalid');
      }
    }
  }
  if (requiredProfiles < 1) {
    throw new Error('RustPBX media readiness requires a Pod readiness profile');
  }
  return profiles;
}

function checkedCheck(
  check: RustPbxMediaReadinessCheck,
  label: string
): RustPbxMediaReadinessCheck {
  if (typeof check.ready !== 'boolean' ||
      !/^[a-z][a-z0-9_.-]{0,63}$/.test(check.code)) {
    throw new Error(`RustPBX ${label} readiness check is invalid`);
  }
  return { ...check };
}

function validateMetricProfileIds(profileIds: string[]): string[] {
  if (!Array.isArray(profileIds) || profileIds.length < 1 || profileIds.length > 32) {
    throw new Error('RustPBX media readiness metric profiles are invalid');
  }
  const unique = new Set<string>();
  for (const profile of profileIds) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(profile) ||
        unique.has(profile)) {
      throw new Error('RustPBX media readiness metric profile is invalid');
    }
    unique.add(profile);
  }
  return [...unique].sort();
}
