import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const root = 'clients/ivekit-reference';

test('iveKit reference client is independently buildable and SDK-only', () => {
  for (const path of [
    `${root}/package.json`,
    `${root}/tsconfig.json`,
    `${root}/vite.config.ts`,
    `${root}/index.html`,
    `${root}/src/main.tsx`,
    `${root}/src/app.tsx`,
    `${root}/src/runtime-config.ts`,
    `${root}/src/styles.css`,
    `${root}/public/ivekit-config.example.json`
  ]) assert.equal(existsSync(path), true, `missing ${path}`);

  const pkg = JSON.parse(readFileSync(`${root}/package.json`, 'utf8')) as {
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
  };
  assert.ok(pkg.dependencies['@opc/ivekit-sdk']);
  assert.ok(pkg.dependencies['tinode-sdk']);
  assert.ok(pkg.scripts.build);
  assert.ok(pkg.scripts.test);

  const source = sourceFiles(`${root}/src`).map((path) => readFileSync(path, 'utf8')).join('\n');
  assert.doesNotMatch(source, /frontend\/src|src\/agent-runtime|api\/call-center/);
  assert.doesNotMatch(source, /localStorage|sessionStorage|VITE_.*(?:KEY|TOKEN)|x-api-key/i);
  assert.doesNotMatch(source, /publishMessage|sendMessage|\.publish\s*\(/);
  assert.match(source, /@opc\/ivekit-sdk/);
});

function sourceFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory()
      ? sourceFiles(path)
      : /\.(ts|tsx)$/.test(name) && !/\.test\.(ts|tsx)$/.test(name)
        ? [path]
        : [];
  });
}
