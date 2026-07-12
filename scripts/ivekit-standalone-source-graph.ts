import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

export interface IveKitStandaloneSourceGraph {
  repoRoot: string;
  entrypoints: string[];
  files: string[];
  packages: string[];
  unresolved: string[];
}

export interface IveKitStandaloneSourcePolicy {
  entrypoints: string[];
  forbidden_prefixes: string[];
  assets: string[];
  migrations?: string[];
}

const DEFAULT_FORBIDDEN_PREFIXES = [
  'src/agent-runtime/call-center/',
  'src/agent-runtime/ivr/',
  'src/agent-runtime/campaigns/',
  'frontend/',
  'src/server.ts',
  'src/call-center-http.ts'
];
const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`)
]);

export function analyzeIveKitStandaloneSourceGraph(input: {
  repoRoot: string;
  entrypoints: string[];
}): IveKitStandaloneSourceGraph {
  const repoRoot = resolve(input.repoRoot);
  const entrypoints = input.entrypoints.map(normalizeRepoPath);
  const files = new Set<string>();
  const packages = new Set<string>();
  const unresolved = new Set<string>();
  const queue = [...entrypoints];

  while (queue.length > 0) {
    const repoPath = queue.shift()!;
    if (files.has(repoPath)) continue;
    const absolute = resolveInside(repoRoot, repoPath);
    if (!existsSync(absolute)) {
      unresolved.add(`${repoPath}: entrypoint does not exist`);
      continue;
    }
    files.add(repoPath);
    if (!['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs'].includes(extname(repoPath))) continue;

    const source = readFileSync(absolute, 'utf8');
    const sourceFile = ts.createSourceFile(
      repoPath,
      source,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(repoPath)
    );
    for (const specifier of moduleSpecifiers(sourceFile)) {
      if (specifier.startsWith('.') || specifier.startsWith('/')) {
        const resolved = resolveLocalModule(repoRoot, repoPath, specifier);
        if (!resolved) unresolved.add(`${repoPath}: cannot resolve ${specifier}`);
        else if (!files.has(resolved)) queue.push(resolved);
        continue;
      }
      if (!BUILTINS.has(specifier)) packages.add(packageName(specifier));
    }
  }

  return {
    repoRoot,
    entrypoints,
    files: [...files].sort(),
    packages: [...packages].sort(),
    unresolved: [...unresolved].sort()
  };
}

export function assertIveKitStandaloneBoundary(
  graph: IveKitStandaloneSourceGraph,
  forbiddenPrefixes: string[] = DEFAULT_FORBIDDEN_PREFIXES
): void {
  if (graph.unresolved.length > 0) {
    throw new Error(`iveKit standalone source graph has unresolved imports:\n${graph.unresolved.join('\n')}`);
  }
  const forbidden = graph.files.filter((path) => forbiddenPrefixes.some((prefix) =>
    prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix
  ));
  if (forbidden.length > 0) {
    throw new Error(`iveKit standalone source graph crosses forbidden boundaries:\n${forbidden.join('\n')}`);
  }
}

export function readIveKitStandaloneSourcePolicy(repoRoot: string): IveKitStandaloneSourcePolicy {
  return JSON.parse(readFileSync(
    join(repoRoot, 'services', 'ivekit-service', 'source-policy.json'),
    'utf8'
  )) as IveKitStandaloneSourcePolicy;
}

function moduleSpecifiers(sourceFile: ts.SourceFile): string[] {
  const specifiers = new Set<string>();
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      if (ts.isStringLiteralLike(node.moduleSpecifier)) specifiers.add(node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0];
      if (argument && ts.isStringLiteralLike(argument)) specifiers.add(argument.text);
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      if (ts.isLiteralTypeNode(argument) && ts.isStringLiteralLike(argument.literal)) {
        specifiers.add(argument.literal.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...specifiers];
}

function resolveLocalModule(repoRoot: string, importer: string, specifier: string): string | null {
  const importerDir = dirname(resolve(repoRoot, importer));
  const raw = resolve(importerDir, specifier);
  const candidates = localModuleCandidates(raw);
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    return normalizeRepoPath(relative(repoRoot, candidate));
  }
  return null;
}

function localModuleCandidates(raw: string): string[] {
  const extension = extname(raw);
  const candidates = [raw];
  if (extension === '.js' || extension === '.mjs' || extension === '.cjs') {
    const stem = raw.slice(0, -extension.length);
    candidates.unshift(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
  } else if (!extension) {
    candidates.push(
      `${raw}.ts`, `${raw}.tsx`, `${raw}.mts`, `${raw}.cts`, `${raw}.js`,
      join(raw, 'index.ts'), join(raw, 'index.tsx'), join(raw, 'index.js')
    );
  }
  return candidates;
}

function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function resolveInside(root: string, repoPath: string): string {
  const absolute = resolve(root, repoPath);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) {
    throw new Error(`iveKit source path escapes repository: ${repoPath}`);
  }
  return absolute;
}

function normalizeRepoPath(path: string): string {
  return path.split(sep).join('/').replace(/^\.\//, '');
}

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (path.endsWith('.jsx')) return ts.ScriptKind.JSX;
  if (path.endsWith('.js') || path.endsWith('.mjs') || path.endsWith('.cjs')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
  const policy = readIveKitStandaloneSourcePolicy(repoRoot);
  const graph = analyzeIveKitStandaloneSourceGraph({ repoRoot, entrypoints: policy.entrypoints });
  assertIveKitStandaloneBoundary(graph, policy.forbidden_prefixes);
  process.stdout.write(`${JSON.stringify(graph, null, 2)}\n`);
}
