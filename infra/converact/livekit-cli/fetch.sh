#!/usr/bin/env bash
set -euo pipefail

readonly VERSION="2.18.1"
readonly ASSET="lk_2.18.1_linux_amd64.tar.gz"
readonly SHA256="2185c98a3fd3c9e6ecf224ed6ebb1689c5abf17383db7d8294bec0056bb90c73"
readonly URL="https://github.com/livekit/livekit-cli/releases/download/v${VERSION}/${ASSET}"
readonly DESTINATION="${1:-$(pwd)/.cache/livekit-cli/${VERSION}}"

mkdir -p "${DESTINATION}"
archive="$(mktemp "${TMPDIR:-/tmp}/converact-livekit-cli.XXXXXX")"
trap 'rm -f "${archive}"' EXIT

curl --fail --location --proto '=https' --tlsv1.2 \
  --output "${archive}" \
  "${URL}"
printf '%s  %s\n' "${SHA256}" "${archive}" | sha256sum --check -
tar --extract --gzip --file "${archive}" --directory "${DESTINATION}" lk
chmod 0755 "${DESTINATION}/lk"
"${DESTINATION}/lk" --version | grep --fixed-strings "lk version ${VERSION}"
