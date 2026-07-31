#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LIVEKIT_INGRESS_UPSTREAM_TAG = 'v1.5.0';
export const LIVEKIT_INGRESS_UPSTREAM_COMMIT =
  '363f6090d572db8eef5b60c273c0970826fb7ca6';

const IVEKIT_DOCKERFILE_MARKER = '# iveKit exact-source offline build';

export function patchLiveKitIngressDockerfile(source) {
  if (source.includes(IVEKIT_DOCKERFILE_MARKER)) return source;

  for (const anchor of [
    'FROM livekit/gstreamer:$GSTVERSION-dev',
    'curl -L -o /tmp/go.tar.gz',
    'RUN go mod download',
    'CGO_ENABLED=1 GOOS=linux',
    'FROM livekit/gstreamer:$GSTVERSION-prod',
    'ENTRYPOINT ["ingress"]'
  ]) {
    if (!source.includes(anchor)) {
      throw new Error(`LiveKit Ingress Dockerfile anchor mismatch: ${anchor}`);
    }
  }

  return `${IVEKIT_DOCKERFILE_MARKER}
ARG IVEKIT_INGRESS_BUILDER_IMAGE
ARG IVEKIT_INGRESS_RUNTIME_IMAGE

FROM \${IVEKIT_INGRESS_BUILDER_IMAGE} AS ivekit-builder
ARG TARGETARCH
WORKDIR /workspace

# The checksum-verified toolchain and vendor tree are materialized by build.sh.
COPY ivekit/toolchain/go/ /usr/local/go/
RUN test "$(head -n 1 /usr/local/go/VERSION)" = "go1.25.0"
ENV PATH="/usr/local/go/bin:\${PATH}"
COPY go.mod go.sum ./
COPY vendor/ vendor/
ENV GOFLAGS=-mod=vendor
COPY cmd/ cmd/
COPY pkg/ pkg/
COPY version/ version/
RUN GOCACHE=/tmp/ivekit-ingress-go-cache go test ./pkg/... && \\
    GOCACHE=/tmp/ivekit-ingress-go-cache CGO_ENABLED=1 GOOS=linux GOARCH=\${TARGETARCH} \\
      go build -trimpath -a -o /workspace/ingress ./cmd/server && \\
    rm -rf /tmp/ivekit-ingress-go-cache

FROM \${IVEKIT_INGRESS_RUNTIME_IMAGE}
COPY --from=ivekit-builder /workspace/ingress /bin/ingress
ENV HOME=/tmp
USER 10001:10001
ENTRYPOINT ["/bin/ingress"]
`;
}

export async function applyLiveKitIngressOverlay(input) {
  const sourceDir = resolve(input.sourceDir);
  const commit = execFileSync('git', ['-C', sourceDir, 'rev-parse', 'HEAD'], {
    encoding: 'utf8'
  }).trim();
  if (commit !== LIVEKIT_INGRESS_UPSTREAM_COMMIT) {
    throw new Error(
      `LiveKit Ingress source commit mismatch: expected ${LIVEKIT_INGRESS_UPSTREAM_COMMIT}, got ${commit}`
    );
  }
  const exactTag = execFileSync(
    'git',
    ['-C', sourceDir, 'describe', '--tags', '--exact-match', 'HEAD'],
    { encoding: 'utf8' }
  ).trim();
  if (exactTag !== LIVEKIT_INGRESS_UPSTREAM_TAG) {
    throw new Error(
      `LiveKit Ingress source tag mismatch: expected ${LIVEKIT_INGRESS_UPSTREAM_TAG}, got ${exactTag}`
    );
  }

  const dockerfilePath = join(sourceDir, 'build/ingress/Dockerfile');
  const source = await readFile(dockerfilePath, 'utf8');
  await writeFile(dockerfilePath, patchLiveKitIngressDockerfile(source), 'utf8');
  return {
    upstream_tag: LIVEKIT_INGRESS_UPSTREAM_TAG,
    upstream_commit: LIVEKIT_INGRESS_UPSTREAM_COMMIT,
    source_dir: sourceDir
  };
}

function defaultSourceDir() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '../../../upstream/livekit-ingress');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const sourceDir = process.argv[2] || defaultSourceDir();
  applyLiveKitIngressOverlay({ sourceDir }).then((result) => {
    console.log(JSON.stringify(result));
  }).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
