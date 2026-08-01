import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('PowerShell compatibility boundary is packaged and loaded by Windows adapters', () => {
  const helper = readFileSync(join(root, 'scripts/converact-env-compat.ps1'), 'utf8');
  assert.match(helper, /function Resolve-ConveractEnvironmentAlias/);
  assert.match(helper, /function Install-ConveractEnvironmentAliases/);
  assert.match(helper, /CONVERACT_FABRIC_/);
  assert.match(helper, /OPC_IVEKIT_/);
  assert.match(helper, /conflicting branded environment variables/);
  assert.doesNotMatch(helper, /Write-(?:Host|Output).*Value/);

  for (const name of ['windows-disconnect.ps1', 'windows-restart.ps1']) {
    const adapter = readFileSync(
      join(root, 'scripts/rustdesk-edge-adapters', name),
      'utf8',
    );
    assert.match(adapter, /converact-env-compat\.ps1/);
    assert.match(adapter, /Install-ConveractEnvironmentAliases/);
  }

  const packager = readFileSync(join(root, 'scripts/rustdesk-windows-package.ts'), 'utf8');
  assert.match(packager, /converact-env-compat\.ps1/);
  const delivery = readFileSync(join(root, 'scripts/converact-delivery-bundle.ts'), 'utf8');
  assert.match(delivery, /converact-env-compat\.ps1/);
  assert.match(delivery, /converact-env-compat\.sh/);
});
