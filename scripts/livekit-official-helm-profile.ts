import { readFile } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parse } from 'yaml';

export interface LiveKitOfficialHelmProfileSummary {
  image_reference: string;
  minimum_replicas: number;
  maximum_replicas: number;
  rtc_udp_port_count: number;
  cpu_limit_present: boolean;
  redis_password_secret: string;
  redis_tls_secret: string;
}

export function validateLiveKitOfficialHelmProfile(
  input: unknown
): LiveKitOfficialHelmProfileSummary {
  const values = object(input, 'values');
  const image = object(values.image, 'image');
  const repository = text(image.repository, 'image.repository');
  const tag = text(image.tag, 'image.tag');
  if (!/^v[0-9][A-Za-z0-9.+-]*@sha256:[a-f0-9]{64}$/.test(tag)) {
    throw new Error('production profile requires an immutable LiveKit image digest');
  }

  const livekit = object(values.livekit, 'livekit');
  const rtc = object(livekit.rtc, 'livekit.rtc');
  const start = integer(rtc.port_range_start, 'livekit.rtc.port_range_start');
  const end = integer(rtc.port_range_end, 'livekit.rtc.port_range_end');
  if (start < 1024 || end > 65_535 || end < start || end - start + 1 < 10_000) {
    throw new Error('production profile requires a bounded RTC UDP port range of at least 10000 ports');
  }
  if (rtc.use_external_ip !== true || rtc.allow_tcp_fallback !== true ||
      object(rtc.congestion_control, 'livekit.rtc.congestion_control').enabled !== true ||
      rtc.strict_acks !== true) {
    throw new Error('production profile requires external IP, congestion control, TCP fallback and strict ACKs');
  }
  const pli = object(rtc.pli_throttle, 'livekit.rtc.pli_throttle');
  for (const quality of ['low_quality', 'mid_quality', 'high_quality']) {
    if (pli[quality] !== '100ms') {
      throw new Error('production profile requires the validated 100ms PLI throttle');
    }
  }

  const redis = object(livekit.redis, 'livekit.redis');
  for (const key of ['password', 'username', 'sentinel_password', 'sentinel_username']) {
    if (redis[key] !== undefined && redis[key] !== '') {
      throw new Error('Redis credentials must not be stored in livekit values');
    }
  }
  if (livekit.keys !== undefined) {
    throw new Error('LiveKit API credentials must not be stored in livekit values');
  }

  const keySecret = object(values.storeKeysInSecret, 'storeKeysInSecret');
  if (keySecret.enabled !== true || !text(keySecret.existingSecret, 'storeKeysInSecret.existingSecret')) {
    throw new Error('production profile requires an existing LiveKit API key Secret');
  }
  const passwordSecret = enabledSecret(values.redisPasswordSecret, 'redisPasswordSecret');
  const tlsSecret = enabledSecret(values.redisTLSSecret, 'redisTLSSecret');
  const redisTls = object(redis.tls, 'livekit.redis.tls');
  if (redisTls.enabled !== true || redisTls.insecure !== false ||
      redisTls.ca_cert_file !== '/etc/livekit-redis-tls/ca.crt' ||
      redisTls.client_cert_file !== '/etc/livekit-redis-tls/tls.crt' ||
      redisTls.client_key_file !== '/etc/livekit-redis-tls/tls.key') {
    throw new Error('production profile requires verified Redis TLS from the mounted Secret');
  }

  const autoscaling = object(values.autoscaling, 'autoscaling');
  const minimumReplicas = integer(autoscaling.minReplicas, 'autoscaling.minReplicas');
  const maximumReplicas = integer(autoscaling.maxReplicas, 'autoscaling.maxReplicas');
  const targetCpu = integer(
    autoscaling.targetCPUUtilizationPercentage,
    'autoscaling.targetCPUUtilizationPercentage'
  );
  if (autoscaling.enabled !== true || minimumReplicas < 2 ||
      maximumReplicas <= minimumReplicas || targetCpu < 40 || targetCpu > 65) {
    throw new Error('production profile requires bounded horizontal autoscaling');
  }
  if (values.podHostNetwork !== true) {
    throw new Error('production profile requires host networking for the media plane');
  }

  const resources = object(values.resources, 'resources');
  const requests = object(resources.requests, 'resources.requests');
  if (cpu(text(requests.cpu, 'resources.requests.cpu')) < 4 ||
      !text(requests.memory, 'resources.requests.memory')) {
    throw new Error('production profile media resource requests are too small');
  }
  const limits = object(resources.limits, 'resources.limits');
  const cpuLimitPresent = limits.cpu !== undefined && limits.cpu !== '';
  if (cpuLimitPresent) {
    throw new Error('production profile must not apply a CFS CPU limit to LiveKit');
  }

  const pdb = object(values.podDisruptionBudget, 'podDisruptionBudget');
  if (pdb.enabled !== true || integer(pdb.minAvailable, 'podDisruptionBudget.minAvailable') < 1) {
    throw new Error('production profile requires a PodDisruptionBudget');
  }
  const spreads = array(values.topologySpreadConstraints, 'topologySpreadConstraints');
  if (!spreads.some((entry) => {
    const spread = object(entry, 'topologySpreadConstraints entry');
    return spread.topologyKey === 'topology.kubernetes.io/zone' &&
      spread.whenUnsatisfiable === 'DoNotSchedule';
  })) {
    throw new Error('production profile requires hard zone spreading');
  }
  const affinity = JSON.stringify(object(values.affinity, 'affinity'));
  if (!affinity.includes('requiredDuringSchedulingIgnoredDuringExecution') ||
      !affinity.includes('kubernetes.io/hostname')) {
    throw new Error('production profile requires hard host anti-affinity');
  }

  return {
    image_reference: `${repository}:${tag}`,
    minimum_replicas: minimumReplicas,
    maximum_replicas: maximumReplicas,
    rtc_udp_port_count: end - start + 1,
    cpu_limit_present: cpuLimitPresent,
    redis_password_secret: passwordSecret,
    redis_tls_secret: tlsSecret
  };
}

function enabledSecret(value: unknown, label: string): string {
  const secret = object(value, label);
  if (secret.enabled !== true) throw new Error(`${label} must be enabled`);
  return text(secret.existingSecret, `${label}.existingSecret`);
}

function object(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, any>;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || /[\r\n\u0000]/.test(value)) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer`);
  return value as number;
}

function cpu(value: string): number {
  const amount = value.endsWith('m')
    ? Number(value.slice(0, -1)) / 1000
    : Number(value);
  return Number.isFinite(amount) ? amount : 0;
}

async function main(): Promise<void> {
  const valuesPath = process.argv.length === 2
    ? resolve('infra/livekit/helm/values.production-performance.yaml')
    : parseValuesPath(process.argv.slice(2));
  const raw = await readFile(valuesPath, 'utf8');
  const summary = validateLiveKitOfficialHelmProfile(parse(raw));
  process.stdout.write(`${JSON.stringify({
    status: 'passed',
    values_path: valuesPath,
    ...summary
  }, null, 2)}\n`);
}

function parseValuesPath(args: readonly string[]): string {
  if (args.length !== 2 || args[0] !== '--values' || !args[1]) {
    throw new Error('usage: livekit-official-helm-profile --values <resolved-values.yaml>');
  }
  const path = isAbsolute(args[1]) ? args[1] : resolve(args[1]);
  if (/[\r\n\u0000]/.test(path)) throw new Error('values path is invalid');
  return path;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
