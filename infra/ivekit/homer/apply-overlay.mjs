#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const HOMER_UPSTREAM_TAG = '11.0.297';
export const HOMER_UPSTREAM_COMMIT =
  'ac4e1ae7f63660a655a5ef42e6607ab4cefc1c6b';

function replaceOnce(source, search, replacement, label) {
  const matches = typeof search === 'string'
    ? source.split(search).length - 1
    : [...source.matchAll(new RegExp(search.source, search.flags.includes('g') ? search.flags : `${search.flags}g`))].length;
  if (matches !== 1) {
    throw new Error(`HOMER ${label} anchor mismatch: expected 1, got ${matches}`);
  }
  return source.replace(search, replacement);
}

export function patchDuckLakeCatalog(source) {
  let next = replaceOnce(
    source,
    'const (\n\t// CatalogSQLite — DuckLake catalog backed by a local .sqlite file.\n\tCatalogSQLite CatalogType = "sqlite"\n)',
    'const (\n\t// CatalogSQLite — DuckLake catalog backed by a local .sqlite file.\n\tCatalogSQLite CatalogType = "sqlite"\n\t// CatalogPostgres — DuckLake catalog backed by PostgreSQL.\n\tCatalogPostgres CatalogType = "postgres"\n)',
    'catalog type'
  );

  next = replaceOnce(
    next,
    /\/\/ NormalizeSQLiteCatalog returns sqlite for empty or "sqlite"; otherwise an error\.\nfunc NormalizeSQLiteCatalog\(ct CatalogType\) \(CatalogType, error\) \{[\s\S]*?\n\}\n\n\/\/ DefaultConfig/,
    `// NormalizeCatalogType validates a supported DuckLake catalog backend.
func NormalizeCatalogType(ct CatalogType) (CatalogType, error) {
\ts := strings.ToLower(strings.TrimSpace(string(ct)))
\tswitch CatalogType(s) {
\tcase "", CatalogSQLite:
\t\treturn CatalogSQLite, nil
\tcase CatalogPostgres:
\t\treturn CatalogPostgres, nil
\tdefault:
\t\treturn "", fmt.Errorf("ducklake catalog_type %q: expected sqlite or postgres", s)
\t}
}

// LoadCatalogExtension loads only the DuckDB extension required by the catalog.
func LoadCatalogExtension(db *sql.DB, ct CatalogType) error {
\tnormalized, err := NormalizeCatalogType(ct)
\tif err != nil {
\t\treturn err
\t}
\textension := "sqlite"
\tif normalized == CatalogPostgres {
\t\textension = "postgres"
\t}
\tif _, err := db.Exec("LOAD " + extension + ";"); err != nil {
\t\treturn fmt.Errorf("failed to load %s catalog extension: %w", extension, err)
\t}
\treturn nil
}

func quoteSQLLiteral(value string) string {
\treturn strings.ReplaceAll(value, "'", "''")
}

func quoteSQLIdentifier(value string) (string, error) {
\ttrimmed := strings.TrimSpace(value)
\tif trimmed == "" {
\t\treturn "", fmt.Errorf("ducklake lake_name is required")
\t}
\treturn "\\\"" + strings.ReplaceAll(trimmed, "\\\"", "\\\"\\\"") + "\\\"", nil
}

// BuildCatalogAttachSQL builds an injection-safe DuckLake ATTACH statement.
// CatalogPath is a filesystem path for sqlite and a libpq connection string
// for postgres. Callers must never log the returned SQL because it may contain
// database credentials.
func BuildCatalogAttachSQL(ct CatalogType, catalogPath, lakeName, dataPath string, overrideDataPath bool) (string, error) {
\tnormalized, err := NormalizeCatalogType(ct)
\tif err != nil {
\t\treturn "", err
\t}
\tif strings.TrimSpace(catalogPath) == "" {
\t\treturn "", fmt.Errorf("ducklake catalog_path is required")
\t}
\tlakeIdentifier, err := quoteSQLIdentifier(lakeName)
\tif err != nil {
\t\treturn "", err
\t}
\toverrideOpt := ""
\tif overrideDataPath {
\t\toverrideOpt = ", OVERRIDE_DATA_PATH TRUE"
\t}
\tcatalog := fmt.Sprintf("ducklake:%s:%s", normalized, catalogPath)
\treturn fmt.Sprintf(
\t\t"ATTACH '%s' AS %s (DATA_PATH '%s', AUTOMATIC_MIGRATION TRUE%s);",
\t\tquoteSQLLiteral(catalog), lakeIdentifier, quoteSQLLiteral(dataPath), overrideOpt,
\t), nil
}

// DefaultConfig`,
    'catalog normalization and attach builder'
  );

  next = next.replaceAll('NormalizeSQLiteCatalog(', 'NormalizeCatalogType(');

  next = replaceOnce(
    next,
    /\t\/\/ Load SQLite extension for the DuckLake catalog file\n\tif _, err := db\.Exec\("LOAD sqlite;"\); err != nil \{[\s\S]*?\n\t\}\n\n\t\/\/ Autofix the "Corrupt DuckLake/,
    `\tif err := LoadCatalogExtension(db, mtw.config.CatalogType); err != nil {
\t\treturn fmt.Errorf("failed to load catalog extension (run homer system --install-extensions first): %w", err)
\t}
\tif mtw.config.CatalogType == CatalogSQLite {
\t\t// SQLite-only file maintenance must never run against a PostgreSQL DSN.
\t\tif err := EnableSQLiteWALMode(mtw.config.CatalogPath); err != nil {
\t\t\tlogger.Warn(fmt.Sprintf("Failed to enable WAL mode for SQLite catalog (may cause lock errors): %v", err))
\t\t}
\t\tif n, err := GCOrphanInlineTables(mtw.config.CatalogPath); err != nil {
\t\t\tlogger.Warn("DuckLake inline GC failed (non-fatal)", "err", err)
\t\t} else if n > 0 {
\t\t\tlogger.Info("DuckLake inline GC: dropped empty ducklake_inlined_data_* tables (upstream #1065)", "dropped", n)
\t\t}
\t}

\t// Autofix the "Corrupt DuckLake`,
    'catalog extension loading'
  );

  next = replaceOnce(
    next,
    '\t// Build attach statement (SQLite catalog only)\n\tattachSQL := mtw.buildAttachSQL()\n\n\tif _, err := db.Exec(attachSQL); err != nil {',
    '\tattachSQL, err := mtw.buildAttachSQL()\n\tif err != nil {\n\t\treturn err\n\t}\n\tif _, err := db.Exec(attachSQL); err != nil {',
    'writer attach call'
  );

  next = replaceOnce(
    next,
    /\/\/ buildAttachSQL returns the ATTACH statement for this writer's DuckLake catalog\.\nfunc \(mtw \*MultiTableWriter\) buildAttachSQL\(\) string \{[\s\S]*?\n\}/,
    `// buildAttachSQL returns the ATTACH statement for this writer's DuckLake catalog.
func (mtw *MultiTableWriter) buildAttachSQL() (string, error) {
\treturn BuildCatalogAttachSQL(
\t\tmtw.config.CatalogType,
\t\tmtw.config.CatalogPath,
\t\tmtw.config.LakeName,
\t\tmtw.config.DataPath,
\t\tfalse,
\t)
}`,
    'writer attach builder'
  );

  next = replaceOnce(
    next,
    '\tif _, err := mtw.db.Exec(mtw.buildAttachSQL()); err != nil {\n\t\treturn fmt.Errorf("re-attach %s: %w", mtw.config.LakeName, err)\n\t}',
    '\tattachSQL, err := mtw.buildAttachSQL()\n\tif err != nil {\n\t\treturn err\n\t}\n\tif _, err := mtw.db.Exec(attachSQL); err != nil {\n\t\treturn fmt.Errorf("re-attach %s: %w", mtw.config.LakeName, err)\n\t}',
    'catalog refresh attach'
  );
  return next;
}

export function patchDuckLakeManager(source) {
  return source.replaceAll('NormalizeSQLiteCatalog(', 'NormalizeCatalogType(');
}

export function patchDuckLakeTuning(source) {
  return replaceOnce(
    source,
    `func DefaultSpillDirectory(catalogPath string) string {
\tdir := strings.TrimSpace(filepath.Dir(strings.TrimSpace(catalogPath)))`,
    `func isPostgresCatalogDSN(value string) bool {
\ttrimmed := strings.ToLower(strings.TrimSpace(value))
\tif strings.HasPrefix(trimmed, "postgres://") ||
\t\tstrings.HasPrefix(trimmed, "postgresql://") {
\t\treturn true
\t}
\tfor _, marker := range []string{"dbname=", "host=", "password=", "sslmode="} {
\t\tif strings.Contains(trimmed, marker) {
\t\t\treturn true
\t\t}
\t}
\treturn false
}

func DefaultSpillDirectory(catalogPath string) string {
\t// A PostgreSQL catalog DSN is not a filesystem path and can contain
\t// credentials. Never derive or log a spill directory from it.
\tif isPostgresCatalogDSN(catalogPath) {
\t\treturn ""
\t}
\tdir := strings.TrimSpace(filepath.Dir(strings.TrimSpace(catalogPath)))`,
    'PostgreSQL spill path guard'
  );
}

export function patchCliDuckLakeConfig(source) {
  return replaceOnce(
    source,
    `\tif source.DataInliningRowLimit != -1 {
\t\tbase.DataInliningRowLimit = source.DataInliningRowLimit
\t}

\tif source.S3.AccessKeyID != "" {`,
    `\tif source.DataInliningRowLimit != -1 {
\t\tbase.DataInliningRowLimit = source.DataInliningRowLimit
\t}
\tbase.TuningThreads = source.Tuning.Threads
\tbase.TuningMemoryLimit = source.Tuning.MemoryLimit
\tbase.TuningTempDirectory = source.Tuning.TempDirectory

\tif source.S3.AccessKeyID != "" {`,
    'CLI DuckLake tuning propagation'
  );
}

export function patchShardedWriter(source) {
  return replaceOnce(
    source,
    '\tif n <= 0 {\n\t\tn = 1\n\t}\n\n\tsw := &ShardedWriter{',
    '\tif n <= 0 {\n\t\tn = 1\n\t}\n\tct, err := NormalizeCatalogType(config.CatalogType)\n\tif err != nil {\n\t\treturn nil, err\n\t}\n\tconfig.CatalogType = ct\n\tif ct == CatalogPostgres && n > 1 {\n\t\treturn nil, fmt.Errorf("postgres DuckLake catalog requires shard_count=1; scale independent collector catalogs instead")\n\t}\n\n\tsw := &ShardedWriter{',
    'PostgreSQL shard guard'
  );
}

export function patchNodeCatalog(source) {
  return replaceOnce(
    source,
    /\tif _, err := ducklake\.NormalizeSQLiteCatalog\(ducklake\.CatalogType\(catalogType\)\); err != nil \{[\s\S]*?\n\tif _, err := db\.Exec\(attachSQL\); err != nil \{/,
    `\tnormalizedCatalogType, err := ducklake.NormalizeCatalogType(ducklake.CatalogType(catalogType))
\tif err != nil {
\t\treturn VolumeInfo{}, fmt.Errorf("volume %s: %w", vol.Name, err)
\t}
\tif err := ducklake.LoadCatalogExtension(db, normalizedCatalogType); err != nil {
\t\treturn VolumeInfo{}, fmt.Errorf("volume %s: %w", vol.Name, err)
\t}
\tif normalizedCatalogType == ducklake.CatalogSQLite {
\t\tif err := ducklake.EnableSQLiteWALMode(catalogPath); err != nil {
\t\t\tlogger.Warn(fmt.Sprintf("Failed to enable WAL mode for catalog %s: %v", catalogPath, err))
\t\t}
\t}
\tattachSQL, err := ducklake.BuildCatalogAttachSQL(
\t\tnormalizedCatalogType, catalogPath, lakeName, vol.Path, vol.OverrideDataPath,
\t)
\tif err != nil {
\t\treturn VolumeInfo{}, fmt.Errorf("volume %s: %w", vol.Name, err)
\t}
\tif _, err := db.Exec(attachSQL); err != nil {`,
    'node catalog attach'
  );
}

export function patchConfigValidation(source) {
  return replaceOnce(
    source,
    /\/\/ validateDuckLakeCatalogTypes ensures catalog_type is sqlite \(or empty\)\.\nfunc validateDuckLakeCatalogTypes\(cfg \*Config\) error \{[\s\S]*?\n\treturn nil\n\}/,
    `// validateDuckLakeCatalogTypes accepts the upstream SQLite catalog and the
// iveKit PostgreSQL catalog. Production iveKit profiles require postgres.
func validateDuckLakeCatalogTypes(cfg *Config) error {
\tcheck := func(field, value string) error {
\t\tswitch strings.ToLower(strings.TrimSpace(value)) {
\t\tcase "", "sqlite", "postgres":
\t\t\treturn nil
\t\tdefault:
\t\t\treturn fmt.Errorf("%s: expected DuckLake catalog sqlite or postgres (got %q)", field, value)
\t\t}
\t}
\tif err := check("storage.ducklake.catalog_type", cfg.Storage.DuckLake.CatalogType); err != nil {
\t\treturn err
\t}
\tfor i, v := range cfg.Storage.DuckLake.Volumes {
\t\tif err := check(fmt.Sprintf("storage.ducklake.volumes[%d].catalog_type", i), v.CatalogType); err != nil {
\t\t\treturn err
\t\t}
\t}
\tfor i, v := range cfg.Storage.DuckLake.StoragePolicy.Volumes {
\t\tif err := check(fmt.Sprintf("storage.ducklake.storage_policy.volumes[%d].catalog_type", i), v.CatalogType); err != nil {
\t\t\treturn err
\t\t}
\t}
\tif err := check("node.ducklake.catalog_type", cfg.Node.DuckLake.CatalogType); err != nil {
\t\treturn err
\t}
\tfor i, v := range cfg.Node.DuckLake.Volumes {
\t\tif err := check(fmt.Sprintf("node.ducklake.volumes[%d].catalog_type", i), v.CatalogType); err != nil {
\t\t\treturn err
\t\t}
\t}
\treturn nil
}`,
    'config catalog validation'
  );
}

export function patchExtensionDownloader(source) {
  let next = replaceOnce(
    source,
    'for ext in ducklake httpfs aws; do',
    'for ext in ducklake httpfs aws postgres_scanner; do',
    'PostgreSQL extension download'
  );
  next = replaceOnce(
    next,
    /\necho "  sqlite_scanner[\s\S]*?sqlite_scanner\.duckdb_extension"\n/,
    '\n',
    'SQLite extension removal'
  );
  return next;
}

export function patchSystemExtensions(source) {
  return source
    .replaceAll('install DuckDB extensions (ducklake, sqlite, httpfs, aws)', 'install DuckDB extensions (ducklake, postgres_scanner, httpfs, aws)')
    .replace('extensions := []string{"ducklake", "sqlite", "httpfs", "aws"}', 'extensions := []string{"ducklake", "postgres_scanner", "httpfs", "aws"}');
}

export function patchDockerfile(source) {
  if (!source.includes('FROM golang:bookworm AS builder')) {
    throw new Error('HOMER Dockerfile builder identity mismatch');
  }
  return `ARG HOMER_NODE_IMAGE
ARG HOMER_BUILDER_IMAGE
ARG HOMER_RUNTIME_IMAGE
FROM \${HOMER_NODE_IMAGE} AS node-runtime

FROM \${HOMER_BUILDER_IMAGE} AS builder

RUN apt-get update && apt-get install -y --no-install-recommends \\
    git ca-certificates build-essential curl \\
    libluajit-5.1-dev \\
    && rm -rf /var/lib/apt/lists/*

COPY --from=node-runtime /usr/local /usr/local

COPY . /homer-core
WORKDIR /homer-core
ENV GOTOOLCHAIN=local
ARG TARGETARCH
RUN gofmt -w src/storage/ducklake/ducklake.go \\
        src/storage/ducklake/manager.go \\
        src/storage/ducklake/sharded_writer.go \\
        src/storage/ducklake/tiered_storage.go \\
        src/storage/ducklake/tuning.go \\
        src/storage/ducklake/postgres_catalog_test.go \\
        src/cli/cli_cmd.go \\
        src/node/node.go \\
        src/config/config.go \\
    && cd src \\
    && go mod download \\
    && go mod verify \\
    && go test ./storage/ducklake ./cli \\
    && cd ui \\
    && npm ci \\
    && npm run build \\
    && rm -rf node_modules /root/.npm \\
    && cd ../..

ARG HOMER_GIT_COMMIT
RUN make GIT_COMMIT="\${HOMER_GIT_COMMIT}" homer-only \\
    && DUCKDB_VERSION=v1.5.4 ./scripts/download_duckdb_extensions.sh "linux_\${TARGETARCH}"

FROM \${HOMER_RUNTIME_IMAGE}

RUN apt-get update && apt-get install -y --no-install-recommends \\
    ca-certificates \\
    && rm -rf /var/lib/apt/lists/* \\
    && groupadd --gid 10001 homer \\
    && useradd --uid 10001 --gid 10001 --home-dir /var/lib/homer --shell /usr/sbin/nologin homer \\
    && install -d -o 10001 -g 10001 /etc/homer /var/lib/homer /var/lib/homer/data /var/lib/homer/state /var/lib/homer/.duckdb

COPY --from=builder /homer-core/homer /usr/local/bin/homer
COPY --from=builder /homer-core/src/dist /usr/local/homer-core/dist
COPY --from=builder --chown=10001:10001 /homer-core/bundled_extensions/ /var/lib/homer/.duckdb/extensions/

ENV HOME=/var/lib/homer
WORKDIR /var/lib/homer
USER 10001:10001
EXPOSE 8080 9060/udp 9080 9090 50051
ENTRYPOINT ["/usr/local/bin/homer"]
CMD ["--config-path", "/etc/homer", "--pid-file", "/tmp/homer-core.pid"]
`;
}

export async function applyHomerOverlay(input) {
  const sourceDir = resolve(input.sourceDir);
  const repoRoot = resolve(input.repoRoot || defaultRepoRoot());
  const commit = execFileSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  if (commit !== HOMER_UPSTREAM_COMMIT) {
    throw new Error(`HOMER source commit mismatch: expected ${HOMER_UPSTREAM_COMMIT}, got ${commit}`);
  }
  const tag = execFileSync('git', ['-C', sourceDir, 'describe', '--tags', '--exact-match', 'HEAD'], { encoding: 'utf8' }).trim();
  if (tag !== HOMER_UPSTREAM_TAG) {
    throw new Error(`HOMER source tag mismatch: expected ${HOMER_UPSTREAM_TAG}, got ${tag}`);
  }

  const rewrites = [
    ['src/storage/ducklake/ducklake.go', patchDuckLakeCatalog],
    ['src/storage/ducklake/manager.go', patchDuckLakeManager],
    ['src/storage/ducklake/sharded_writer.go', patchShardedWriter],
    ['src/storage/ducklake/tiered_storage.go', patchDuckLakeManager],
    ['src/storage/ducklake/tuning.go', patchDuckLakeTuning],
    ['src/cli/cli_cmd.go', patchCliDuckLakeConfig],
    ['src/node/node.go', patchNodeCatalog],
    ['src/config/config.go', patchConfigValidation],
    ['scripts/download_duckdb_extensions.sh', patchExtensionDownloader],
    ['src/cli/system_cmd.go', patchSystemExtensions],
    ['Dockerfile', patchDockerfile]
  ];
  for (const [path, transform] of rewrites) {
    const absolute = join(sourceDir, path);
    const source = await readFile(absolute, 'utf8');
    const transformed = transform(source);
    if (transformed === source) throw new Error(`HOMER overlay made no change to ${path}`);
    await writeFile(absolute, transformed);
  }
  await copyFile(
    join(repoRoot, 'infra/ivekit/homer/postgres_catalog_test.go'),
    join(sourceDir, 'src/storage/ducklake/postgres_catalog_test.go')
  );
}

function defaultRepoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const sourceDir = process.argv[2];
  if (!sourceDir) {
    console.error('usage: node apply-overlay.mjs <homer-source-dir>');
    process.exit(2);
  }
  applyHomerOverlay({ sourceDir }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
