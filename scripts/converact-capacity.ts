import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  compileLoadRunManifest,
  validateLoadRunManifest,
  type CapacityWorkloadProfile,
  type CompileLoadRunManifestInput,
  type CompiledLoadRunManifest,
  type LoadRunManifest
} from './capacity/profile-compiler.js';

interface ManifestFilesInput {
  profile_path: string;
  fork_manifest_path: string;
}

interface CompileManifestFilesInput extends ManifestFilesInput {
  run_config_path: string;
  output_path: string;
}

interface ValidateManifestBundleInput extends ManifestFilesInput {
  bundle_path: string;
}

type RunConfig = Omit<CompileLoadRunManifestInput, 'profile' | 'forkManifest'>;

export function compileCapacityManifestFiles(
  input: CompileManifestFilesInput
): CompiledLoadRunManifest {
  const profile = readJson<CapacityWorkloadProfile>(input.profile_path, 'workload profile');
  const forkManifest = readJson<{ manifest_id: string; [key: string]: unknown }>(
    input.fork_manifest_path,
    'fork manifest'
  );
  const config = readJson<RunConfig>(input.run_config_path, 'run config');
  const compiled = compileLoadRunManifest({
    profile,
    forkManifest,
    run: config.run,
    topology: config.topology,
    shardSizeByWorkloadId: config.shardSizeByWorkloadId
  });
  const outputPath = resolve(input.output_path);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(compiled, null, 2)}\n`, { mode: 0o600 });
  return compiled;
}

export function validateCapacityManifestBundleFile(
  input: ValidateManifestBundleInput
): CompiledLoadRunManifest {
  const profile = readJson<CapacityWorkloadProfile>(input.profile_path, 'workload profile');
  const forkManifest = readJson<{ manifest_id: string; [key: string]: unknown }>(
    input.fork_manifest_path,
    'fork manifest'
  );
  const bundle = readJson<{
    manifest?: LoadRunManifest;
    manifest_sha256?: string;
  }>(input.bundle_path, 'capacity manifest bundle');
  if (!bundle.manifest || !/^[a-f0-9]{64}$/.test(String(bundle.manifest_sha256 || ''))) {
    throw new Error('capacity manifest bundle is malformed');
  }
  validateLoadRunManifest(bundle.manifest, bundle.manifest_sha256!, profile, forkManifest);
  return {
    manifest: bundle.manifest,
    manifest_sha256: bundle.manifest_sha256!
  };
}

function readJson<T>(path: string, label: string): T {
  const resolved = resolve(path);
  const size = statSync(resolved).size;
  if (size <= 0 || size > 16 * 1024 * 1024) throw new Error(`${label} size is invalid`);
  try {
    return JSON.parse(readFileSync(resolved, 'utf8')) as T;
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function flags(args: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith('--') || !value || value.startsWith('--')) {
      throw new Error(`invalid CLI argument near ${flag || '<end>'}`);
    }
    if (values[flag]) throw new Error(`duplicate CLI flag ${flag}`);
    values[flag] = value;
  }
  return values;
}

function required(values: Record<string, string>, name: string): string {
  const value = values[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0];
  const values = flags(args.slice(1));
  if (command === 'compile-manifest') {
    const outputPath = required(values, '--output');
    const compiled = compileCapacityManifestFiles({
      profile_path: required(values, '--profile'),
      fork_manifest_path: required(values, '--fork-manifest'),
      run_config_path: required(values, '--run-config'),
      output_path: outputPath
    });
    process.stdout.write(`${JSON.stringify({
      status: 'compiled',
      output_path: resolve(outputPath),
      run_id: compiled.manifest.run_id,
      profile_id: compiled.manifest.profile_id,
      shard_count: compiled.manifest.shards.length,
      manifest_sha256: compiled.manifest_sha256
    }, null, 2)}\n`);
    return;
  }
  if (command === 'validate-manifest') {
    const bundlePath = required(values, '--bundle');
    const compiled = validateCapacityManifestBundleFile({
      profile_path: required(values, '--profile'),
      fork_manifest_path: required(values, '--fork-manifest'),
      bundle_path: bundlePath
    });
    process.stdout.write(`${JSON.stringify({
      status: 'valid',
      bundle_path: resolve(bundlePath),
      run_id: compiled.manifest.run_id,
      manifest_sha256: compiled.manifest_sha256
    }, null, 2)}\n`);
    return;
  }
  throw new Error(
    'usage: converact-capacity <compile-manifest|validate-manifest> --profile PATH --fork-manifest PATH ...'
  );
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

