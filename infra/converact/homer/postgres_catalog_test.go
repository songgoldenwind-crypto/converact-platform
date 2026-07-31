package ducklake

import (
	"strings"
	"testing"
)

func TestPostgresCatalogType(t *testing.T) {
	got, err := NormalizeCatalogType(CatalogType(" POSTGRES "))
	if err != nil {
		t.Fatal(err)
	}
	if got != CatalogPostgres {
		t.Fatalf("NormalizeCatalogType() = %q, want %q", got, CatalogPostgres)
	}
	if _, err := NormalizeCatalogType(CatalogType("mysql")); err == nil {
		t.Fatal("NormalizeCatalogType(mysql) unexpectedly succeeded")
	}
}

func TestPostgresAttachSQLIsEscaped(t *testing.T) {
	dsn := "dbname=homer host=postgres password=p'ass"
	sql, err := BuildCatalogAttachSQL(
		CatalogPostgres,
		dsn,
		`homer"lake`,
		"s3://bucket/o'ne",
		true,
	)
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{
		"ducklake:postgres:dbname=homer host=postgres password=p''ass",
		`AS "homer""lake"`,
		"DATA_PATH 's3://bucket/o''ne'",
		"OVERRIDE_DATA_PATH TRUE",
	} {
		if !strings.Contains(sql, want) {
			t.Fatalf("BuildCatalogAttachSQL() = %q, missing %q", sql, want)
		}
	}
}

func TestPostgresCatalogRejectsProcessLocalSharding(t *testing.T) {
	_, err := NewShardedWriter(Config{
		CatalogType: CatalogPostgres,
		CatalogPath: "dbname=homer host=postgres",
		DataPath:    "/var/lib/homer/parquet",
		LakeName:    "homer_lake",
		ShardCount:  2,
	})
	if err == nil || !strings.Contains(err.Error(), "shard_count=1") {
		t.Fatalf("NewShardedWriter() error = %v, want shard_count guard", err)
	}
}

func TestPostgresCatalogDefaultSpillDoesNotUseDSN(t *testing.T) {
	for _, dsn := range []string{
		"postgres://homer:secret@postgres:5432/homer",
		"postgresql://homer:secret@postgres:5432/homer",
		"dbname=homer host=postgres password=secret",
	} {
		if got := DefaultSpillDirectory(dsn); got != "" {
			t.Fatalf("DefaultSpillDirectory(%q) = %q, want empty", dsn, got)
		}
	}
}
