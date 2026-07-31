import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface LockPackage {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean }>;
  [key: string]: unknown;
}

interface PackageLock {
  name: string;
  version: string;
  lockfileVersion: number;
  requires?: boolean;
  packages: Record<string, LockPackage>;
}

export function generateIveKitServiceLock(repoRootInput: string): PackageLock {
  const repoRoot = resolve(repoRootInput);
  const rootLock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8')) as PackageLock;
  const serviceRoot = join(repoRoot, 'services', 'converact-service');
  const servicePackage = JSON.parse(readFileSync(join(serviceRoot, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    engines?: Record<string, string>;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const selected = new Set<string>();
  const queue = [
    ...Object.keys(servicePackage.dependencies || {}),
    ...Object.keys(servicePackage.devDependencies || {})
  ].map((name) => resolveLockPackage(rootLock, '', name));

  while (queue.length > 0) {
    const path = queue.shift()!;
    if (selected.has(path)) continue;
    const lockPackage = rootLock.packages[path];
    if (!lockPackage) throw new Error(`root package lock is missing ${path}`);
    selected.add(path);
    const dependencies = {
      ...(lockPackage.dependencies || {}),
      ...(lockPackage.optionalDependencies || {})
    };
    for (const name of Object.keys(dependencies)) {
      const dependencyPath = resolveLockPackage(rootLock, path, name, true);
      if (dependencyPath && !selected.has(dependencyPath)) queue.push(dependencyPath);
    }
    for (const name of Object.keys(lockPackage.peerDependencies || {})) {
      if (lockPackage.peerDependenciesMeta?.[name]?.optional) continue;
      const dependencyPath = resolveLockPackage(rootLock, path, name, true);
      if (dependencyPath && !selected.has(dependencyPath)) queue.push(dependencyPath);
    }
  }

  const packages: Record<string, LockPackage> = {
    '': {
      name: servicePackage.name,
      version: servicePackage.version,
      dependencies: servicePackage.dependencies || {},
      devDependencies: servicePackage.devDependencies || {},
      engines: servicePackage.engines || {}
    }
  };
  for (const path of [...selected].sort()) packages[path] = rootLock.packages[path];

  return {
    name: servicePackage.name,
    version: servicePackage.version,
    lockfileVersion: 3,
    requires: true,
    packages
  };
}

export function writeIveKitServiceLock(repoRoot: string): string {
  const lock = generateIveKitServiceLock(repoRoot);
  const outputFile = join(repoRoot, 'services', 'converact-service', 'package-lock.json');
  writeFileSync(outputFile, `${JSON.stringify(lock, null, 2)}\n`, 'utf8');
  return outputFile;
}

function resolveLockPackage(
  lock: PackageLock,
  requesterPath: string,
  name: string,
  optional = false
): string {
  let current = requesterPath;
  while (true) {
    const candidate = current ? `${current}/node_modules/${name}` : `node_modules/${name}`;
    if (lock.packages[candidate]) return candidate;
    if (!current) break;
    current = parentPackagePath(current);
  }
  if (optional) return '';
  throw new Error(`root package lock cannot resolve ${name} from ${requesterPath || '<root>'}`);
}

function parentPackagePath(path: string): string {
  const marker = '/node_modules/';
  const nested = path.lastIndexOf(marker);
  if (nested >= 0) return path.slice(0, nested);
  return '';
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  process.stdout.write(`${writeIveKitServiceLock(repoRoot)}\n`);
}
