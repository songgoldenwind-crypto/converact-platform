import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

type CheckId = 'provider-gateway' | 'ai-worker' | 'voice-media';

interface SidecarCheck {
  id: CheckId;
  label: string;
  command: string;
  args: string[];
  cwd: string;
  optionalWhenMissing?: boolean;
}

const rootDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const checks: SidecarCheck[] = [
  {
    id: 'provider-gateway',
    label: 'Go provider gateway',
    command: 'go',
    args: ['build', '.'],
    cwd: resolve(rootDir, 'services/provider-gateway-go')
  },
  {
    id: 'ai-worker',
    label: 'Python AI worker',
    command: 'python3',
    args: ['-m', 'compileall', '-q', 'services/ai-worker-py'],
    cwd: rootDir
  },
  {
    id: 'voice-media',
    label: 'Rust voice media',
    command: 'cargo',
    args: ['check', '--manifest-path', 'services/voice-media-rs/Cargo.toml'],
    cwd: rootDir,
    optionalWhenMissing: true
  }
];

const requested = new Set(process.argv.slice(2));
const selected = requested.size && !requested.has('all')
  ? checks.filter((check) => requested.has(check.id))
  : checks;

if (!selected.length) {
  console.error(`Unknown sidecar check: ${[...requested].join(', ')}`);
  process.exit(1);
}

let failed = false;

for (const check of selected) {
  if (!existsSync(check.cwd)) {
    console.error(`[sidecar-check] ${check.label}: directory missing: ${check.cwd}`);
    failed = true;
    continue;
  }

  if (!commandExists(check.command)) {
    const message = `[sidecar-check] ${check.label}: ${check.command} not found`;
    if (check.optionalWhenMissing) {
      console.warn(`${message}; skipped on this machine`);
      continue;
    }
    console.error(message);
    failed = true;
    continue;
  }

  console.log(`[sidecar-check] ${check.label}: ${check.command} ${check.args.join(' ')}`);
  const result = spawnSync(check.command, check.args, {
    cwd: check.cwd,
    stdio: 'inherit'
  });
  if (result.status !== 0) {
    failed = true;
  }
}

process.exit(failed ? 1 : 0);

function commandExists(command: string): boolean {
  const result = spawnSync('/bin/sh', ['-c', `command -v ${shellQuote(command)} >/dev/null 2>&1`], {
    stdio: 'ignore'
  });
  return result.status === 0;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
