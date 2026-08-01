import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

const manifestPath = "goals/manifest.json";
const schemaPath = "goals/manifest.schema.json";

type HashedArtifact = {
  path: string;
  sha256: string;
};

type GoalManifest = {
  execution_baseline: {
    canonical_execution_root: string;
  };
  global_rules: HashedArtifact;
  source_artifacts: HashedArtifact[];
  goals: HashedArtifact[];
};

function json(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

test("Converact Goal manifest validates and binds every canonical artifact", () => {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addFormat("date", /^\d{4}-\d{2}-\d{2}$/);
  const validate = ajv.compile(json(schemaPath));
  const manifest = json(manifestPath) as GoalManifest;

  assert.equal(
    validate(manifest),
    true,
    validate.errors
      ?.map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("\n"),
  );
  assert.equal(
    manifest.execution_baseline.canonical_execution_root,
    "/Users/songjinfeng/Projects/converact-worktrees/platform",
  );

  const artifacts = [
    manifest.global_rules,
    ...manifest.source_artifacts,
    ...manifest.goals,
  ];
  assert.equal(
    new Set(artifacts.map((artifact) => artifact.path)).size,
    artifacts.length,
    "manifest artifact paths must be unique",
  );
  for (const artifact of artifacts) {
    assert.ok(existsSync(artifact.path), `missing ${artifact.path}`);
    assert.equal(
      artifact.sha256,
      sha256(artifact.path),
      `${artifact.path} content hash drifted`,
    );
  }
});
