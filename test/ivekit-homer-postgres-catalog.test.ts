import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import YAML from 'yaml';

import {
  HOMER_UPSTREAM_COMMIT,
  HOMER_UPSTREAM_TAG,
  patchCliDuckLakeConfig,
  patchDockerfile,
  patchDuckLakeTuning
} from '../infra/ivekit/homer/apply-overlay.mjs';

const overlay = readFileSync('infra/ivekit/homer/apply-overlay.mjs', 'utf8');
const buildScript = readFileSync('infra/ivekit/homer/build.sh', 'utf8');
const upstreamTests = readFileSync('infra/ivekit/homer/postgres_catalog_test.go', 'utf8');
const patchedDockerfile = patchDockerfile('FROM golang:bookworm AS builder\n');

test('HOMER fork identity is exact', () => {
  assert.equal(HOMER_UPSTREAM_TAG, '11.0.297');
  assert.match(HOMER_UPSTREAM_COMMIT, /^[a-f0-9]{40}$/);
  assert.equal(HOMER_UPSTREAM_COMMIT, 'ac4e1ae7f63660a655a5ef42e6607ab4cefc1c6b');
});

test('HOMER catalog overlay adds PostgreSQL without running SQLite file maintenance on it', () => {
  assert.equal(overlay.includes('CatalogPostgres CatalogType = "postgres"'), true);
  assert.equal(overlay.includes('func BuildCatalogAttachSQL'), true);
  assert.equal(overlay.includes('if mtw.config.CatalogType == CatalogSQLite'), true);
  assert.equal(overlay.includes('attachSQL, err := mtw.buildAttachSQL()'), true);
  assert.match(upstreamTests, /TestPostgresAttachSQLIsEscaped/);
  assert.match(upstreamTests, /password=p''ass/);
});

test('HOMER reader, config and sharding overlays preserve PostgreSQL semantics', () => {
  assert.equal(overlay.includes('LoadCatalogExtension(db, normalizedCatalogType)'), true);
  assert.equal(overlay.includes('BuildCatalogAttachSQL'), true);
  assert.equal(overlay.includes('case "", "sqlite", "postgres":'), true);
  assert.equal(overlay.includes('postgres DuckLake catalog requires shard_count=1'), true);
  assert.match(overlay, /\['src\/storage\/ducklake\/tiered_storage\.go', patchDuckLakeManager\]/);
  assert.match(patchedDockerfile, /src\/storage\/ducklake\/tiered_storage\.go/);
  assert.match(upstreamTests, /TestPostgresCatalogRejectsProcessLocalSharding/);
});

test('HOMER maintenance CLI preserves tuning and never derives spill paths from PostgreSQL DSNs', () => {
  const cliSource = `\tif source.DataInliningRowLimit != -1 {
\t\tbase.DataInliningRowLimit = source.DataInliningRowLimit
\t}

\tif source.S3.AccessKeyID != "" {`;
  const patchedCli = patchCliDuckLakeConfig(cliSource);
  assert.match(patchedCli, /base\.TuningThreads = source\.Tuning\.Threads/);
  assert.match(patchedCli, /base\.TuningMemoryLimit = source\.Tuning\.MemoryLimit/);
  assert.match(patchedCli, /base\.TuningTempDirectory = source\.Tuning\.TempDirectory/);

  const tuningSource = `func DefaultSpillDirectory(catalogPath string) string {
\tdir := strings.TrimSpace(filepath.Dir(strings.TrimSpace(catalogPath)))`;
  const patchedTuning = patchDuckLakeTuning(tuningSource);
  assert.match(patchedTuning, /isPostgresCatalogDSN/);
  assert.match(patchedTuning, /return ""/);
  assert.match(upstreamTests, /TestPostgresCatalogDefaultSpillDoesNotUseDSN/);
});

test('HOMER image bundles PostgreSQL DuckDB support and omits SQLite runtime packages', () => {
  assert.equal(overlay.includes('for ext in ducklake httpfs aws postgres_scanner; do'), true);
  assert.equal(overlay.includes('SQLite extension removal'), true);
  assert.equal(overlay.includes('extensions := []string{"ducklake", "postgres_scanner", "httpfs", "aws"}'), true);
  assert.equal(overlay.includes('extension = "postgres"'), true);
  assert.equal(overlay.includes('ARG HOMER_BUILDER_IMAGE'), true);
  assert.equal(overlay.includes('ARG HOMER_RUNTIME_IMAGE'), true);
  assert.equal(overlay.includes('bundled_extensions'), true);
  assert.equal(overlay.includes('USER 10001:10001'), true);
  assert.match(overlay, /go test \.\/storage\/ducklake/);
  assert.equal(overlay.includes('ca-certificates bash sqlite3'), false);
});

test('HOMER build fixes Node and dependency resolution to immutable inputs', () => {
  assert.match(buildScript, /HOMER_NODE_IMAGE immutable digest reference is required/);
  assert.match(buildScript, /HOMER_TARGETARCH is required/);
  assert.match(buildScript, /EXPECTED_COMMIT="ac4e1ae7f63660a655a5ef42e6607ab4cefc1c6b"/);
  assert.match(buildScript, /amd64\|arm64/);
  assert.match(buildScript, /HOMER_NODE_IMAGE=.*HOMER_NODE_IMAGE/);
  assert.match(buildScript, /--build-arg "HOMER_NODE_IMAGE=\$\{HOMER_NODE_IMAGE\}"/);
  assert.match(buildScript, /--build-arg "TARGETARCH=\$\{HOMER_TARGETARCH\}"/);
  assert.match(buildScript, /--build-arg "HOMER_GIT_COMMIT=\$\{EXPECTED_COMMIT\}"/);
  assert.match(buildScript, /docker run --rm --entrypoint \/usr\/local\/bin\/homer/);
  assert.match(buildScript, /commit \$\{EXPECTED_COMMIT:0:8\}/);
  assert.match(
    patchedDockerfile,
    /^ARG HOMER_NODE_IMAGE\nARG HOMER_BUILDER_IMAGE\nARG HOMER_RUNTIME_IMAGE\nFROM \$\{HOMER_NODE_IMAGE\}/
  );
  assert.match(patchedDockerfile, /ARG HOMER_NODE_IMAGE[\s\S]*FROM \$\{HOMER_NODE_IMAGE\} AS node-runtime/);
  assert.match(patchedDockerfile, /COPY --from=node-runtime \/usr\/local \/usr\/local/);
  assert.match(patchedDockerfile, /ENV GOTOOLCHAIN=local/);
  assert.match(patchedDockerfile, /gofmt -w src\/storage\/ducklake\/ducklake\.go/);
  assert.match(patchedDockerfile, /src\/storage\/ducklake\/tuning\.go/);
  assert.match(patchedDockerfile, /src\/cli\/cli_cmd\.go/);
  assert.match(patchedDockerfile, /go test \.\/storage\/ducklake \.\/cli/);
  assert.match(patchedDockerfile, /go mod download[\s\S]*go mod verify/);
  assert.match(patchedDockerfile, /npm ci/);
  assert.match(patchedDockerfile, /rm -rf node_modules \/root\/\.npm/);
  assert.match(patchedDockerfile, /ARG HOMER_GIT_COMMIT/);
  assert.match(
    patchedDockerfile,
    /ARG HOMER_GIT_COMMIT\nRUN make GIT_COMMIT="\$\{HOMER_GIT_COMMIT\}" homer-only/
  );
  assert.match(patchedDockerfile, /homer-only \\\s+&& DUCKDB_VERSION=/);
  assert.match(
    patchedDockerfile,
    /CMD \["--config-path", "\/etc\/homer", "--pid-file", "\/tmp\/homer-core\.pid"\]/
  );
  assert.doesNotMatch(patchedDockerfile, /deb\.nodesource\.com|make modules|npm install/);
  assert.doesNotMatch(overlay, /execFileSync\('gofmt'/);
});

test('HOMER Cell chart is PostgreSQL-only, private, persistent and off the call path', () => {
  const values = readFileSync('infra/ivekit/homer/helm/ivekit-homer/values.yaml', 'utf8');
  const helpers = readFileSync('infra/ivekit/homer/helm/ivekit-homer/templates/_helpers.tpl', 'utf8');
  const workload = readFileSync('infra/ivekit/homer/helm/ivekit-homer/templates/statefulset.yaml', 'utf8');
  const service = readFileSync('infra/ivekit/homer/helm/ivekit-homer/templates/service.yaml', 'utf8');
  const policy = readFileSync('infra/ivekit/homer/helm/ivekit-homer/templates/networkpolicy.yaml', 'utf8');
  const readme = readFileSync('infra/ivekit/homer/README.md', 'utf8');

  assert.match(values, /catalogType: postgres/);
  assert.doesNotMatch(values, /catalogType: sqlite|\.sqlite\b/);
  assert.match(helpers, /catalogType must be postgres/);
  assert.match(helpers, /replicaCount must be 1/);
  assert.match(helpers, /sha256:\[a-f0-9\]\{64\}/);
  assert.match(workload, /HOMER_STORAGE_DUCKLAKE_CATALOG_TYPE[\s\S]{0,80}postgres/);
  assert.match(workload, /HOMER_STORAGE_DUCKLAKE_CATALOG_PATH[\s\S]*secretKeyRef/);
  assert.match(workload, /HOMER_NODE_DUCKLAKE_VOLUMES_0_CATALOG_PATH[\s\S]*secretKeyRef/);
  assert.match(workload, /readinessProbe:[\s\S]*\/health/);
  assert.match(
    workload,
    /args: \["--config-path", "\/etc\/homer", "--pid-file", "\/tmp\/homer-core\.pid"\]/
  );
  assert.match(workload, /name: tmp[\s\S]*emptyDir:[\s\S]*sizeLimit: 1Gi/);
  assert.match(workload, /volumeClaimTemplates:/);
  assert.match(service, /type: ClusterIP/);
  assert.match(values, /udpPort: 9060/);
  assert.match(service, /name: hep[\s\S]*port: \{\{ \.Values\.homer\.ingest\.udpPort \}\}[\s\S]*protocol: UDP/);
  assert.doesNotMatch(service, /NodePort|LoadBalancer|hostPort/);
  assert.match(values, /app\.kubernetes\.io\/component: kamailio/);
  assert.match(policy, /kamailioPodSelector/);
  const kamailioIngress = policy.slice(
    policy.indexOf('kamailioNamespaceSelector'),
    policy.indexOf('{{- with .Values.networkPolicy.operatorIngressFrom }}')
  );
  assert.match(
    kamailioIngress,
    /port: \{\{ \.Values\.homer\.ingest\.udpPort \}\}[\s\S]*protocol: UDP/
  );
  assert.match(
    kamailioIngress,
    /port: \{\{ \.Values\.homer\.metrics\.port \}\}[\s\S]*protocol: TCP/
  );
  assert.match(readme, /collector outage[^.]*must not affect calls/i);
  assert.match(readme, /one release per Cell/i);
});

test('HOMER image workflow builds exact source and delegates its digest to the shared release gate', () => {
  const workflow = readFileSync('.github/workflows/ivekit-homer-image.yml', 'utf8');

  assert.match(workflow, /HOMER_UPSTREAM_TAG: 11\.0\.297/);
  assert.match(workflow, /HOMER_UPSTREAM_COMMIT: ac4e1ae7f63660a655a5ef42e6607ab4cefc1c6b/);
  assert.match(workflow, /git -C "\$\{source_dir\}" fetch --depth=1 origin "refs\/tags\/\$\{HOMER_UPSTREAM_TAG\}:refs\/tags\/\$\{HOMER_UPSTREAM_TAG\}"/);
  assert.match(workflow, /test "\$\(git -C "\$\{source_dir\}" rev-parse HEAD\)" = "\$\{HOMER_UPSTREAM_COMMIT\}"/);
  assert.match(workflow, /HOMER_BUILDER_IMAGE: \$\{\{ vars\.IVEKIT_HOMER_BUILDER_IMAGE \}\}/);
  assert.match(workflow, /HOMER_NODE_IMAGE: \$\{\{ vars\.IVEKIT_HOMER_NODE_IMAGE \}\}/);
  assert.match(workflow, /HOMER_RUNTIME_IMAGE: \$\{\{ vars\.IVEKIT_HOMER_RUNTIME_IMAGE \}\}/);
  assert.match(workflow, /HOMER_TARGETARCH: amd64/);
  assert.match(workflow, /@sha256:\[a-f0-9\]\{64\}\$/);
  assert.match(workflow, /docker login ghcr\.io/);
  assert.match(workflow, /docker push "\$\{IMAGE\}:\$\{VERSION\}"/);
  assert.match(workflow, /printf 'digest=%s\\n' "\$\{digest\}" >> "\$\{GITHUB_OUTPUT\}"/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/ivekit-oci-release-gate\.yml/);
  assert.match(workflow, /digest: \$\{\{ needs\.publish\.outputs\.digest \}\}/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /attestations: write/);
  assert.match(workflow, /artifact-metadata: write/);

  const parsed = YAML.parse(workflow) as {
    env?: Record<string, string>;
    jobs: { publish: { env?: Record<string, string> } };
  };
  assert.equal(parsed.env?.DOCKER_CONFIG, undefined);
  assert.equal(parsed.jobs.publish.env?.DOCKER_CONFIG, '${{ runner.temp }}/ivekit-docker-config');

  for (const match of workflow.matchAll(/uses:\s+[^@\s]+@([^\s]+)/g)) {
    assert.match(match[1], /^[a-f0-9]{40}$/, `mutable action reference: ${match[0]}`);
  }
});
