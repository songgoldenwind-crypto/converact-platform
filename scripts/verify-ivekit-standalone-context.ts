import { resolveFabricEnv } from '../src/config/converact-env.js';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { buildIveKitStandaloneContext } from './ivekit-standalone-build-context.js';

const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const outputDir = resolve(
  resolveFabricEnv(process.env, 'STANDALONE_CONTEXT_DIR') || join(repoRoot, '.tmp', 'ivekit-standalone-context')
);
const result = buildIveKitStandaloneContext({
  repoRoot,
  outputDir,
  sourceCommit: resolveFabricEnv(process.env, 'SOURCE_COMMIT')
});
const npmCiArgs = ['ci', '--ignore-scripts'];
if (resolveFabricEnv(process.env, 'STANDALONE_NPM_OFFLINE') === '1') npmCiArgs.push('--offline');
run('npm', npmCiArgs, outputDir);
run('npm', ['run', 'build'], outputDir);
const entrypoints = [
  'converact-server.js',
  'converact-worker.js',
  'converact-realtime-audio-tap-worker.js',
  'converact-migrate.js',
  'converact-init-runtime-role.js',
  'converact-intelligence-preflight.js',
  'converact-kamailio-compose-config.js',
  'converact-render-kamailio-config.js',
  'converact-kamailio-route-agent.js',
  'converact-kamailio-webphone-acceptance.js',
  'converact-render-rustpbx-config.js',
  'converact-rustpbx-route-snapshot.js',
  'converact-rustpbx-recording-spool.js',
  'converact-component-node-admission.js',
  'converact-rustpbx-recovery.js',
  'converact-dialog-shadow-agent.js',
  'converact-voice-preflight.js'
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
