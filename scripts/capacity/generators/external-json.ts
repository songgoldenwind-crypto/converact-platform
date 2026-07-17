import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const DEFAULT_MAX_RESULT_BYTES = 16 * 1024 * 1024;

export interface ExternalJsonGeneratorPlan<TInput extends Record<string, unknown>> {
  executable: string;
  binary_version: string;
  binary_sha256: string;
  args: string[];
  input: TInput;
  result_path: string;
  timeout_ms: number;
  max_result_bytes?: number;
}

export interface ExternalJsonGeneratorProcessResult {
  code: number;
  timed_out: boolean;
  aborted: boolean;
  stdout: string;
  stderr: string;
  raw: Record<string, unknown> | null;
}

export type ExternalJsonGeneratorExecutor<TInput extends Record<string, unknown>> = (
  plan: ExternalJsonGeneratorPlan<TInput>,
  options?: { signal?: AbortSignal }
) => Promise<ExternalJsonGeneratorProcessResult>;

export async function executeExternalJsonGenerator<TInput extends Record<string, unknown>>(
  plan: ExternalJsonGeneratorPlan<TInput>,
  options: { signal?: AbortSignal } = {}
): Promise<ExternalJsonGeneratorProcessResult> {
  validatePlan(plan);
  const actualDigest = createHash('sha256').update(readFileSync(plan.executable)).digest('hex');
  if (actualDigest !== plan.binary_sha256) throw new Error('generator binary SHA-256 mismatch');
  mkdirSync(dirname(plan.result_path), { recursive: true });
  rmSync(plan.result_path, { force: true });
  const process = await spawnJson(plan, options.signal);
  if (process.code !== 0 || process.timed_out || process.aborted) {
    return { ...process, raw: null };
  }
  const resultStat = statSync(plan.result_path);
  if (!resultStat.isFile()) throw new Error('generator result path is not a regular file');
  if (resultStat.size > (plan.max_result_bytes ?? DEFAULT_MAX_RESULT_BYTES)) {
    throw new Error('generator result JSON exceeds size limit');
  }
  const raw = JSON.parse(readFileSync(plan.result_path, 'utf8'));
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('generator result JSON must be an object');
  }
  return { ...process, raw };
}

function spawnJson<TInput extends Record<string, unknown>>(
  plan: ExternalJsonGeneratorPlan<TInput>,
  signal?: AbortSignal
): Promise<Omit<ExternalJsonGeneratorProcessResult, 'raw'>> {
  return new Promise((resolve) => {
    const child = spawn(plan.executable, plan.args, {
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let aborted = false;
    let settled = false;
    const append = (current: string, chunk: Buffer) =>
      `${current}${chunk.toString('utf8')}`.slice(-2 * 1024 * 1024);
    child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk); });
    child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk); });
    child.stdin.on('error', (error) => {
      stderr = append(stderr, Buffer.from(error.message));
    });
    child.stdin.end(`${JSON.stringify(plan.input)}\n`);
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ code, timed_out: timedOut, aborted, stdout, stderr });
    };
    const abort = () => {
      aborted = true;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, plan.timeout_ms);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    child.on('error', (error) => {
      stderr = append(stderr, Buffer.from(error.message));
      finish(-1);
    });
    child.on('close', (code) => finish(code ?? -1));
  });
}

function validatePlan<TInput extends Record<string, unknown>>(
  plan: ExternalJsonGeneratorPlan<TInput>
): void {
  if (!plan.executable.startsWith('/') || /[\r\n\0]/.test(plan.executable) ||
      !plan.result_path.startsWith('/') || /[\r\n\0]/.test(plan.result_path) ||
      !plan.binary_version || plan.binary_version.length > 255 ||
      !/^[a-f0-9]{64}$/.test(plan.binary_sha256) ||
      !Number.isInteger(plan.timeout_ms) || plan.timeout_ms < 1_000 ||
      plan.timeout_ms > 86_500_000 ||
      plan.args.some((arg) => typeof arg !== 'string' || /[\r\n\0]/.test(arg))) {
    throw new Error('invalid external generator plan');
  }
  if (plan.max_result_bytes != null &&
      (!Number.isInteger(plan.max_result_bytes) ||
       plan.max_result_bytes < 1 ||
       plan.max_result_bytes > DEFAULT_MAX_RESULT_BYTES)) {
    throw new Error('invalid generator result size limit');
  }
}
