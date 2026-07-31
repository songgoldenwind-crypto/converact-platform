import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runIveKitRestore } from './agent-runtime/converact/operations/backup-runner.js';

export interface IveKitRestoreCliOptions {
  backup_directory: string;
  execute: boolean;
}

export function parseIveKitRestoreCli(args: string[]): IveKitRestoreCliOptions {
  let backup = '';
  let execute = false;
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--backup') backup = requiredValue(args[++index]);
    else if (argument === '--execute') execute = true;
    else throw cliError('restore_argument_invalid');
  }
  if (!backup) throw cliError('restore_backup_required');
  return { backup_directory: resolve(backup), execute };
}

export async function mainIveKitRestore(
  args = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env
): Promise<void> {
  const options = parseIveKitRestoreCli(args);
  const result = await runIveKitRestore({
    directory: options.backup_directory,
    execute: options.execute,
    env
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

function requiredValue(value: string | undefined): string {
  if (!value || value.startsWith('--')) throw cliError('restore_backup_required');
  return value;
}

function cliError(code: string): Error {
  return Object.assign(new Error(code), { code });
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  mainIveKitRestore().catch((error) => {
    process.stderr.write(`${JSON.stringify({
      status: 'failed',
      code: String((error as { code?: unknown }).code || 'restore_failed')
    })}\n`);
    process.exitCode = 1;
  });
}
