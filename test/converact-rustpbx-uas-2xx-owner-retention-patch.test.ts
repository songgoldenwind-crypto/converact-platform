import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const RSIPSTACK_PATCH =
  "infra/converact/rustpbx/patches/rsipstack-converact-uas-2xx-owner-retention.patch";
const RUSTPBX_PATCH =
  "infra/converact/rustpbx/patches/rustpbx-converact-uas-2xx-owner-retention.patch";
const BUILD = "infra/converact/rustpbx/build.sh";

function additions(contents: string): string {
  return contents
    .split("\n")
    .filter((line) => line.startsWith("+") && !line.startsWith("+++"))
    .map((line) => line.slice(1))
    .join("\n");
}

test("ivekit.64 retains the successful server-INVITE owner", () => {
  const patches = [
    [RSIPSTACK_PATCH, "9719e5b4d6b3fe1a2b4d88fab3d39f28267becdc3a1535df7383e0ea90bf7fbe"],
    [RUSTPBX_PATCH, "627b584861eb6731a4c8876309f74ec54fae6371aa1011df9a92ee4c9c2e556a"],
  ] as const;
  for (const [path, digest] of patches) {
    assert.equal(existsSync(path), true, `${path} is required`);
    assert.equal(
      createHash("sha256").update(readFileSync(path)).digest("hex"),
      digest,
    );
    const parsed = spawnSync("git", ["apply", "--numstat", path], {
      encoding: "utf8",
    });
    assert.equal(parsed.status, 0, parsed.stderr);
  }

  const build = readFileSync(BUILD, "utf8");
  assert.match(build, /PATCHSET="ivekit\.84"/);
  assert.match(
    build,
    /rsipstack-converact-uas-2xx-owner\.patch"[\s\S]*rsipstack-converact-uas-2xx-owner-retention\.patch"[\s\S]*rustrtc-ivekit-udp-socket-capacity\.patch"/,
  );
  assert.match(
    build,
    /rustpbx-converact-uas-2xx-owner\.patch"[\s\S]*rustpbx-converact-uas-2xx-owner-retention\.patch"/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rsipstack" apply --numstat[\s\S]*rsipstack-converact-uas-2xx-owner-retention\.patch/,
  );
  assert.match(
    build,
    /git -C "\$BUILD_ROOT\/rustpbx" apply --numstat[\s\S]*rustpbx-converact-uas-2xx-owner-retention\.patch/,
  );
});

test("2xx ownership drains only after ACK, deadline, or transport failure", () => {
  const source = additions(readFileSync(RSIPSTACK_PATCH, "utf8"));
  assert.match(source, /pub async fn drain_server_invite/);
  assert.match(source, /self\.server_invite_2xx_owner\.is_none\(\)/);
  assert.match(source, /is_non_2xx_server_invite \|\| is_2xx_server_invite/);
  assert.match(source, /server_invite_2xx_drain_retains_owner_until_deadline/);
  assert.match(source, /initial_2xx_send_failure_does_not_commit_response_and_terminates/);
  assert.doesNotMatch(source, /tokio::spawn\(|unbounded_channel|std::thread::spawn/);
});

test("RustPBX classifies the UAS deadline and retains the transaction owner", () => {
  const source = additions(readFileSync(RUSTPBX_PATCH, "utf8"));
  assert.match(source, /tx\.drain_server_invite\(\)/);
  assert.match(source, /ServerInviteTermination::Uas2xxDeadlineExpired/);
  assert.match(source, /"cause" => "uas_2xx_deadline_expired"/);
  assert.match(
    source,
    /ivekit_server_invite_2xx_owner_survives_module_return_until_cancelled/,
  );
});
