#!/usr/bin/env node
import { resolveConveractEnv } from '../src/config/converact-env.js';

import { fileURLToPath } from 'node:url';

import {
  runTinodeStaircase,
  type TinodeStaircaseConfigInput
} from './capacity/tinode-staircase.js';

function parseArguments(argv: string[], env: NodeJS.ProcessEnv): TinodeStaircaseConfigInput {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
    if (values.has(argument)) throw new Error(`${argument} may only be supplied once`);
    values.set(argument, value);
    index += 1;
  }
  const required = (flag: string, environmentKey: string): string => {
    const value = String(values.get(flag) || resolveConveractEnv(env, environmentKey) || '').trim();
    if (!value) throw new Error(`${flag} or ${environmentKey} is required`);
    return value;
  };
  const optionalInteger = (flag: string, environmentKey: string): number | undefined => {
    const raw = String(values.get(flag) || resolveConveractEnv(env, environmentKey) || '').trim();
    if (!raw) return undefined;
    const parsed = Number(raw);
    if (!Number.isInteger(parsed)) throw new Error(`${flag} must be an integer`);
    return parsed;
  };
  const rawPoints = String(
    values.get('--points') || env.IVEKIT_TINODE_STAIRCASE_POINTS || ''
  ).trim();
  return {
    output_file: required('--output-file', 'IVEKIT_TINODE_STAIRCASE_OUTPUT_FILE'),
    tinode_image: required('--tinode-image', 'IVEKIT_TINODE_IMAGE'),
    postgres_image: required('--postgres-image', 'IVEKIT_POSTGRES_IMAGE'),
    ...(rawPoints
      ? {
        points: rawPoints.split(',').map((value) => {
          const parsed = Number(value.trim());
          if (!Number.isInteger(parsed)) throw new Error('--points must be comma-separated integers');
          return parsed;
        })
      }
      : {}),
    ...optional('--tinode-port', 'IVEKIT_TINODE_STAIRCASE_PORT', 'tinode_port'),
    ...optional(
      '--connection-ramp-per-second',
      'IVEKIT_TINODE_CONNECTION_RAMP_PER_SECOND',
      'connection_ramp_per_second'
    ),
    ...optional(
      '--interaction-start-rate-per-second',
      'IVEKIT_TINODE_INTERACTION_START_RATE_PER_SECOND',
      'interaction_start_rate_per_second'
    ),
    ...optional(
      '--sample-interval-ms',
      'IVEKIT_TINODE_SAMPLE_INTERVAL_MS',
      'sample_interval_ms'
    )
  };

  function optional(
    flag: string,
    environmentKey: string,
    key: 'tinode_port' |
      'connection_ramp_per_second' |
      'interaction_start_rate_per_second' |
      'sample_interval_ms'
  ): Partial<TinodeStaircaseConfigInput> {
    const value = optionalInteger(flag, environmentKey);
    return value === undefined ? {} : { [key]: value };
  }
}

async function main(): Promise<void> {
  const config = parseArguments(process.argv.slice(2), process.env);
  const evidence = await runTinodeStaircase(config);
  process.stdout.write(`${JSON.stringify({
    evidence_id: evidence.evidence_id,
    status: evidence.status,
    output_file: config.output_file,
    points: evidence.points.map((point) => ({
      connections: point.connections,
      status: point.status,
      accepted: point.reconciliation.client_accepted,
      live_sessions_max: point.reconciliation.sut_live_sessions_max
    }))
  })}\n`);
  if (evidence.status !== 'controlled_pass') process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
