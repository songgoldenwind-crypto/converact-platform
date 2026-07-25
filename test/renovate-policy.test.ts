import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

interface RenovateCustomManager {
  customType?: string;
  managerFilePatterns?: string[];
  matchStrings?: string[];
  datasourceTemplate?: string;
}

interface RenovatePackageRule {
  matchDepTypes?: string[];
  matchDatasources?: string[];
  automerge?: boolean;
  labels?: string[];
}

interface RenovateConfig {
  extends?: string[];
  automerge?: boolean;
  dependencyDashboard?: boolean;
  customManagers?: RenovateCustomManager[];
  packageRules?: RenovatePackageRule[];
}

interface ForkManifest {
  components: Array<{
    component_id: string;
    upstream?: {
      repository?: string;
      release_ref?: string;
    };
  }>;
}

test('Renovate policy pins mutable artifacts and never automerges iveKit updates', async () => {
  const config = JSON.parse(await readFile('renovate.json', 'utf8')) as RenovateConfig;

  assert.equal(config.automerge, false);
  assert.equal(config.dependencyDashboard, true);
  assert.ok(config.extends?.includes('config:recommended'));
  assert.ok(config.extends?.includes('docker:pinDigests'));
  assert.ok(config.extends?.includes('helpers:pinGitHubActionDigests'));

  const upstreamManager = config.customManagers?.find((manager) =>
    manager.managerFilePatterns?.includes('/^\\.github\\/renovate-upstreams\\.env$/')
  );
  assert.ok(upstreamManager);
  assert.equal(upstreamManager.customType, 'regex');
  assert.ok(upstreamManager.matchStrings?.some((pattern) => pattern.includes('ivekit-upstream')));

  const digestManager = config.customManagers?.find(
    (manager) => manager.datasourceTemplate === 'docker'
  );
  assert.ok(digestManager);
  assert.ok(digestManager.matchStrings?.some((pattern) => pattern.includes('currentDigest')));

  const upstreamRule = config.packageRules?.find((rule) =>
    rule.matchDepTypes?.includes('ivekit-upstream')
  );
  assert.ok(upstreamRule);
  assert.equal(upstreamRule.automerge, false);
  assert.ok(upstreamRule.labels?.includes('ivekit-upstream'));

  for (const rule of config.packageRules ?? []) {
    assert.notEqual(rule.automerge, true);
  }
});

test('Renovate upstream watch covers every tagged fork without changing source authority', async () => {
  const manifest = JSON.parse(
    await readFile('docs/capacity/forks/ivekit-forks-v1.json', 'utf8')
  ) as ForkManifest;
  const watch = await readFile('.github/renovate-upstreams.env', 'utf8');
  const watched = new Map<string, string>();
  const pattern = /# renovate: datasource=github-tags depName=([^\s]+) versioning=[^\s]+ depType=ivekit-upstream\s+[^=]+=(\S+)/g;

  for (const match of watch.matchAll(pattern)) {
    watched.set(match[1], match[2]);
  }

  const taggedForks = manifest.components.filter(
    (component) => component.upstream?.repository && component.upstream.release_ref
  );
  assert.ok(taggedForks.length > 0);

  for (const component of taggedForks) {
    const packageName = component.upstream?.repository?.replace('https://github.com/', '');
    assert.ok(packageName, `${component.component_id} has no GitHub package name`);
    assert.equal(
      watched.get(packageName),
      component.upstream?.release_ref,
      `${component.component_id} upstream watch drifted from the fork manifest`
    );
  }

  assert.equal(watched.size, taggedForks.length);
});
