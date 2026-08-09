import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const WIRE_GUARD_PATCH =
  'infra/converact/rustpbx/patches/rsipstack-ivekit-wire-guard.patch';
const WIRE_REPLAY_HARNESS =
  'scripts/g03/rsipstack-wire-replay.rs';
const TRYING_SCENARIO =
  'services/converact-service/acceptance/sipp/g03-trying-uac.xml';
const FINAL_SCENARIO =
  'services/converact-service/acceptance/sipp/g03-final-486-uac.xml';
const OVERLOAD_SCENARIO =
  'services/converact-service/acceptance/sipp/g03-overload-503-uac.xml';

test('the exact rsipstack queue rejects bounded wire ambiguities before parsing', () => {
  assert.equal(existsSync(WIRE_GUARD_PATCH), true, `${WIRE_GUARD_PATCH} is required`);
  const patch = readFileSync(WIRE_GUARD_PATCH, 'utf8');
  const effective = patch
    .split('\n')
    .filter((line) => !line.startsWith('-') || line.startsWith('---'))
    .map((line) => line.startsWith('+') && !line.startsWith('+++')
      ? line.slice(1)
      : line)
    .join('\n');

  assert.match(effective, /const MAX_SIP_MESSAGE_BYTES: usize = 65_535/);
  assert.match(effective, /const MAX_SIP_HEADER_BYTES: usize = 32_768/);
  assert.match(effective, /const MAX_SIP_HEADER_LINE_BYTES: usize = 8_192/);
  assert.match(effective, /const MAX_SIP_HEADERS: usize = 128/);
  assert.match(effective, /const MAX_SIP_BODY_BYTES: usize = 32_768/);
  assert.match(effective, /validate_message_boundaries\(data, sep\)\?/);
  assert.match(effective, /header_name\.eq_ignore_ascii_case\(b"content-length"\)/);
  assert.match(
    effective,
    /name\.eq_ignore_ascii_case\(b"call-id"\) \|\| name\.eq_ignore_ascii_case\(b"i"\)/
  );
  assert.match(effective, /parser_rejects_conflicting_content_length/);
  assert.match(effective, /parser_rejects_obsolete_header_folding/);
  assert.match(effective, /parser_rejects_oversized_header_line/);
  assert.match(effective, /parser_accepts_the_wire_boundary_limits/);
  assert.match(effective, /parser_accepts_valid_extension_header_token/);
  assert.match(effective, /fn is_sip_token\(byte: u8\) -> bool/);
  assert.doesNotMatch(effective, /(?:Mutex|RwLock|HashMap|HashSet|spawn\()/);

  const build = readFileSync('infra/converact/rustpbx/build.sh', 'utf8');
  assert.match(
    build,
    /rsipstack-ivekit-server-invite-lifecycle\.patch"[\s\S]*rsipstack-ivekit-wire-guard\.patch"/
  );
  assert.match(build, /PATCHSET="ivekit\.57"/);
  assert.match(
    build,
    /^\s*cargo test --manifest-path \/build\/rsipstack\/Cargo\.toml --offline\s*$/m
  );
});

test('the wire guard patch identity is part of the pinned fork manifest', () => {
  assert.equal(existsSync(WIRE_GUARD_PATCH), true, `${WIRE_GUARD_PATCH} is required`);
  const manifest = JSON.parse(
    readFileSync('docs/capacity/forks/ivekit-forks-v1.json', 'utf8')
  ) as {
    components: Array<{
      component_id: string;
      patches: Array<{ path: string; sha256: string }>;
      implemented_changes: Array<{ change_id: string }>;
    }>;
  };
  const rsipstack = manifest.components.find(
    (component) => component.component_id === 'rsipstack'
  );
  assert.ok(rsipstack);
  const entry = rsipstack.patches.find((item) => item.path === WIRE_GUARD_PATCH);
  assert.ok(entry);
  assert.equal(
    entry.sha256,
    createHash('sha256').update(readFileSync(WIRE_GUARD_PATCH)).digest('hex')
  );
  assert.equal(
    rsipstack.implemented_changes.some(
      (change) => change.change_id === 'rsipstack-wire-guard-v1'
    ),
    true
  );
});

test('G03 freezes a non-secret exact-source wire replay harness', () => {
  assert.equal(
    existsSync(WIRE_REPLAY_HARNESS),
    true,
    `${WIRE_REPLAY_HARNESS} is required`
  );
  const harness = readFileSync(WIRE_REPLAY_HARNESS, 'utf8');
  assert.match(harness, /SipMessage::try_from\(wire\.as_slice\(\)\)/);
  assert.match(harness, /Sha256::digest\(&wire\)/);
  assert.match(harness, /body_sha256/);
  assert.match(harness, /header_names/);
  assert.doesNotMatch(harness, /header_values|Authorization.*value|println!\("\{:\?\}"/);
});

test('G03 SIPp scenarios measure one required Trying and bounded final responses', () => {
  for (const path of [TRYING_SCENARIO, FINAL_SCENARIO, OVERLOAD_SCENARIO]) {
    assert.equal(existsSync(path), true, `${path} is required`);
  }

  const trying = readFileSync(TRYING_SCENARIO, 'utf8');
  assert.match(
    trying,
    /<send retrans="500" start_rtd="g03_trying" start_txn="invite">/
  );
  assert.match(
    trying,
    /<recv response="100" rtd="g03_trying" response_txn="invite" \/>/
  );
  assert.equal((trying.match(/<recv response="100"/g) ?? []).length, 1);

  const final = readFileSync(FINAL_SCENARIO, 'utf8');
  assert.match(
    final,
    /<send retrans="500" start_rtd="g03_final" start_txn="invite">/
  );
  assert.match(
    final,
    /<recv response="486" rtd="g03_final" response_txn="invite" \/>/
  );

  const overload = readFileSync(OVERLOAD_SCENARIO, 'utf8');
  assert.match(
    overload,
    /<send retrans="500" start_rtd="g03_overload" start_txn="invite">/
  );
  assert.match(
    overload,
    /<recv response="503" rtd="g03_overload" response_txn="invite">/
  );
  assert.match(
    overload,
    /<ereg regexp="\^\[ \]\*\[1-9\]\[0-9\]\*\[ \]\*\$" search_in="hdr" header="Retry-After:"/
  );
  assert.match(overload, /<log message="verified Retry-After: \[\$1\]" \/>/);
});
