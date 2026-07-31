import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type FindingDisposition = 'rename' | 'compatibility' | 'historical' | 'external';

export interface NamingClassificationRule {
  id: string;
  path_globs: string[];
  tokens: string[];
  reason?: string;
  owner?: string;
  removal_condition?: string;
  evidence?: string;
}

export interface ConveractNamingPolicy {
  schema_version: 1;
  brand: {
    legacy: string[];
    current: string;
  };
  repository: {
    legacy: string;
    current: string;
  };
  environment: {
    legacyPrefixes: string[];
    currentPrefixes: string[];
  };
  classifications: Record<Exclude<FindingDisposition, 'rename'>, NamingClassificationRule[]>;
}

export interface LegacyNameFinding {
  path: string;
  source: 'path' | 'content';
  line: number;
  column: number;
  token: string;
  disposition: FindingDisposition;
  rule: string;
}

interface LegacyTokenMatch {
  index: number;
  token: string;
}

const dispositionOrder: Exclude<FindingDisposition, 'rename'>[] = [
  'historical',
  'external',
  'compatibility',
];

function normalizePath(path: string): string {
  return path.replaceAll('\\', '/').replace(/^\.\//, '');
}

function globToRegExp(glob: string): RegExp {
  const doubleStar = '\u0000';
  const escaped = normalizePath(glob)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('**', doubleStar)
    .replaceAll('*', '[^/]*')
    .replaceAll('?', '[^/]')
    .replaceAll(doubleStar, '.*');
  return new RegExp(`^${escaped}$`);
}

function tokenMatchesRule(found: string, allowed: string): boolean {
  const normalizedFound = found.toLocaleLowerCase('en-US');
  const normalizedAllowed = allowed.toLocaleLowerCase('en-US');
  return normalizedFound === normalizedAllowed || normalizedFound.startsWith(normalizedAllowed);
}

function findRule(
  path: string,
  token: string,
  policy: ConveractNamingPolicy,
): { disposition: Exclude<FindingDisposition, 'rename'>; id: string } | undefined {
  for (const disposition of dispositionOrder) {
    for (const rule of policy.classifications[disposition]) {
      if (
        rule.path_globs.some((glob) => globToRegExp(glob).test(path)) &&
        rule.tokens.some((allowed) => tokenMatchesRule(token, allowed))
      ) {
        return { disposition, id: rule.id };
      }
    }
  }
  return undefined;
}

function collectMatches(value: string, policy: ConveractNamingPolicy): LegacyTokenMatch[] {
  const candidates: LegacyTokenMatch[] = [];
  const patterns = [
    new RegExp(escapeRegExp(policy.repository.legacy), 'giu'),
    ...[...policy.environment.legacyPrefixes]
      .sort((left, right) => right.length - left.length)
      .map((prefix) => new RegExp(`${escapeRegExp(prefix)}[A-Z0-9_]*`, 'gu')),
    ...[...policy.brand.legacy]
      .sort((left, right) => right.length - left.length)
      .map(
        (legacy) =>
          new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(legacy)}(?![A-Za-z0-9])`, 'giu'),
      ),
  ];

  for (const pattern of patterns) {
    for (const match of value.matchAll(pattern)) {
      if (match.index !== undefined) {
        candidates.push({ index: match.index, token: match[0] });
      }
    }
  }

  candidates.sort((left, right) => left.index - right.index || right.token.length - left.token.length);
  const accepted: LegacyTokenMatch[] = [];
  for (const candidate of candidates) {
    const candidateEnd = candidate.index + candidate.token.length;
    const overlaps = accepted.some((item) => {
      const itemEnd = item.index + item.token.length;
      return candidate.index < itemEnd && item.index < candidateEnd;
    });
    if (!overlaps) accepted.push(candidate);
  }
  return accepted;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lineAndColumn(value: string, index: number): { line: number; column: number } {
  const prefix = value.slice(0, index);
  const lines = prefix.split('\n');
  return { line: lines.length, column: lines.at(-1)!.length + 1 };
}

function makeFinding(
  path: string,
  source: LegacyNameFinding['source'],
  line: number,
  column: number,
  token: string,
  policy: ConveractNamingPolicy,
): LegacyNameFinding {
  const classified = findRule(path, token, policy);
  return {
    path,
    source,
    line,
    column,
    token,
    disposition: classified?.disposition ?? 'rename',
    rule: classified?.id ?? 'legacy_product_name',
  };
}

export function scanLegacyNames(
  root: string,
  policy: ConveractNamingPolicy,
  paths: readonly string[],
): LegacyNameFinding[] {
  const findings: LegacyNameFinding[] = [];

  for (const rawPath of [...paths].map(normalizePath).sort()) {
    for (const match of collectMatches(rawPath, policy)) {
      findings.push(makeFinding(rawPath, 'path', 0, match.index + 1, match.token, policy));
    }

    const absolutePath = join(root, rawPath);
    let content: string;
    try {
      content = readFileSync(absolutePath, 'utf8');
    } catch {
      continue;
    }
    if (content.includes('\u0000')) continue;

    for (const match of collectMatches(content, policy)) {
      const location = lineAndColumn(content, match.index);
      findings.push(
        makeFinding(rawPath, 'content', location.line, location.column, match.token, policy),
      );
    }
  }

  return findings.sort(
    (left, right) =>
      left.path.localeCompare(right.path) ||
      left.line - right.line ||
      left.column - right.column ||
      left.source.localeCompare(right.source) ||
      left.token.localeCompare(right.token),
  );
}

export function loadNamingPolicy(path: string): ConveractNamingPolicy {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isNamingPolicy(parsed)) {
    throw new Error(`Invalid Converact naming policy: ${path}`);
  }
  return parsed;
}

function isNamingPolicy(value: unknown): value is ConveractNamingPolicy {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<ConveractNamingPolicy>;
  return (
    candidate.schema_version === 1 &&
    Array.isArray(candidate.brand?.legacy) &&
    typeof candidate.brand?.current === 'string' &&
    typeof candidate.repository?.legacy === 'string' &&
    typeof candidate.repository?.current === 'string' &&
    Array.isArray(candidate.environment?.legacyPrefixes) &&
    Array.isArray(candidate.environment?.currentPrefixes) &&
    Array.isArray(candidate.classifications?.compatibility) &&
    Array.isArray(candidate.classifications?.historical) &&
    Array.isArray(candidate.classifications?.external)
  );
}

function gitPaths(root: string): string[] {
  const output = execFileSync(
    'git',
    ['-C', root, 'ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 },
  );
  return output.split('\u0000').filter(Boolean);
}

export function excludeGeneratedOutputs(
  paths: readonly string[],
  root: string,
  outputs: readonly string[],
): string[] {
  const excluded = new Set(
    outputs.map((output) =>
      normalizePath(relative(root, isAbsolute(output) ? resolve(output) : resolve(root, output))),
    ),
  );
  return paths.filter((path) => !excluded.has(normalizePath(path)));
}

function markdownReport(findings: LegacyNameFinding[], root: string): string {
  const byDisposition = new Map<FindingDisposition, number>();
  const byPath = new Map<string, Map<FindingDisposition, number>>();
  for (const finding of findings) {
    byDisposition.set(finding.disposition, (byDisposition.get(finding.disposition) ?? 0) + 1);
    const counts = byPath.get(finding.path) ?? new Map<FindingDisposition, number>();
    counts.set(finding.disposition, (counts.get(finding.disposition) ?? 0) + 1);
    byPath.set(finding.path, counts);
  }

  const count = (disposition: FindingDisposition) => byDisposition.get(disposition) ?? 0;
  const rows = [...byPath.entries()].map(([path, counts]) => {
    const dispositions = [...counts.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([disposition, total]) => `${disposition}:${total}`)
      .join(', ');
    return `| \`${path.replaceAll('|', '\\|')}\` | ${dispositions} |`;
  });

  return [
    '# Converact Rename Inventory',
    '',
    `Generated from tracked and non-ignored files under \`${relative(root, root) || '.'}\`.`,
    '',
    'This is a migration inventory, not completion evidence. A `rename` item remains pending.',
    '',
    '## Summary',
    '',
    '| Disposition | Occurrences |',
    '| --- | ---: |',
    `| rename | ${count('rename')} |`,
    `| compatibility | ${count('compatibility')} |`,
    `| historical | ${count('historical')} |`,
    `| external | ${count('external')} |`,
    '',
    '## Files',
    '',
    '| Path | Classified occurrences |',
    '| --- | --- |',
    ...rows,
    '',
  ].join('\n');
}

interface CliOptions {
  root: string;
  policy: string;
  json?: string;
  markdown?: string;
}

function parseCli(args: string[]): CliOptions {
  const scriptDirectory = dirname(fileURLToPath(import.meta.url));
  const defaultRoot = resolve(scriptDirectory, '..');
  const options: CliOptions = {
    root: defaultRoot,
    policy: join(defaultRoot, 'config/branding/converact-naming-policy.json'),
  };
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if (!value || !['--root', '--policy', '--json', '--markdown'].includes(flag)) {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
    index += 1;
    if (flag === '--root') options.root = resolve(value);
    if (flag === '--policy') options.policy = resolve(value);
    if (flag === '--json') options.json = value;
    if (flag === '--markdown') options.markdown = value;
  }
  return options;
}

function writeOutput(root: string, target: string, content: string): void {
  const absoluteTarget = isAbsolute(target) ? target : join(root, target);
  mkdirSync(dirname(absoluteTarget), { recursive: true });
  writeFileSync(absoluteTarget, content);
}

function runCli(): void {
  const options = parseCli(process.argv.slice(2));
  const policyPath = isAbsolute(options.policy) ? options.policy : join(options.root, options.policy);
  const policy = loadNamingPolicy(policyPath);
  const generatedOutputs = [options.json, options.markdown].filter(
    (output): output is string => output !== undefined,
  );
  const paths = excludeGeneratedOutputs(gitPaths(options.root), options.root, generatedOutputs);
  const findings = scanLegacyNames(options.root, policy, paths);
  if (options.json) {
    writeOutput(options.root, options.json, `${JSON.stringify({ schema_version: 1, findings }, null, 2)}\n`);
  }
  if (options.markdown) {
    writeOutput(options.root, options.markdown, markdownReport(findings, options.root));
  }
  const counts = findings.reduce<Record<FindingDisposition, number>>(
    (result, finding) => {
      result[finding.disposition] += 1;
      return result;
    },
    { rename: 0, compatibility: 0, historical: 0, external: 0 },
  );
  process.stdout.write(`${JSON.stringify(counts)}\n`);
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli();
}
