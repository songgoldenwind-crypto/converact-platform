import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const ledgerPath =
  "docs/design/converact-architecture-source-ledger-2026-07-31.md";
const sourceRoot = "/Users/songjinfeng/Desktop/opc/architecture-foundation";

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("architecture source ledger closes every source and target hash", () => {
  const ledger = readFileSync(ledgerPath, "utf8");
  const sourceRows = [
    ...ledger.matchAll(
      /^\| `([^`]+)` \| `([0-9a-f]{64})` \| `([^`]+)` \| `(verified_duplicate|import|reconcile)` \| `([^`]+)` \|$/gm,
    ),
  ];
  const closureRows = [
    ...ledger.matchAll(/^\| `([^`]+)` \| `([0-9a-f]{64})` \|$/gm),
  ];

  assert.equal(sourceRows.length, 51);
  assert.equal(closureRows.length, 51);
  assert.equal(
    new Set(sourceRows.map((row) => row[1])).size,
    sourceRows.length,
    "source paths must be unique",
  );
  assert.equal(
    new Set(sourceRows.map((row) => row[3])).size,
    sourceRows.length,
    "target paths must be unique",
  );

  const closure = new Map(closureRows.map((row) => [row[1], row[2]]));
  for (const row of sourceRows) {
    const [, sourcePath, sourceHash, targetPath, , resolution] = row;
    const absoluteSource = `${sourceRoot}/${sourcePath}`;
    assert.ok(existsSync(absoluteSource), `missing source ${absoluteSource}`);
    assert.equal(sha256(absoluteSource), sourceHash, `${sourcePath} source drift`);
    assert.doesNotMatch(resolution, /pending/i);
    assert.ok(existsSync(targetPath), `missing target ${targetPath}`);
    assert.equal(
      closure.get(targetPath),
      sha256(targetPath),
      `${targetPath} target drift`,
    );
  }
});
