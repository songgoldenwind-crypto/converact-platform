#!/usr/bin/env bash
# Bridge openskills install dir (.agent/skills) to Cursor-native discovery (.cursor/skills).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CURSOR_SKILLS="${ROOT}/.cursor/skills"
AGENT_SKILLS="${ROOT}/.agent/skills"
GITHUB_SKILLS="${ROOT}/.github/skills"
AGENTS_SKILLS="${ROOT}/.agents/skills"

mkdir -p "${CURSOR_SKILLS}"

link_dir() {
  local name="$1"
  local rel_target="$2"
  local link="${CURSOR_SKILLS}/${name}"
  if [[ -e "${link}" || -L "${link}" ]]; then
    rm -rf "${link}"
  fi
  ln -sfn "${rel_target}" "${link}"
}

if [[ -d "${AGENT_SKILLS}" ]]; then
  for dir in "${AGENT_SKILLS}"/*/; do
    [[ -d "${dir}" ]] || continue
    name="$(basename "${dir}")"
    link_dir "${name}" "../../.agent/skills/${name}"
  done
fi

if [[ -d "${GITHUB_SKILLS}" ]]; then
  for dir in "${GITHUB_SKILLS}"/*/; do
    [[ -d "${dir}" ]] || continue
    name="$(basename "${dir}")"
  if [[ -e "${CURSOR_SKILLS}/${name}" || -L "${CURSOR_SKILLS}/${name}" ]]; then
      echo "skip ${name} (already linked from .agent/skills)"
      continue
    fi
    link_dir "${name}" "../../.github/skills/${name}"
  done
fi

# Codex / other tools expect .agents/skills (plural)
if [[ -d "${AGENT_SKILLS}" ]]; then
  mkdir -p "$(dirname "${AGENTS_SKILLS}")"
  if [[ -e "${AGENTS_SKILLS}" && ! -L "${AGENTS_SKILLS}" ]]; then
    echo "warn: ${AGENTS_SKILLS} exists and is not a symlink; leaving it alone"
  else
    rm -f "${AGENTS_SKILLS}"
    ln -sfn "../.agent/skills" "${AGENTS_SKILLS}"
  fi
fi

# Karpathy: rules file is always-on; skill entry helps Cursor Skills UI + explicit loads
KARPATHY_SKILL="${CURSOR_SKILLS}/karpathy-coding-guidelines"
if [[ ! -e "${KARPATHY_SKILL}" ]]; then
  mkdir -p "${KARPATHY_SKILL}"
  cat > "${KARPATHY_SKILL}/SKILL.md" <<'EOF'
---
name: karpathy-coding-guidelines
description: Behavioral guidelines to reduce common LLM coding mistakes. Use when writing, reviewing, or refactoring code to avoid overcomplication, make surgical changes, and define verifiable success criteria.
---

# Karpathy coding guidelines

Follow the project rule file `.cursor/rules/karpathy-guidelines.mdc` (always applied in this repo).

When this skill is invoked explicitly, re-read that rule before coding or reviewing.
EOF
fi

echo "Synced skills into ${CURSOR_SKILLS}:"
ls -1 "${CURSOR_SKILLS}"
