#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

import ts from 'typescript';

interface Replacement {
  start: number;
  end: number;
  text: string;
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const helper = resolve(root, 'src/config/converact-env.ts');
const codemod = fileURLToPath(import.meta.url);
const write = process.argv.includes('--write');
const fromHead = process.argv.includes('--from-head');
const requestedRoots = process.argv.slice(2).filter((argument) => !argument.startsWith('--'));
const roots = requestedRoots.length > 0 ? requestedRoots : ['src', 'scripts', 'test'];

function filesBelow(path: string): string[] {
  const absolute = resolve(root, path);
  if (statSync(absolute).isFile()) return absolute.endsWith('.ts') ? [absolute] : [];
  return readdirSync(absolute, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name))
    .flatMap((entry) => {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'target') return [];
      return filesBelow(resolve(absolute, entry.name));
    });
}

function currentKey(legacyKey: string): {
  current: string;
  resolver: 'resolveBrandEnv' | 'resolveFabricEnv';
  suffix: string;
} | null {
  const currentFabric = legacyKey.match(/^CONVERACT_FABRIC_([A-Z][A-Z0-9_]*)$/);
  if (currentFabric) {
    const suffix = currentFabric[1];
    return { current: legacyKey, resolver: 'resolveFabricEnv', suffix };
  }
  const currentBrand = legacyKey.match(/^CONVERACT_([A-Z][A-Z0-9_]*)$/);
  if (currentBrand) {
    const suffix = currentBrand[1];
    return { current: legacyKey, resolver: 'resolveBrandEnv', suffix };
  }
  const legacyFabric = legacyKey.match(/^OPC_IVEKIT_([A-Z][A-Z0-9_]*)$/);
  if (legacyFabric) {
    const suffix = legacyFabric[1];
    return { current: `CONVERACT_FABRIC_${suffix}`, resolver: 'resolveFabricEnv', suffix };
  }
  const legacyBrand = legacyKey.match(/^OPC_([A-Z][A-Z0-9_]*)$/);
  if (legacyBrand) {
    const suffix = legacyBrand[1];
    return { current: `CONVERACT_${suffix}`, resolver: 'resolveBrandEnv', suffix };
  }
  return null;
}

function isEnvironmentExpression(node: ts.Expression, source: ts.SourceFile): boolean {
  const text = node.getText(source);
  return /(?:^|[.#])env$/.test(text);
}

function isWrite(node: ts.Node): boolean {
  const parent = node.parent;
  if (ts.isDeleteExpression(parent) && parent.expression === node) return true;
  if (
    (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) &&
    (parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken)
  ) {
    return true;
  }
  if (
    ts.isBinaryExpression(parent) &&
    parent.left === node &&
    parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
    parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment
  ) {
    return true;
  }
  if (ts.isForInStatement(parent) || ts.isForOfStatement(parent)) {
    return parent.initializer === node;
  }
  return false;
}

function importPath(file: string): string {
  let path = relative(dirname(file), helper).replaceAll('\\', '/').replace(/\.ts$/, '.js');
  if (!path.startsWith('.')) path = `./${path}`;
  return path;
}

function insertImport(source: string, file: string, resolvers: Set<string>): string {
  if (resolvers.size === 0 || file === helper) return source;
  const path = importPath(file);
  const existing = new RegExp(
    `import \\{([^}]+)\\} from ['\"]${path.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}['\"];?`,
  );
  const match = source.match(existing);
  if (match) {
    const names = new Set([
      ...match[1].split(',').map((name) => name.trim()).filter(Boolean),
      ...resolvers,
    ]);
    return source.replace(match[0], `import { ${[...names].sort().join(', ')} } from '${path}';`);
  }
  const names = [...resolvers].sort().join(', ');
  const statement = `import { ${names} } from '${path}';\n`;
  if (source.startsWith('#!')) {
    const newline = source.indexOf('\n');
    return `${source.slice(0, newline + 1)}${statement}${source.slice(newline + 1)}`;
  }
  return `${statement}${source}`;
}

function transform(file: string, original: string): { source: string; replacements: number } {
  const sourceFile = ts.createSourceFile(file, original, ts.ScriptTarget.Latest, true);
  const replacements: Replacement[] = [];
  const resolvers = new Set<string>();
  const coveredStringNodes = new Set<ts.Node>();
  const testFile = relative(root, file).replaceAll('\\', '/').startsWith('test/');

  function replaceAccess(
    node: ts.PropertyAccessExpression | ts.ElementAccessExpression,
    expression: ts.Expression,
    legacyKey: string,
    keyStart: number,
    keyEnd: number,
  ): void {
    if (!isEnvironmentExpression(expression, sourceFile)) return;
    const mapping = currentKey(legacyKey);
    if (!mapping) return;

    if (testFile || isWrite(node)) {
      const quote = ts.isElementAccessExpression(node) ? "'" : '';
      replacements.push({
        start: keyStart,
        end: keyEnd,
        text: `${quote}${mapping.current}${quote}`,
      });
      return;
    }

    resolvers.add(mapping.resolver);
    replacements.push({
      start: node.getStart(sourceFile),
      end: node.getEnd(),
      text: `${mapping.resolver}(${expression.getText(sourceFile)}, '${mapping.suffix}')`,
    });
  }

  function visit(node: ts.Node): void {
    if (ts.isPropertyAccessExpression(node)) {
      replaceAccess(
        node,
        node.expression,
        node.name.text,
        node.name.getStart(sourceFile),
        node.name.getEnd(),
      );
    } else if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      coveredStringNodes.add(node.argumentExpression);
      replaceAccess(
        node,
        node.expression,
        node.argumentExpression.text,
        node.argumentExpression.getStart(sourceFile),
        node.argumentExpression.getEnd(),
      );
    } else if (
      ts.isElementAccessExpression(node) &&
      node.argumentExpression &&
      isEnvironmentExpression(node.expression, sourceFile) &&
      !isWrite(node)
    ) {
      resolvers.add('resolveConveractEnv');
      replacements.push({
        start: node.getStart(sourceFile),
        end: node.getEnd(),
        text: `resolveConveractEnv(${node.expression.getText(sourceFile)}, ${node.argumentExpression.getText(sourceFile)})`,
      });
    } else if (ts.isStringLiteralLike(node) && !coveredStringNodes.has(node)) {
      const mapping = currentKey(node.text);
      if (mapping && mapping.current !== node.text) {
        const raw = node.getText(sourceFile);
        replacements.push({
          start: node.getStart(sourceFile),
          end: node.getEnd(),
          text: `${raw[0]}${mapping.current}${raw.at(-1)}`,
        });
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);

  let updated = original;
  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    updated =
      updated.slice(0, replacement.start) + replacement.text + updated.slice(replacement.end);
  }
  updated = insertImport(updated, file, resolvers);
  const remainingLegacyKeys = updated.match(/\bOPC_(?:IVEKIT_)?[A-Z][A-Z0-9_]*/g) ?? [];
  updated = updated
    .replace(/\bOPC_IVEKIT_([A-Z][A-Z0-9_]*)/g, 'CONVERACT_FABRIC_$1')
    .replace(/\bOPC_([A-Z][A-Z0-9_]*)/g, 'CONVERACT_$1');
  return {
    source: updated,
    replacements: replacements.length + remainingLegacyKeys.length,
  };
}

const files = [...new Set(roots.flatMap(filesBelow))]
  .filter(
    (file) =>
      file !== helper &&
      file !== codemod &&
      !file.endsWith('/test/converact-env.test.ts'),
  )
  .sort();
let changedFiles = 0;
let replacements = 0;
for (const file of files) {
  const current = readFileSync(file, 'utf8');
  const source = fromHead
    ? execFileSync('git', ['show', `HEAD:${relative(root, file).replaceAll('\\', '/')}`], {
        cwd: root,
        encoding: 'utf8',
      })
    : current;
  const transformed = transform(file, source);
  if (transformed.source === current) continue;
  changedFiles += 1;
  replacements += transformed.replacements;
  if (write) writeFileSync(file, transformed.source);
}

process.stdout.write(
  `${JSON.stringify({ mode: write ? 'write' : 'dry-run', files: changedFiles, replacements })}\n`,
);
