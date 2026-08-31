#!/usr/bin/env bash
set -eu

if [ "$#" -ne 2 ]; then
  echo "active-call arguments=fail" >&2
  exit 2
fi

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repository_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
lock_file="$repository_root/infra/converact/active-call/source-lock.json"

exec node --input-type=module - "$1" "$2" "$lock_file" <<'NODE'
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";

const [, , checkout, archive, lockFile] = process.argv;
const lock = JSON.parse(readFileSync(lockFile, "utf8"));
const expected = lock.upstream;

function git(...args) {
  const result = spawnSync("git", ["-C", checkout, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

function sha256(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

function size(path) {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

const commit = git("rev-parse", "HEAD");
const tree = git("rev-parse", "HEAD^{tree}");
const branch = git("symbolic-ref", "-q", "HEAD");
const status = git("status", "--porcelain=v1", "--untracked-files=all");
const tracked = git("ls-files", "-z");

const checks = {
  commit: commit === expected.commit,
  tree: tree === expected.tree,
  detached: branch === null,
  clean: status === "",
  archive: sha256(archive) === expected.archive_sha256,
  size: size(archive) === expected.archive_size_bytes,
  files:
    tracked !== null &&
    tracked.split("\0").filter(Boolean).length === expected.tracked_files,
  manifests:
    sha256(`${checkout}/Cargo.toml`) === expected.cargo_toml_sha256 &&
    sha256(`${checkout}/README.md`) === expected.readme_sha256,
};

const sourceIdentity =
  checks.commit && checks.tree && checks.detached && checks.clean && checks.files;
const fields = {
  source_identity: sourceIdentity,
  ...checks,
};

console.log(
  `active-call ${Object.entries(fields)
    .map(([name, passed]) => `${name}=${passed ? "pass" : "fail"}`)
    .join(" ")}`,
);

if (!Object.values(fields).every(Boolean)) {
  process.exitCode = 1;
}
NODE
