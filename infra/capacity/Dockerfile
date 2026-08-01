FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

WORKDIR /app

RUN apk add --no-cache iproute2

COPY infra/capacity/package.json infra/capacity/package-lock.json ./
RUN npm ci --ignore-scripts

COPY infra/capacity/tsconfig.json ./infra/capacity/tsconfig.json
COPY scripts/capacity ./scripts/capacity
COPY scripts/converact-capacity-dispatcher.ts ./scripts/converact-capacity-dispatcher.ts
COPY scripts/converact-capacity-controller.ts ./scripts/converact-capacity-controller.ts
COPY scripts/converact-capacity-finalizer.ts ./scripts/converact-capacity-finalizer.ts
COPY scripts/converact-capacity-scaling-finalizer.ts ./scripts/converact-capacity-scaling-finalizer.ts
COPY scripts/converact-capacity-platform-finalizer.ts ./scripts/converact-capacity-platform-finalizer.ts
COPY scripts/converact-capacity-worker.ts ./scripts/converact-capacity-worker.ts
COPY --chmod=0755 scripts/converact-capacity-tinode-worker.ts ./scripts/converact-capacity-tinode-worker.ts
COPY --chmod=0755 scripts/converact-capacity-tinode-composite.ts ./scripts/converact-capacity-tinode-composite.ts
COPY --chmod=0755 scripts/converact-capacity-tinode-provision.ts ./scripts/converact-capacity-tinode-provision.ts
COPY --chmod=0755 scripts/converact-capacity-tinode-staircase.ts ./scripts/converact-capacity-tinode-staircase.ts
COPY --chmod=0755 scripts/converact-capacity-sip-kamailio-staircase.ts ./scripts/converact-capacity-sip-kamailio-staircase.ts
COPY scripts/converact-capacity-network-impairment.ts ./scripts/converact-capacity-network-impairment.ts
COPY scripts/converact-cell-admission.ts ./scripts/converact-cell-admission.ts
COPY scripts/converact-cell-capacity-projector.ts ./scripts/converact-cell-capacity-projector.ts
COPY scripts/converact-component-node-admission.ts ./scripts/converact-component-node-admission.ts
COPY scripts/converact-rustdesk-owner-binding.ts ./scripts/converact-rustdesk-owner-binding.ts
COPY services/converact-service/acceptance/sipp/answer-bye-uac.xml /opt/converact/scenarios/answer-bye-uac.xml
COPY src/config/converact-env.ts ./src/config/converact-env.ts
COPY src/infra/nats-connection-options.ts ./src/infra/nats-connection-options.ts
COPY src/converact-component-node-admission.ts ./src/converact-component-node-admission.ts
COPY src/converact-placement-snapshot-projector.ts ./src/converact-placement-snapshot-projector.ts
COPY src/agent-runtime/converact/placement/admission-http.ts ./src/agent-runtime/converact/placement/admission-http.ts
COPY src/agent-runtime/converact/placement/admission-ledger.ts ./src/agent-runtime/converact/placement/admission-ledger.ts
COPY src/agent-runtime/converact/placement/admission.ts ./src/agent-runtime/converact/placement/admission.ts
COPY src/agent-runtime/converact/placement/cell-lease.ts ./src/agent-runtime/converact/placement/cell-lease.ts
COPY src/agent-runtime/converact/placement/component-node-admission-http.ts ./src/agent-runtime/converact/placement/component-node-admission-http.ts
COPY src/agent-runtime/converact/placement/component-node-admission.ts ./src/agent-runtime/converact/placement/component-node-admission.ts
COPY src/agent-runtime/converact/placement/component-node-sync.ts ./src/agent-runtime/converact/placement/component-node-sync.ts
COPY src/agent-runtime/converact/placement/component-node-topology.ts ./src/agent-runtime/converact/placement/component-node-topology.ts
COPY src/agent-runtime/converact/placement/owner-epoch.ts ./src/agent-runtime/converact/placement/owner-epoch.ts
COPY src/agent-runtime/converact/placement/pg-queryable.ts ./src/agent-runtime/converact/placement/pg-queryable.ts
COPY src/agent-runtime/converact/placement/rustdesk-owner-binding.ts ./src/agent-runtime/converact/placement/rustdesk-owner-binding.ts
COPY src/agent-runtime/converact/placement/snapshot.ts ./src/agent-runtime/converact/placement/snapshot.ts
COPY src/agent-runtime/converact/placement/types.ts ./src/agent-runtime/converact/placement/types.ts
COPY src/agent-runtime/converact/recordings/recording-manifest.ts ./src/agent-runtime/converact/recordings/recording-manifest.ts
COPY src/agent-runtime/converact/recordings/rustpbx-recording-spool-capacity.ts ./src/agent-runtime/converact/recordings/rustpbx-recording-spool-capacity.ts

RUN ./node_modules/.bin/tsc --noEmit -p infra/capacity/tsconfig.json
RUN npm prune --omit=dev --ignore-scripts

USER node

CMD ["node", "--import", "tsx", "scripts/converact-capacity-dispatcher.ts"]
