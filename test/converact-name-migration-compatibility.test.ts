import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import YAML from "yaml";

import {
  ConveractFabricHttpSdkError,
  IveKitHttpSdkError,
  createConveractFabricClient,
  createIveKitClient,
} from "../sdk/converact/src/index.js";
import {
  ConveractClient,
  OPCClient,
} from "../sdk/javascript/src/index.js";

const guidePath = "docs/migrations/opc-to-converact-v1.md";

test("published SDK compatibility exports resolve to one implementation", () => {
  assert.equal(createIveKitClient, createConveractFabricClient);
  assert.equal(IveKitHttpSdkError, ConveractFabricHttpSdkError);
  assert.equal(OPCClient, ConveractClient);
});

test("brand migration preserves stable HTTP paths and moves only presentation", () => {
  const openapi = YAML.parse(readFileSync("docs/openapi.yaml", "utf8")) as {
    info: { title: string };
    paths: Record<string, unknown>;
  };
  assert.equal(openapi.info.title, "Converact Platform API");
  assert.ok(openapi.paths["/api/ivekit/voice/calls"]);
  assert.equal(
    Object.keys(openapi.paths).filter((path) => path.startsWith("/api/converact/"))
      .length,
    0,
  );
  assert.ok(existsSync("public/widget/converact-chat-widget.js"));
  assert.equal(existsSync("public/widget/opc-chat-widget.js"), false);
});

test("migration guide freezes mappings, compatibility, rollback and stable IDs", () => {
  assert.ok(existsSync(guidePath), `missing ${guidePath}`);
  const guide = readFileSync(guidePath, "utf8");
  for (const requirement of [
    "@converact/sdk",
    "CONVERACT_FABRIC_",
    "OPC_IVEKIT_",
    "ghcr.io/songgoldenwind-crypto/converact-",
    "converact-platform",
    "兼容窗口",
    "冲突",
    "回滚",
    "保持不变",
    "/api/ivekit/",
    "active-zero",
    "production_unchanged",
  ]) {
    assert.match(guide, new RegExp(requirement.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
