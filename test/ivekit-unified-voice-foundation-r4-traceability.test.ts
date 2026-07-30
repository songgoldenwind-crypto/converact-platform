import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

import { type ValidateFunction } from "ajv";
import { Ajv2020 } from "ajv/dist/2020.js";

const traceContractPath =
  "docs/capacity/contracts/unified-voice-foundation-r4-traceability-v1.json";
const traceSchemaPath =
  "docs/capacity/schemas/unified-voice-foundation-r4-traceability.schema.json";
const historicalPlanPath =
  "docs/design/communication-foundation-vos5000-parity-performance-plan.md";
const bindingObjectiveSourcePath =
  "/private/tmp/opc-ivekit-unified-voice-goal-r4-2026-07-29.md";
const bindingObjectiveArchivePath =
  "docs/capacity/contracts/unified-voice-foundation-r4-objective.md";
const historicalObjectiveSourcePath =
  "/private/tmp/opc-ivekit-new-goal-2026-07-29.md";
const historicalObjectiveArchivePath =
  "docs/capacity/contracts/unified-voice-foundation-historical-objective.md";
const baselineReviewSourcePath =
  "/Users/songjinfeng/.codex/attachments/bdfd93e8-4d06-4205-8589-d1f661b680b1/pasted-text.txt";
const baselineReviewArchivePath =
  "docs/capacity/contracts/unified-voice-foundation-baseline-review.md";
const blockingReviewSourcePath =
  "/Users/songjinfeng/.codex/attachments/ca72f854-1d4f-4d32-806d-c5a3ddbe84fe/pasted-text.txt";
const blockingReviewArchivePath =
  "docs/capacity/contracts/unified-voice-foundation-blocking-review.md";
const implementationPlanPath =
  "docs/superpowers/plans/2026-07-29-unified-voice-foundation-r4.md";
const r4ContractPath =
  "docs/capacity/contracts/unified-voice-foundation-r4-v1.json";
const rvoipContractPath =
  "docs/capacity/contracts/rvoip-capability-integration-v1.json";
const goal4PlanPath =
  "docs/design/2026-07-28-ivekit-media-processing-goal4-implementation-plan.md";
const goal4ContractPath = "docs/capacity/contracts/voice-media-goal4-v1.json";
const r4DesignPath =
  "docs/design/rvoip-opc-communication-foundation-integration-design.md";
const adr7Path = "docs/adr/ccaas-7-rvoip-rustpbx-replacement-and-extraction.md";
const adr8Path = "docs/adr/ccaas-8-voice-livekit-bridge-handoff.md";
const rvoipRevision = 6;
const rvoipProjectionDigest =
  "c66835b4e86341f3cde110b9e74190b6addf2e4f7409834ac96b8dcb146ee6d8";
const goal4Revision = 6;
const goal4ProjectionDigest =
  "4493687546edd76751c6fbdd2367e53cf1b7899df2efdf9cb97f78e2cc00a779";

type JsonObject = Record<string, unknown>;

interface ArtifactBinding extends JsonObject {
  path: string;
  sha256: string;
}

interface ArchivedSourceBinding extends JsonObject {
  source_path: string;
  archive_path: string;
  source_sha256: string;
  archive_sha256: string;
}

interface ProjectedContractBinding extends JsonObject {
  path: string;
  contract_id: string;
  revision: number;
  digest_projection: string;
  content_sha256: string;
}

interface SourceIdentity extends JsonObject {
  binding_objective: ArchivedSourceBinding;
  historical_objective: ArchivedSourceBinding;
  baseline_review: ArchivedSourceBinding;
  blocking_review: ArchivedSourceBinding;
  implementation_plan: ArtifactBinding;
  historical_goal_plan: ArtifactBinding;
  r4_contract: ArtifactBinding & {
    contract_id: string;
    revision: number;
  };
  goal4_plan: ArtifactBinding;
  goal4_contract: ProjectedContractBinding;
  r4_design: ArtifactBinding;
  adr7: ArtifactBinding;
  rvoip_contract: ProjectedContractBinding & {
    capability_count: number;
    replacement_gate_count: number;
  };
  adr8: ArtifactBinding & {
    decision_id: string;
    verification_status: string;
  };
}

interface TraceabilityRow extends JsonObject {
  trace_id: string;
  kind: string;
  source_path: string;
  source_pointer: string;
  source_id: string;
  source_membership: string;
  requirement: string;
  owner_phase: string;
  contract_sections: string[];
  canonical_artifacts: string[];
  source_status: string;
  disposition: string;
  rationale: string;
  prerequisites: string[];
  evidence_targets: string[];
  evidence_status: string;
  r4_verification_status: string;
  production_eligible: boolean;
}

interface TraceabilityContract extends JsonObject {
  source_identity: SourceIdentity;
  summary: JsonObject;
  rows: TraceabilityRow[];
}

interface RvoipItem extends JsonObject {
  capability_id?: string;
  gate_id?: string;
  status: string;
  evidence_paths: string[];
  next_gate: string;
}

interface RvoipContract extends JsonObject {
  contract_id: string;
  revision: number;
  capabilities: RvoipItem[];
  replacement_gates: RvoipItem[];
}

interface ExpectedMarkdownGate {
  sourceId: string;
  membership: string;
  requirement: string;
  pointer: string;
  kind: "historical_goal_gate" | "optional_track_gate";
}

interface ExpectedReviewHeading {
  sourceId: string;
  membership: string;
  requirement: string;
  pointer: string;
}

const reviewSections = new Map<string, string[]>([
  ["C1", ["/receipt_facts"]],
  ["C2", ["/wire_freeze", "/sip_transaction_policy"]],
  ["C3", ["/rtpengine_atomic_lifecycle"]],
  ["C4", ["/backend_capability_sets", "/media_graph_compiler"]],
  ["C5", ["/recovery_matrix"]],
  ["C6", ["/single_process_failure_scope"]],
  ["I1", ["/durable_store_slo"]],
  ["I2", ["/edge_to_core_policy"]],
  ["I3", ["/media_graph_compiler"]],
  ["I4", ["/media_protocol_invariants"]],
  ["I5", ["/dtmf"]],
  ["I6", ["/g729"]],
  ["I7", ["/rolling_schema_rules"]],
  ["I8", ["/security"]],
  ["I9", ["/architecture_profile"]],
  ["I10", ["/capacity_demand"]],
  ["I11", ["/clocks"]],
  ["I12", ["/migration_drain"]],
]);

const supplementalRequirements = new Map<string, string>([
  [
    "WEBRTC_BOUNDARY",
    "WebRTC, ICE, DTLS, SRTP, TURN and SFU authority remains exclusively with LiveKit/Coturn",
  ],
  [
    "KEY_LIFECYCLE",
    "Credential, token and media-key lifecycles are explicit, bounded and auditable",
  ],
  [
    "CONFERENCE",
    "Conference and mixed-media behavior has independent functional, isolation and capacity gates",
  ],
  [
    "QUALITY_GATES",
    "Codec, speech quality, loss, jitter, drift and switching gates require physical evidence",
  ],
  [
    "FORMAL_VERIFICATION",
    "State machines and invariants have model/property verification before eligibility",
  ],
  [
    "NATIVE_FFI",
    "Native and FFI boundaries freeze ABI, allocator, panic, thread and supply-chain ownership",
  ],
]);

const supplementalSources = new Map<
  string,
  {
    path: string;
    pointer: string;
    sections: string[];
  }
>([
  [
    "WEBRTC_BOUNDARY",
    {
      path: r4ContractPath,
      pointer: "/livekit_handoff",
      sections: ["/livekit_handoff"],
    },
  ],
  [
    "KEY_LIFECYCLE",
    {
      path: r4ContractPath,
      pointer: "/security",
      sections: ["/security"],
    },
  ],
  [
    "CONFERENCE",
    {
      path: r4ContractPath,
      pointer: "/small_conference",
      sections: ["/small_conference"],
    },
  ],
  [
    "QUALITY_GATES",
    {
      path: r4ContractPath,
      pointer: "/quality",
      sections: ["/quality"],
    },
  ],
  [
    "FORMAL_VERIFICATION",
    {
      path: adr8Path,
      pointer: "#141-contract-与状态机",
      sections: [
        "/livekit_handoff/state_contract",
        "/current_target_eligibility",
      ],
    },
  ],
  [
    "NATIVE_FFI",
    {
      path: r4ContractPath,
      pointer: "/security",
      sections: ["/security", "/single_process_failure_scope"],
    },
  ],
]);

const voiceLiveKitRequirements = new Map<string, string>([
  [
    "PATH_SIP_PSTN_TO_ROOM",
    "SIP/PSTN → RustPBX → LiveKit SIP → existing/new Room",
  ],
  [
    "PATH_ROOM_TO_SIP_PSTN",
    "LiveKit Room → LiveKit SIP → RustPBX/carrier/PSTN",
  ],
  ["PATH_ACTIVE_SIP_TO_BROWSER", "active SIP → browser handoff"],
  ["PATH_ACTIVE_BROWSER_TO_SIP_PSTN", "active browser → SIP/PSTN handoff"],
  [
    "ADR8_STATE_MACHINE",
    "Durable bridge lifecycle covers legal/illegal transitions, unknown query/reconcile and terminal cleanup",
  ],
  [
    "ADR8_STORAGE",
    "VoiceMediaBridgeRepository persists exact identities, decisions, receipts and tombstones independently of recording storage",
  ],
  [
    "ADR8_BILLING_RECORDING",
    "One rating session and one root RecordingManifest/source-chain lineage survive every handoff without duplicate billing or capture ownership",
  ],
  [
    "ADR8_REAL_MEDIA",
    "Real RustPBX, RTPengine, LiveKit SIP, LiveKit, browser and SIP/PSTN peers prove bidirectional RTP/SRTP",
  ],
  [
    "ADR8_FAULT",
    "Fault injection covers owner, RTPengine, LiveKit SIP/SFU, durable store, recording store and network boundaries",
  ],
  [
    "ADR8_CAPACITY",
    "VOICE-LIVEKIT-BRIDGE-V1 independently qualifies quality, latency, switching, endurance and capacity",
  ],
]);

const voiceLiveKitSources = new Map<
  string,
  {
    pointer: string;
    sections: string[];
  }
>([
  [
    "PATH_SIP_PSTN_TO_ROOM",
    {
      pointer: "#13-必须场景",
      sections: [
        "/livekit_handoff/paths/0",
        "/livekit_handoff/results_inheritable",
      ],
    },
  ],
  [
    "PATH_ROOM_TO_SIP_PSTN",
    {
      pointer: "#13-必须场景",
      sections: [
        "/livekit_handoff/paths/1",
        "/livekit_handoff/results_inheritable",
      ],
    },
  ],
  [
    "PATH_ACTIVE_SIP_TO_BROWSER",
    {
      pointer: "#13-必须场景",
      sections: [
        "/livekit_handoff/paths/2",
        "/livekit_handoff/results_inheritable",
      ],
    },
  ],
  [
    "PATH_ACTIVE_BROWSER_TO_SIP_PSTN",
    {
      pointer: "#13-必须场景",
      sections: [
        "/livekit_handoff/paths/3",
        "/livekit_handoff/results_inheritable",
      ],
    },
  ],
  [
    "ADR8_STATE_MACHINE",
    {
      pointer: "#7-durable-bridge-lifecycle",
      sections: [
        "/livekit_handoff/state_contract",
        "/livekit_handoff/timeout_rollback",
        "/recovery_matrix",
      ],
    },
  ],
  [
    "ADR8_STORAGE",
    {
      pointer: "#6-标识与持久化合同",
      sections: [
        "/livekit_handoff/store_contract",
        "/authority_matrix/bridge_orchestration_store",
      ],
    },
  ],
  [
    "ADR8_BILLING_RECORDING",
    {
      pointer: "#143-billingrecording",
      sections: [
        "/authority_matrix/billing_rating",
        "/authority_matrix/recording_intent",
        "/authority_matrix/recording_manifest",
        "/livekit_handoff/recording_manifest_contract",
      ],
    },
  ],
  [
    "ADR8_REAL_MEDIA",
    {
      pointer: "#142-真实媒体",
      sections: ["/livekit_handoff/paths", "/quality"],
    },
  ],
  [
    "ADR8_FAULT",
    {
      pointer: "#144-故障和恢复",
      sections: [
        "/livekit_handoff/timeout_rollback",
        "/recovery_matrix",
        "/quality",
      ],
    },
  ],
  [
    "ADR8_CAPACITY",
    {
      pointer: "#15-容量和证据",
      sections: ["/livekit_handoff/paths", "/capacity_demand", "/quality"],
    },
  ],
]);

const goal3lSections = new Map<string, string[]>([
  [
    "Goal3L.acceptance.01",
    [
      "/livekit_handoff/alternating_handoff_contract/concurrent_arbitration",
      "/livekit_handoff/bridge_generation_identity_fields",
      "/authority_matrix/billing_rating",
      "/authority_matrix/recording_intent",
    ],
  ],
  [
    "Goal3L.acceptance.02",
    [
      "/livekit_handoff/alternating_handoff_contract",
      "/livekit_handoff/machine_verification_vectors",
      "/livekit_handoff/store_contract",
    ],
  ],
  [
    "Goal3L.acceptance.03",
    [
      "/livekit_handoff/alternating_handoff_contract",
      "/livekit_handoff/command_token_contract",
      "/livekit_handoff/store_contract",
    ],
  ],
  [
    "Goal3L.acceptance.04",
    [
      "/livekit_handoff/state_contract",
      "/livekit_handoff/receipt_contract",
      "/livekit_handoff/timeout_rollback",
    ],
  ],
  [
    "Goal3L.acceptance.05",
    [
      "/livekit_handoff/state_contract",
      "/livekit_handoff/timeout_rollback",
      "/recovery_matrix",
    ],
  ],
  [
    "Goal3L.acceptance.06",
    [
      "/livekit_handoff/machine_verification_vectors/fault_vectors",
      "/livekit_handoff/timeout_rollback",
      "/recovery_matrix",
    ],
  ],
  [
    "Goal3L.acceptance.07",
    ["/livekit_handoff/paths", "/media_protocol_invariants", "/quality"],
  ],
  [
    "Goal3L.acceptance.08",
    [
      "/livekit_handoff/paths",
      "/livekit_handoff/results_inheritable",
      "/capacity_demand",
    ],
  ],
  [
    "Goal3L.acceptance.09",
    [
      "/livekit_handoff/alternating_handoff_contract",
      "/livekit_handoff/recording_manifest_contract",
      "/livekit_handoff/recording_continuity",
      "/livekit_handoff/billing_continuity",
    ],
  ],
  [
    "Goal3L.acceptance.10",
    [
      "/livekit_handoff/alternating_handoff_contract",
      "/livekit_handoff/machine_verification_vectors",
      "/livekit_handoff/command_token_contract",
      "/livekit_handoff/cancellation_contract",
      "/livekit_handoff/webhook_contract",
    ],
  ],
  [
    "Goal3L.acceptance.11",
    [
      "/livekit_handoff/physical_result_status",
      "/livekit_handoff/production_result_status",
      "/livekit_handoff/production_eligible",
      "/quality/verification_status",
      "/capacity_demand/physical_result_status",
    ],
  ],
  [
    "Goal3L.acceptance.12",
    ["/livekit_handoff/machine_verification_vectors/scenario_vectors"],
  ],
  [
    "Goal3L.acceptance.13",
    ["/livekit_handoff/machine_verification_vectors/property_vectors"],
  ],
  [
    "Goal3L.acceptance.14",
    ["/livekit_handoff/machine_verification_vectors/fault_vectors"],
  ],
]);

function text(path: string): string {
  return readFileSync(path, "utf8");
}

function json(path: string): unknown {
  return JSON.parse(text(path)) as unknown;
}

function object(value: unknown, label: string): asserts value is JsonObject {
  assert.ok(
    value !== null && typeof value === "object" && !Array.isArray(value),
    `${label} must be an object`,
  );
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), "JCS input must contain finite numbers");
    return JSON.stringify(value);
  }
  assert.ok(value && typeof value === "object", "JCS input must be JSON");
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  const record = value as JsonObject;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function projectedContractDigest(path: string): string {
  const value = json(path);
  object(value, path);
  const projection = structuredClone(value);
  delete projection.foundation_authority;
  return createHash("sha256").update(canonicalJson(projection)).digest("hex");
}

function validator(): ValidateFunction<TraceabilityContract> {
  const schema = json(traceSchemaPath);
  object(schema, "traceability schema");
  return new Ajv2020({
    allErrors: true,
    strict: false,
  }).compile<TraceabilityContract>(schema);
}

function contract(): TraceabilityContract {
  const value = json(traceContractPath);
  const validate = validator();
  if (!validate(value)) {
    assert.fail(
      validate.errors
        ?.map((error) => `${error.instancePath || "/"} ${error.message}`)
        .join("\n"),
    );
  }
  return value;
}

function rvoipContract(): RvoipContract {
  const value = json(rvoipContractPath);
  object(value, "rvoip contract");
  return value as RvoipContract;
}

function normalizeMarkdown(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function markdownAcceptanceGates(): ExpectedMarkdownGate[] {
  const lines = text(historicalPlanPath).split(/\r?\n/);
  const gates: ExpectedMarkdownGate[] = [];
  let membership: string | null = null;
  let kind: ExpectedMarkdownGate["kind"] | null = null;
  let accepting = false;
  let current: string[] | null = null;
  let index = 0;

  const flush = (): void => {
    if (!membership || !kind || !current) return;
    index += 1;
    gates.push({
      sourceId: `${membership}.acceptance.${index.toString().padStart(2, "0")}`,
      membership,
      requirement: normalizeMarkdown(current.join(" ")),
      pointer: `#${membership.toLowerCase()}/acceptance/${index}`,
      kind,
    });
    current = null;
  };

  for (const line of lines) {
    const goalHeading = line.match(/^### Goal (3L|\d+)：/);
    const trackHeading = /^### 可选 Track R：/.test(line);
    if (goalHeading || trackHeading) {
      flush();
      membership = trackHeading ? "TrackR" : `Goal${goalHeading?.[1]}`;
      kind = trackHeading ? "optional_track_gate" : "historical_goal_gate";
      accepting = false;
      index = 0;
      continue;
    }
    if (/^#{1,3} /.test(line) && membership) {
      flush();
      membership = null;
      kind = null;
      accepting = false;
      continue;
    }
    if (!membership) continue;
    if (line === "验收：") {
      accepting = true;
      continue;
    }
    if (!accepting) continue;
    if (
      /^(依赖|当前实现状态|当前 IVR 连续性约束|源码证据|机器证据)：/.test(line)
    ) {
      flush();
      accepting = false;
      continue;
    }
    if (line.startsWith("- ")) {
      flush();
      current = [line.slice(2)];
      continue;
    }
    if (current && line.trim()) current.push(line.trim());
  }
  flush();

  return gates.filter(
    ({ membership: member }) =>
      member === "Goal3L" ||
      member === "TrackR" ||
      /^Goal(?:[0-9]|1[01])$/.test(member),
  );
}

function resolvePointer(root: unknown, pointer: string): unknown {
  assert.ok(pointer.startsWith("/"), `invalid JSON pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split("/")
    .reduce<unknown>((value, token) => {
      const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
      if (Array.isArray(value)) {
        const index = Number(key);
        assert.ok(
          Number.isInteger(index) && index >= 0 && index < value.length,
          `missing JSON pointer ${pointer}`,
        );
        return value[index];
      }
      object(value, `JSON pointer parent ${pointer}`);
      assert.ok(key in value, `missing JSON pointer ${pointer}`);
      return value[key];
    }, root);
}

function markdownAnchor(textValue: string): string {
  return textValue
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, "")
    .replace(/\s+/g, "-");
}

function assertMarkdownAnchor(path: string, pointer: string): void {
  assert.ok(pointer.startsWith("#"), `invalid Markdown pointer: ${pointer}`);
  const anchors = text(path)
    .split(/\r?\n/)
    .flatMap((line) => {
      const heading = line.match(/^#{1,6}\s+(.+)$/);
      return heading ? [`#${markdownAnchor(heading[1])}`] : [];
    });
  assert.ok(
    anchors.includes(pointer),
    `missing Markdown pointer ${path}${pointer}`,
  );
}

function reviewHeadings(): ExpectedReviewHeading[] {
  return text(blockingReviewArchivePath)
    .split(/\r?\n/)
    .flatMap((line) => {
      const heading = line.match(/^## ([CI]\d+)\. (.+)$/);
      if (!heading) return [];
      const [, sourceId, requirement] = heading;
      return [
        {
          sourceId,
          membership: sourceId.startsWith("C")
            ? "critical_review"
            : "important_review",
          requirement: normalizeMarkdown(requirement),
          pointer: `#${markdownAnchor(`${sourceId}. ${requirement}`)}`,
        },
      ];
    });
}

function baselineReviewHeadings(): ExpectedReviewHeading[] {
  const sourceIds = [
    "DECISION_01_AUTHORITY_BOUNDARY",
    "DECISION_02_RVOIP_LOW_LEVEL_ONLY",
    "DECISION_03_RTPENGINE_TIER1_BACKEND",
    "DECISION_04_VOICE_MEDIA_IN_PROCESS",
    "DECISION_05_BACKEND_PER_MEDIA_EDGE",
    "DECISION_06_FAST_DECODE_PATH_SEPARATION",
    "DECISION_07_BACKEND_CAPABILITY_BOUNDARY",
    "DECISION_08_RUSTPBX_DEFOUNDATION",
    "DECISION_09_FREEZE_ARCHITECTURE_ADR",
  ];
  return text(baselineReviewArchivePath)
    .split(/\r?\n/)
    .flatMap((line) => {
      const numbered = line.match(/^# ([1-9])\. (.+)$/);
      if (numbered) {
        const [, number, requirement] = numbered;
        return [
          {
            sourceId: sourceIds[Number(number) - 1],
            membership: "R4_ARCH_REVIEW",
            requirement: normalizeMarkdown(requirement),
            pointer: `#${markdownAnchor(`${number}. ${requirement}`)}`,
          },
        ];
      }
      if (line === "# 最终判断") {
        return [
          {
            sourceId: "FINAL_JUDGMENT",
            membership: "R4_ARCH_REVIEW",
            requirement: "最终判断",
            pointer: "#最终判断",
          },
        ];
      }
      return [];
    });
}

function assertArchivedSourceBinding(
  binding: ArchivedSourceBinding,
  expected: {
    sourcePath: string;
    archivePath: string;
    sha256: string;
    title: string;
  },
): void {
  assert.deepEqual(binding, {
    source_path: expected.sourcePath,
    archive_path: expected.archivePath,
    source_sha256: expected.sha256,
    archive_sha256: expected.sha256,
  });
  assert.equal(sha256(expected.archivePath), expected.sha256);
  assert.equal(
    text(expected.archivePath)
      .split(/\r?\n/)
      .find((line) => /^#{1,6} /.test(line)),
    expected.title,
  );
  if (existsSync(expected.sourcePath)) {
    assert.deepEqual(
      readFileSync(expected.archivePath),
      readFileSync(expected.sourcePath),
    );
  }
}

function assertArtifactBinding(
  binding: ArtifactBinding,
  expectedPath: string,
): void {
  assert.equal(binding.path, expectedPath);
  assert.equal(binding.sha256, sha256(expectedPath));
}

test("R4 traceability schema validates a closed row-level contract", () => {
  assert.ok(existsSync(traceSchemaPath), `missing ${traceSchemaPath}`);
  assert.ok(existsSync(traceContractPath), `missing ${traceContractPath}`);
  const validate = validator();
  const value = json(traceContractPath);
  assert.equal(
    validate(value),
    true,
    validate.errors
      ?.map((error) => `${error.instancePath || "/"} ${error.message}`)
      .join("\n"),
  );

  const topLevelDrift = structuredClone(contract()) as JsonObject;
  topLevelDrift.unreviewed_extension = true;
  assert.equal(validate(topLevelDrift), false, "top-level drift must fail");

  const rowDrift = structuredClone(contract());
  rowDrift.rows[0].unreviewed_extension = true;
  assert.equal(validate(rowDrift), false, "row drift must fail");

  const futureOnlyPromotion = structuredClone(contract());
  futureOnlyPromotion.rows[0].disposition = "satisfied_with_evidence";
  futureOnlyPromotion.rows[0].evidence_status = "verified";
  futureOnlyPromotion.rows[0].r4_verification_status = "verified";
  futureOnlyPromotion.rows[0].evidence_targets = [
    "future:docs/evidence/not-yet-produced.json",
  ];
  assert.equal(
    validate(futureOnlyPromotion),
    false,
    "future targets alone must not promote verification",
  );
});

test("R4 traceability binds objective, R4, Goal 4, RVOIP and ADR8 identities by digest", () => {
  const identity = contract().source_identity;
  const r4 = json(r4ContractPath) as {
    contract_id: string;
    revision: number;
    binding_objective: {
      source_path: string;
      archive_path: string;
      content_sha256: string;
    };
    implementation_plan: ArtifactBinding & {
      content_sha256: string;
    };
  };
  const goal4 = json(goal4ContractPath) as {
    contract_id: string;
    revision: number;
  };
  const rvoip = rvoipContract();

  assert.deepEqual(identity.binding_objective, {
    source_path: bindingObjectiveSourcePath,
    archive_path: bindingObjectiveArchivePath,
    source_sha256: r4.binding_objective.content_sha256,
    archive_sha256: sha256(bindingObjectiveArchivePath),
  });
  assert.equal(
    identity.binding_objective.source_path,
    r4.binding_objective.source_path,
  );
  assert.equal(
    identity.binding_objective.archive_path,
    r4.binding_objective.archive_path,
  );
  assert.equal(
    identity.binding_objective.source_sha256,
    identity.binding_objective.archive_sha256,
  );
  if (existsSync(bindingObjectiveSourcePath)) {
    assert.equal(
      identity.binding_objective.source_sha256,
      sha256(bindingObjectiveSourcePath),
    );
  }
  assertArchivedSourceBinding(identity.historical_objective, {
    sourcePath: historicalObjectiveSourcePath,
    archivePath: historicalObjectiveArchivePath,
    sha256: "86c5a9f871c59c436d079e7a9e4fceeeecb394954d3ce0b7f2ea8a94ec27179a",
    title: "# New OPC/iveKit Goal",
  });
  assertArchivedSourceBinding(identity.baseline_review, {
    sourcePath: baselineReviewSourcePath,
    archivePath: baselineReviewArchivePath,
    sha256: "490d80349ab21e5728042da45c857f391b93581613451d6b5771ac589757c3d1",
    title: "## 结论",
  });
  assertArchivedSourceBinding(identity.blocking_review, {
    sourcePath: blockingReviewSourcePath,
    archivePath: blockingReviewArchivePath,
    sha256: "7ad659cd9becbb40f5b2dc69171c4baaf6adaf5eeda08bbb759cabbf80db1e55",
    title: "# 审查结论",
  });
  assertArtifactBinding(identity.implementation_plan, implementationPlanPath);
  assert.equal(identity.implementation_plan.path, r4.implementation_plan.path);
  assert.equal(
    identity.implementation_plan.sha256,
    r4.implementation_plan.content_sha256,
  );
  assertArtifactBinding(identity.historical_goal_plan, historicalPlanPath);
  assertArtifactBinding(identity.r4_contract, r4ContractPath);
  assert.equal(identity.r4_contract.contract_id, r4.contract_id);
  assert.equal(identity.r4_contract.revision, r4.revision);
  assertArtifactBinding(identity.goal4_plan, goal4PlanPath);
  assert.equal(identity.goal4_contract.path, goal4ContractPath);
  assert.equal(identity.goal4_contract.contract_id, goal4.contract_id);
  assert.equal(identity.goal4_contract.revision, goal4Revision);
  assert.equal(identity.goal4_contract.revision, goal4.revision);
  assert.equal(
    identity.goal4_contract.digest_projection,
    "rfc8785_jcs_without_top_level_authority_binding",
  );
  assert.equal(identity.goal4_contract.content_sha256, goal4ProjectionDigest);
  assert.equal(
    identity.goal4_contract.content_sha256,
    projectedContractDigest(goal4ContractPath),
  );
  assertArtifactBinding(identity.r4_design, r4DesignPath);
  assertArtifactBinding(identity.adr7, adr7Path);
  assert.equal(identity.rvoip_contract.path, rvoipContractPath);
  assert.equal(identity.rvoip_contract.contract_id, rvoip.contract_id);
  assert.equal(identity.rvoip_contract.revision, rvoipRevision);
  assert.equal(identity.rvoip_contract.revision, rvoip.revision);
  assert.equal(
    identity.rvoip_contract.digest_projection,
    "rfc8785_jcs_without_top_level_authority_binding",
  );
  assert.equal(identity.rvoip_contract.content_sha256, rvoipProjectionDigest);
  assert.equal(
    identity.rvoip_contract.content_sha256,
    projectedContractDigest(rvoipContractPath),
  );
  assert.equal(
    identity.rvoip_contract.capability_count,
    rvoip.capabilities.length,
  );
  assert.equal(
    identity.rvoip_contract.replacement_gate_count,
    rvoip.replacement_gates.length,
  );
  assertArtifactBinding(identity.adr8, adr8Path);
  assert.equal(identity.adr8.decision_id, "voice-livekit-bridge-handoff-r1");
  assert.equal(identity.adr8.verification_status, "not_run");
});

test("every canonical Goal acceptance bullet has exactly one row", () => {
  const expected = markdownAcceptanceGates();
  const actual = contract().rows.filter(
    (row) =>
      row.kind === "historical_goal_gate" || row.kind === "optional_track_gate",
  );

  assert.ok(
    expected.length > 12,
    "must parse individual gates, not Goal summaries",
  );
  assert.equal(
    expected.filter((gate) => gate.membership === "Goal3L").length,
    14,
  );
  assert.deepEqual(
    actual.map((row) => ({
      sourceId: row.source_id,
      membership: row.source_membership,
      requirement: row.requirement,
      pointer: row.source_pointer,
      kind: row.kind,
    })),
    expected,
  );
  assert.ok(actual.every((row) => row.source_path === historicalPlanPath));
  for (const row of actual.filter(
    (entry) => entry.source_membership === "Goal3L",
  )) {
    assert.deepEqual(row.contract_sections, goal3lSections.get(row.source_id));
  }
});

test("RVOIP capability and replacement rows preserve source order, IDs, status and membership", () => {
  const source = rvoipContract();
  const capabilityRows = contract().rows.filter(
    (row) => row.kind === "rvoip_capability",
  );
  const replacementRows = contract().rows.filter(
    (row) => row.kind === "rvoip_replacement_gate",
  );

  assert.deepEqual(
    capabilityRows.map((row) => row.source_id),
    source.capabilities.map((item) => item.capability_id),
  );
  assert.deepEqual(
    replacementRows.map((row) => row.source_id),
    source.replacement_gates.map((item) => item.gate_id),
  );

  for (const [index, row] of capabilityRows.entries()) {
    const item = source.capabilities[index];
    assert.equal(row.source_membership, "capabilities");
    assert.equal(row.source_pointer, `/capabilities/${index}`);
    assert.equal(row.source_status, item.status);
    assert.equal(row.requirement, item.next_gate);
    assert.ok(
      item.evidence_paths.every((path) =>
        row.canonical_artifacts.includes(path),
      ),
    );
  }
  for (const [index, row] of replacementRows.entries()) {
    const item = source.replacement_gates[index];
    assert.equal(row.source_membership, "replacement_gates");
    assert.equal(row.source_pointer, `/replacement_gates/${index}`);
    assert.equal(row.source_status, item.status);
    assert.equal(row.requirement, item.next_gate);
    assert.ok(
      item.evidence_paths.every((path) =>
        row.canonical_artifacts.includes(path),
      ),
    );
  }
});

test("critical, important and six supplemental review headings map exactly", () => {
  const rows = contract().rows;
  const reviews = rows.filter((row) => row.kind === "review");
  const supplements = rows.filter((row) => row.kind === "supplemental_review");
  const expectedReviews = reviewHeadings();

  assert.deepEqual(
    reviews.map((row) => ({
      sourceId: row.source_id,
      membership: row.source_membership,
      requirement: row.requirement,
      pointer: row.source_pointer,
    })),
    expectedReviews,
  );
  assert.equal(
    expectedReviews.filter(({ membership }) => membership === "critical_review")
      .length,
    6,
  );
  assert.equal(
    expectedReviews.filter(
      ({ membership }) => membership === "important_review",
    ).length,
    12,
  );
  assert.deepEqual(
    new Map(supplements.map((row) => [row.source_id, row.requirement])),
    supplementalRequirements,
  );
  for (const row of reviews) {
    assert.deepEqual(row.contract_sections, reviewSections.get(row.source_id));
    assert.equal(row.source_path, blockingReviewArchivePath);
    assert.ok(
      row.canonical_artifacts.includes(blockingReviewArchivePath),
      row.trace_id,
    );
  }
  for (const row of supplements) {
    const expected = supplementalSources.get(row.source_id);
    assert.ok(expected, row.source_id);
    assert.equal(row.source_membership, "supplemental_review");
    assert.equal(row.source_path, expected.path);
    assert.equal(row.source_pointer, expected.pointer);
    assert.deepEqual(row.contract_sections, expected.sections);
  }
});

test("baseline review and historical objective retain real source membership", () => {
  const rows = contract().rows;
  const baselineRows = rows.filter((row) => row.kind === "baseline_review");
  const expectedBaseline = baselineReviewHeadings();
  assert.equal(expectedBaseline.length, 10);
  assert.deepEqual(
    baselineRows.map((row) => ({
      sourceId: row.source_id,
      membership: row.source_membership,
      requirement: row.requirement,
      pointer: row.source_pointer,
    })),
    expectedBaseline,
  );
  assert.ok(
    baselineRows.every(
      (row) =>
        row.source_path === baselineReviewArchivePath &&
        row.canonical_artifacts.includes(baselineReviewArchivePath),
    ),
  );

  const historicalRows = rows.filter(
    (row) => row.kind === "historical_objective",
  );
  assert.equal(historicalRows.length, 1);
  const [historical] = historicalRows;
  assert.equal(historical.source_path, historicalObjectiveArchivePath);
  assert.equal(historical.source_pointer, "#new-opcivekit-goal");
  assert.equal(historical.source_id, "GOALS_4_THROUGH_11");
  assert.equal(historical.source_membership, "historical_objective");
  assert.equal(historical.disposition, "superseded_with_rationale");
  assert.ok(
    normalizeMarkdown(text(historicalObjectiveArchivePath)).includes(
      normalizeMarkdown(historical.requirement),
    ),
  );
  assert.ok(
    historical.canonical_artifacts.includes(historicalObjectiveArchivePath),
  );
});

test("Voice to LiveKit four paths and all six ADR8 evidence classes are distinct", () => {
  const rows = contract().rows.filter((row) => row.kind === "voice_livekit");
  assert.deepEqual(
    new Map(rows.map((row) => [row.source_id, row.requirement])),
    voiceLiveKitRequirements,
  );
  const r4 = json(r4ContractPath);
  for (const row of rows) {
    const expected = voiceLiveKitSources.get(row.source_id);
    assert.ok(expected, row.source_id);
    assert.equal(row.source_path, adr8Path);
    assert.equal(row.source_pointer, expected.pointer);
    assert.equal(row.source_membership, "ADR8");
    assert.deepEqual(row.contract_sections, expected.sections);
  }
  for (const [index, sourceId] of [
    "PATH_SIP_PSTN_TO_ROOM",
    "PATH_ROOM_TO_SIP_PSTN",
    "PATH_ACTIVE_SIP_TO_BROWSER",
    "PATH_ACTIVE_BROWSER_TO_SIP_PSTN",
  ].entries()) {
    const row = rows.find((entry) => entry.source_id === sourceId);
    assert.ok(row, sourceId);
    const path = resolvePointer(
      r4,
      `/livekit_handoff/paths/${index}`,
    ) as JsonObject;
    const slices = path.evidence_slices as JsonObject[];
    assert.deepEqual(
      slices.map((slice) => slice.status),
      ["not_run", "not_run", "not_run"],
    );
    assert.ok(
      slices.every((slice) => slice.results_inheritable === false),
      sourceId,
    );
  }
});

test("all contract pointers and artifact paths are reviewable", () => {
  const r4 = json(r4ContractPath);
  const rows = contract().rows;
  assert.equal(new Set(rows.map((row) => row.trace_id)).size, rows.length);

  for (const row of rows) {
    assert.ok(existsSync(row.source_path), `${row.trace_id} source path`);
    if (row.source_path.endsWith(".json")) {
      resolvePointer(json(row.source_path), row.source_pointer);
    } else if (
      row.kind === "historical_objective" ||
      row.kind === "baseline_review" ||
      row.kind === "review" ||
      row.kind === "supplemental_review" ||
      row.kind === "voice_livekit"
    ) {
      assertMarkdownAnchor(row.source_path, row.source_pointer);
    } else {
      assert.ok(row.source_pointer.startsWith("#"), row.trace_id);
    }
    for (const pointer of row.contract_sections) resolvePointer(r4, pointer);
    for (const path of row.canonical_artifacts) {
      assert.ok(
        path.startsWith("future:") || existsSync(path),
        `${row.trace_id} missing canonical artifact ${path}`,
      );
    }
    assert.ok(row.evidence_targets.length > 0, row.trace_id);
  }

  const counts = Object.fromEntries(
    [...new Set(rows.map((row) => row.kind))].map((kind) => [
      kind,
      rows.filter((row) => row.kind === kind).length,
    ]),
  );
  const summary = contract().summary;
  assert.equal(summary.row_count, 362);
  assert.equal(summary.goal_3l_gate_count, 14);
  assert.equal((summary.kind_counts as JsonObject).historical_goal_gate, 102);
  assert.equal(summary.row_count, rows.length);
  assert.deepEqual(summary.kind_counts, counts);
  assert.equal(
    summary.goal_0_11_gate_count,
    rows.filter(
      (row) =>
        row.kind === "historical_goal_gate" &&
        row.source_membership !== "Goal3L",
    ).length,
  );
  assert.equal(
    summary.goal_3l_gate_count,
    rows.filter(
      (row) =>
        row.kind === "historical_goal_gate" &&
        row.source_membership === "Goal3L",
    ).length,
  );
  assert.equal(
    summary.optional_track_gate_count,
    rows.filter((row) => row.kind === "optional_track_gate").length,
  );
  assert.equal(
    summary.review_c_count,
    rows.filter((row) => row.kind === "review" && row.source_id.startsWith("C"))
      .length,
  );
  assert.equal(
    summary.review_i_count,
    rows.filter((row) => row.kind === "review" && row.source_id.startsWith("I"))
      .length,
  );
  assert.equal(
    summary.supplemental_review_count,
    rows.filter((row) => row.kind === "supplemental_review").length,
  );
  assert.equal(
    summary.baseline_review_count,
    rows.filter((row) => row.kind === "baseline_review").length,
  );
  assert.equal(
    summary.historical_objective_count,
    rows.filter((row) => row.kind === "historical_objective").length,
  );
  assert.equal(
    summary.rvoip_capability_count,
    rows.filter((row) => row.kind === "rvoip_capability").length,
  );
  assert.equal(
    summary.rvoip_replacement_gate_count,
    rows.filter((row) => row.kind === "rvoip_replacement_gate").length,
  );
  assert.equal(
    summary.voice_livekit_count,
    rows.filter((row) => row.kind === "voice_livekit").length,
  );
});

test("source status never promotes R4 verification and future targets never impersonate evidence", () => {
  const rows = contract().rows;
  const allowedDispositions = new Set([
    "inherited",
    "satisfied_with_evidence",
    "superseded_with_rationale",
    "deferred_with_prerequisite",
    "not_run",
  ]);

  for (const row of rows) {
    assert.ok(allowedDispositions.has(row.disposition), row.trace_id);
    assert.ok(row.rationale.length > 0, row.trace_id);
    assert.equal(row.production_eligible, false, row.trace_id);
    if (row.disposition === "deferred_with_prerequisite") {
      assert.ok(row.prerequisites.length > 0, row.trace_id);
    }
    if (row.disposition === "satisfied_with_evidence") {
      assert.equal(row.r4_verification_status, "verified", row.trace_id);
      assert.equal(row.evidence_status, "verified", row.trace_id);
    }
    if (row.evidence_status === "verified") {
      assert.ok(
        row.evidence_targets.some(
          (path) => !path.startsWith("future:") && existsSync(path),
        ),
        `${row.trace_id} future target impersonates evidence`,
      );
    }
    if (row.r4_verification_status !== "not_run") {
      assert.equal(row.r4_verification_status, "verified", row.trace_id);
      assert.equal(row.evidence_status, "verified", row.trace_id);
      assert.equal(row.disposition, "satisfied_with_evidence", row.trace_id);
      assert.ok(
        row.evidence_targets.some(
          (path) => !path.startsWith("future:") && existsSync(path),
        ),
        `${row.trace_id} promoted without existing evidence`,
      );
    }
  }

  assert.ok(
    rows.some((row) => row.source_status !== "not_run"),
    "source status separation must be exercised",
  );
  assert.ok(
    rows.some((row) =>
      row.evidence_targets.some((path) => path.startsWith("future:")),
    ),
    "future target boundary must be exercised",
  );
  assert.ok(
    rows.every(
      (row) =>
        row.r4_verification_status === "not_run" &&
        row.evidence_status === "not_run",
    ),
    "unproved Revision 4 rows must remain not_run",
  );
});
