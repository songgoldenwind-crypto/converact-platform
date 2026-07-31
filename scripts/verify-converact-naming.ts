import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type FindingDisposition,
  type LegacyNameFinding,
  excludeGeneratedOutputs,
  listRepositoryPaths,
  loadNamingPolicy,
  scanLegacyNames,
} from './converact-name-inventory.js';

export interface NamingVerificationResult {
  counts: Record<FindingDisposition, number>;
  violations: LegacyNameFinding[];
}

const dispositions: FindingDisposition[] = [
  'rename',
  'unclassified',
  'compatibility',
  'historical',
  'external',
];

export function evaluateNamingPolicy(
  findings: readonly LegacyNameFinding[],
): NamingVerificationResult {
  const counts: Record<FindingDisposition, number> = {
    rename: 0,
    unclassified: 0,
    compatibility: 0,
    historical: 0,
    external: 0,
  };
  const violations: LegacyNameFinding[] = [];

  for (const finding of findings) {
    const disposition = dispositions.includes(finding.disposition)
      ? finding.disposition
      : 'unclassified';
    counts[disposition] += 1;
    if (disposition === 'rename' || disposition === 'unclassified') {
      violations.push(
        disposition === finding.disposition
          ? finding
          : { ...finding, disposition, rule: 'unknown_disposition' },
      );
    }
  }

  return { counts, violations };
}

interface CliOptions {
  root: string;
  policy: string;
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
    if (!value || !['--root', '--policy'].includes(flag)) {
      throw new Error(`Unknown or incomplete argument: ${flag}`);
    }
    index += 1;
    if (flag === '--root') options.root = resolve(value);
    if (flag === '--policy') options.policy = value;
  }
  return options;
}

function runCli(): void {
  const options = parseCli(process.argv.slice(2));
  const policyPath = isAbsolute(options.policy) ? options.policy : join(options.root, options.policy);
  const policy = loadNamingPolicy(policyPath);
  const paths = excludeGeneratedOutputs(listRepositoryPaths(options.root), options.root, [
    'docs/design/converact-rename-inventory.md',
  ]);
  const findings = scanLegacyNames(options.root, policy, paths);
  const result = evaluateNamingPolicy(findings);

  process.stdout.write(`${JSON.stringify(result.counts)}\n`);
  if (result.violations.length > 0) {
    const paths = [...new Set(result.violations.map((finding) => finding.path))].sort();
    process.stderr.write(`Converact naming violations in ${paths.length} paths:\n`);
    process.stderr.write(`${paths.join('\n')}\n`);
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : undefined;
if (invokedPath === fileURLToPath(import.meta.url)) {
  runCli();
}
