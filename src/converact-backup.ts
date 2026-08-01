import { resolveFabricEnv } from './config/converact-env.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createConveractFabricBackupId,
  runConveractFabricBackup
} from './agent-runtime/converact/operations/backup-runner.js';

export interface ConveractFabricBackupCliOptions {
  backup_id: string;
  output_directory: string;
}

export function parseConveractFabricBackupCli(
  args: string[],
  env: NodeJS.ProcessEnv = process.env,
  now = new Date()
): ConveractFabricBackupCliOptions {
  let output = '';
  let backupId = '';
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--output') output = requiredValue(args[++index], '--output');
    else if (argument === '--backup-id') backupId = requiredValue(args[++index], '--backup-id');
    else throw cliError('backup_argument_invalid');
  }
  backupId ||= createConveractFabricBackupId(now);
  if (output) return { backup_id: backupId, output_directory: resolve(output) };
  const root = String(resolveFabricEnv(env, 'BACKUP_ROOT') || '').trim();
  if (!root) throw cliError('backup_root_required');
  return { backup_id: backupId, output_directory: resolve(root, backupId) };
}

export async function mainConveractFabricBackup(
  args = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const options = parseConveractFabricBackupCli(args, env);
  const result = await runConveractFabricBackup({
    directory: options.output_directory,
    backup_id: options.backup_id,
    env
  });
  process.stdout.write(`${JSON.stringify({
    status: result.status,
    backup_id: result.manifest.backup_id,
    directory: result.directory,
    object_count: result.manifest.objects.object_count,
    created_at: result.manifest.created_at
  }, null, 2)}\n`);
}

function requiredValue(value: string | undefined, name: string): string {
  if (!value || value.startsWith('--')) throw cliError(`${name.slice(2).replaceAll('-', '_')}_required`);
  return value;
}

function cliError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  mainConveractFabricBackup().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: 'failed',
      code: String((error as { code?: unknown }).code || 'backup_failed')
    })}\n`);
    process.exitCode = 1;
  });
}
