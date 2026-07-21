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
const entrypoints = [
  'ivekit-server.js',
  'ivekit-worker.js',
  'ivekit-migrate.js',
  'ivekit-init-runtime-role.js',
  'ivekit-intelligence-preflight.js',
  'ivekit-kamailio-compose-config.js',
  'ivekit-render-kamailio-config.js',
  'ivekit-kamailio-route-agent.js',
  'ivekit-kamailio-webphone-acceptance.js',
  'ivekit-render-rustpbx-config.js',
  'ivekit-rustpbx-route-snapshot.js',
  'ivekit-rustpbx-recording-spool.js',
  'ivekit-component-node-admission.js',
  'ivekit-rustpbx-recovery.js',
  'ivekit-voice-preflight.js'
].map((name) => join(outputDir, 'dist', name));
for (const entrypoint of entrypoints) {
  if (!existsSync(entrypoint)) {
    throw new Error(`iveKit standalone build did not emit ${entrypoint}`);
  }
}

process.stdout.write(`${JSON.stringify({
  status: 'passed',
  output_dir: outputDir,
  source_commit: result.manifest.source_commit,
  source_files: result.manifest.source_files,
  runtime_packages: result.manifest.runtime_packages,
  entrypoints
}, null, 2)}\n`);

function run(command: string, args: string[], cwd: string): void {
  const child = spawnSync(command, args, { cwd, encoding: 'utf8', stdio: 'pipe' });
  if (child.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} failed\n${child.stdout || ''}${child.stderr || ''}`.trim());
  }
}
