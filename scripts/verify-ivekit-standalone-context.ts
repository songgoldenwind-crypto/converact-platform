import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { buildIveKitStandaloneContext } from './ivekit-standalone-build-context.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputDir = resolve(
  process.env.OPC_IVEKIT_STANDALONE_CONTEXT_DIR || join(repoRoot, '.tmp', 'ivekit-standalone-context')
);
const result = buildIveKitStandaloneContext({
  repoRoot,
  outputDir,
  sourceCommit: process.env.OPC_IVEKIT_SOURCE_COMMIT
});
const npmCiArgs = ['ci', '--ignore-scripts'];
if (process.env.OPC_IVEKIT_STANDALONE_NPM_OFFLINE === '1') npmCiArgs.push('--offline');
run('npm', npmCiArgs, outputDir);
run('npm', ['run', 'build'], outputDir);
const entrypoint = join(outputDir, 'dist', 'ivekit-server.js');
if (!existsSync(entrypoint)) throw new Error('iveKit standalone build did not emit dist/ivekit-server.js');

process.stdout.write(`${JSON.stringify({
  status: 'passed',
  output_dir: outputDir,
  source_commit: result.manifest.source_commit,
  source_files: result.manifest.source_files,
  runtime_packages: result.manifest.runtime_packages,
  entrypoint
}, null, 2)}\n`);

function run(command: string, args: string[], cwd: string): void {
  const child = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  if (child.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${child.stdout || ''}${child.stderr || ''}`.trim());
  }
}
