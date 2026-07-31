import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  runSipKamailioStaircase,
  type SipKamailioStaircaseConfigInput
} from './capacity/sip-kamailio-staircase.js';

export function sipKamailioStaircaseConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env
): SipKamailioStaircaseConfigInput {
  return {
    output_file: absoluteRequired(env, 'IVEKIT_SIP_STAIRCASE_OUTPUT'),
    artifact_root: absoluteRequired(env, 'IVEKIT_SIP_STAIRCASE_ARTIFACT_ROOT'),
    runtime_root: absoluteRequired(env, 'IVEKIT_SIP_STAIRCASE_RUNTIME_ROOT'),
    points: points(env.IVEKIT_SIP_STAIRCASE_POINTS || '100,250,500,750,1000'),
    duration_seconds: integer(env.IVEKIT_SIP_STAIRCASE_DURATION_SECONDS, 20),
    sipp_binary: absoluteRequired(env, 'IVEKIT_SIPP_BINARY'),
    rustpbx_image: required(env, 'RUSTPBX_IMAGE'),
    kamailio_image: required(env, 'KAMAILIO_IMAGE'),
    postgres_image: required(env, 'POSTGRES_IMAGE'),
    python_image: required(env, 'PYTHON_IMAGE'),
    capacity_tools_image: required(env, 'CAPACITY_TOOLS_IMAGE'),
    node_command: resolve(env.IVEKIT_NODE_COMMAND || process.execPath),
    rate_tolerance_ratio: number(env.RATE_TOLERANCE_RATIO, 0.03),
    maximum_route_p95_ms: number(env.MAX_SIP_ROUTE_P95_MS, 150),
    maximum_route_p99_ms: number(env.MAX_SIP_ROUTE_P99_MS, 250),
    cdr_drain_seconds: integer(env.CDR_DRAIN_SECONDS, 60),
    kamailio_shm_allocator: allocator(env.KAMAILIO_SHM_ALLOCATOR),
    kamailio_shm_memory_mb: integer(env.KAMAILIO_SHM_MEMORY_MB, 512),
    kamailio_pkg_memory_mb: integer(env.KAMAILIO_PKG_MEMORY_MB, 32)
  };
}

function allocator(value: string | undefined): 'fm' | 'qm' | 'tlsf' {
  const output = String(value || 'fm').trim().toLowerCase();
  if (!['fm', 'qm', 'tlsf'].includes(output)) {
    throw new Error('KAMAILIO_SHM_ALLOCATOR must be fm, qm, or tlsf');
  }
  return output as 'fm' | 'qm' | 'tlsf';
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = String(env[name] || '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function absoluteRequired(env: NodeJS.ProcessEnv, name: string): string {
  const value = required(env, name);
  if (!value.startsWith('/')) throw new Error(`${name} must be an absolute path`);
  return resolve(value);
}

function points(value: string): number[] {
  const output = value.split(',').map((entry) => Number(entry.trim()));
  if (output.some((entry) => !Number.isInteger(entry))) {
    throw new Error('IVEKIT_SIP_STAIRCASE_POINTS must be comma-separated integers');
  }
  return output;
}

function integer(value: string | undefined, fallback: number): number {
  const output = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(output)) throw new Error('invalid SIP staircase integer');
  return output;
}

function number(value: string | undefined, fallback: number): number {
  const output = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(output)) throw new Error('invalid SIP staircase number');
  return output;
}

const invoked = process.argv[1] ? resolve(process.argv[1]) : '';
if (invoked === fileURLToPath(import.meta.url)) {
  void runSipKamailioStaircase(sipKamailioStaircaseConfigFromEnv()).then((evidence) => {
    process.stdout.write(`${JSON.stringify({
      run_id: evidence.run_id,
      status: evidence.status,
      points: evidence.points.map((point) => ({
        target_cps: point.target_cps,
        status: point.status,
        successful_calls: point.baseline?.successful_calls ?? null,
        sip_route_p99_ms: point.baseline?.sip_route_p99_ms ?? null
      }))
    }, null, 2)}\n`);
    if (evidence.status !== 'controlled_pass') process.exitCode = 1;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : 'SIP staircase failed'}\n`);
    process.exitCode = 1;
  });
}
