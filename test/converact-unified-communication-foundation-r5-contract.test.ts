import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { Ajv2020 } from "ajv/dist/2020.js";

const contractPath =
  "docs/capacity/contracts/unified-communication-foundation-r5-v1.json";
const contractSchemaPath =
  "docs/capacity/schemas/unified-communication-foundation-r5.schema.json";
const tracePath =
  "docs/capacity/contracts/unified-communication-foundation-r5-traceability-v1.json";
const traceSchemaPath =
  "docs/capacity/schemas/unified-communication-foundation-r5-traceability.schema.json";

type JsonObject = Record<string, unknown>;

const R5_FREEZE_COMMIT = "301b28f652a377c48f971a8ca581be454f977627";

function json(path: string): JsonObject {
  return JSON.parse(readFileSync(path, "utf8")) as JsonObject;
}

function sha256(path: string): string {
  const frozen = execFileSync("git", ["show", `${R5_FREEZE_COMMIT}:${path}`]);
  return createHash("sha256").update(frozen).digest("hex");
}

function assertBindings(value: unknown): void {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  for (const binding of Object.values(value)) {
    assert.ok(
      binding && typeof binding === "object" && !Array.isArray(binding),
    );
    const { path, sha256: expected } = binding as {
      path: string;
      sha256: string;
    };
    assert.equal(expected, sha256(path), `${path} content hash drifted`);
  }
}

function validate(schemaPath: string, valuePath: string): void {
  const validator = new Ajv2020({ allErrors: true, strict: false }).compile(
    json(schemaPath),
  );
  assert.equal(
    validator(json(valuePath)),
    true,
    validator.errors
      ?.map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("\n"),
  );
}

test("Revision 5 machine contracts preserve their frozen OPC identity", () => {
  const schema = json(contractSchemaPath);
  const traceSchema = json(traceSchemaPath);
  assert.equal(
    schema.$id,
    "https://opc.local/schemas/unified-communication-foundation-r5.schema.json",
  );
  assert.equal(schema.title, "OPC Unified Communication Foundation Revision 5");
  assert.equal(
    traceSchema.$id,
    "https://opc.local/schemas/unified-communication-foundation-r5-traceability.schema.json",
  );
  assert.equal(
    traceSchema.title,
    "OPC Unified Communication Foundation Revision 5 Traceability",
  );

  validate(contractSchemaPath, contractPath);
  validate(traceSchemaPath, tracePath);

  const contract = json(contractPath);
  assertBindings(contract.artifacts);
  const inheritedR4 = contract.inherited_r4 as JsonObject;
  assertBindings({
    objective: inheritedR4.objective,
    machine_contract: inheritedR4.machine_contract,
    traceability: inheritedR4.traceability,
  });

  const trace = json(tracePath) as {
    source_identity: JsonObject;
    inherited_r4: JsonObject;
    delta_rows: Array<{ requirement: string }>;
  };
  assertBindings(trace.source_identity);
  const inherited = { ...trace.inherited_r4 };
  delete inherited.policy;
  delete inherited.status_rule;
  delete inherited.r5_document_acceptance_upgrades_r4_rows;
  assertBindings(inherited);
  assert.ok(trace.delta_rows.some((row) => /\bOPC\b/.test(row.requirement)));
});
