import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalSha256 } from '../canonical-json.js';
import type {
  CapacityShardExecutionResult,
  CapacityStartShardCommand
} from '../orchestrator/types.js';
import {
  validateCapacityShardExecutionResult,
  type CapacityShardDriver
} from '../orchestrator/worker-runtime.js';
import {
  executeExternalJsonGenerator,
  type ExternalJsonGeneratorExecutor
} from './external-json.js';

export interface ExternalCapacityWorkerSpec {
  schema_version: '1.0.0';
  executable: string;
  binary_version: string;
  binary_sha256: string;
  result_directory: string;
  timeout_ms: number;
  max_result_bytes?: number;
  args?: string[];
  static_input: Record<string, unknown>;
}

interface ExternalCapacityWorkerInput extends Record<string, unknown> {
  schema_version: '1.0.0';
  command: CapacityStartShardCommand;
  static_input: Record<string, unknown>;
  result_path: string;
}

export class ExternalJsonCapacityShardDriver implements CapacityShardDriver {
  readonly #spec: ExternalCapacityWorkerSpec;
  readonly #executor: ExternalJsonGeneratorExecutor<ExternalCapacityWorkerInput>;

  constructor(input: {
    spec: ExternalCapacityWorkerSpec;
    executor?: ExternalJsonGeneratorExecutor<ExternalCapacityWorkerInput>;
  }) {
    this.#spec = validateExternalCapacityWorkerSpec(input.spec);
    this.#executor = input.executor || executeExternalJsonGenerator;
  }

  async execute(
    command: CapacityStartShardCommand,
    options: { signal: AbortSignal }
  ): Promise<CapacityShardExecutionResult> {
    const resultId = canonicalSha256({
      run_id: command.run_id,
      phase_id: command.phase_id,
      shard_id: command.shard_id,
      worker_id: command.worker_id,
      lease_epoch: command.lease_epoch
    });
    const resultPath = join(this.#spec.result_directory, `${resultId}.json`);
    const executed = await this.#executor({
      executable: this.#spec.executable,
      binary_version: this.#spec.binary_version,
      binary_sha256: this.#spec.binary_sha256,
      args: [
        ...(this.#spec.args || []),
        'run',
        '--input-json',
        '-',
        '--result',
        resultPath
      ],
      input: {
        schema_version: '1.0.0',
        command: structuredClone(command),
        static_input: structuredClone(this.#spec.static_input),
        result_path: resultPath
      },
      result_path: resultPath,
      timeout_ms: this.#spec.timeout_ms,
      max_result_bytes: this.#spec.max_result_bytes
    }, options);
    if (executed.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new Error('capacity generator aborted');
    }
    if (executed.timed_out) throw new Error('capacity generator timed out');
    if (executed.code !== 0 || !executed.raw) {
      throw new Error(`capacity generator exited with ${executed.code}`);
    }
    return validateCapacityShardExecutionResult(
      executed.raw as unknown as CapacityShardExecutionResult
    );
  }
}

export function readExternalCapacityWorkerSpec(path: string): ExternalCapacityWorkerSpec {
  if (!path.startsWith('/') || /[\r\n\0]/.test(path)) {
    throw new Error('capacity worker driver spec path must be absolute');
  }
  const size = statSync(path).size;
  if (size <= 0 || size > 1024 * 1024) {
    throw new Error('capacity worker driver spec size is invalid');
  }
  return validateExternalCapacityWorkerSpec(
    JSON.parse(readFileSync(path, 'utf8')) as ExternalCapacityWorkerSpec
  );
}

export function validateExternalCapacityWorkerSpec(
  raw: ExternalCapacityWorkerSpec
): ExternalCapacityWorkerSpec {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
      raw.schema_version !== '1.0.0' ||
      !absolute(raw.executable) ||
      !absolute(raw.result_directory) ||
      !raw.binary_version || raw.binary_version.length > 255 ||
      !/^[a-f0-9]{64}$/.test(raw.binary_sha256) ||
      !Number.isInteger(raw.timeout_ms) || raw.timeout_ms < 1_000 ||
      raw.timeout_ms > 86_500_000 ||
      (raw.max_result_bytes != null &&
        (!Number.isInteger(raw.max_result_bytes) ||
         raw.max_result_bytes < 1 ||
         raw.max_result_bytes > 16 * 1024 * 1024)) ||
      (raw.args != null &&
        (!Array.isArray(raw.args) ||
         raw.args.some((arg) => typeof arg !== 'string' || /[\r\n\0]/.test(arg)))) ||
      !raw.static_input || typeof raw.static_input !== 'object' ||
      Array.isArray(raw.static_input)) {
    throw new Error('invalid capacity worker driver spec');
  }
  return structuredClone(raw);
}

function absolute(value: string): boolean {
  return typeof value === 'string' && value.startsWith('/') &&
    !/[\r\n\0]/.test(value) && !value.split('/').includes('..');
}
