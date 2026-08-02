FROM node:24-alpine@sha256:a0b9bf06e4e6193cf7a0f58816cc935ff8c2a908f81e6f1a95432d679c54fbfd

WORKDIR /app

USER root
RUN apk add --no-cache docker-cli=29.5.3-r0

COPY infra/capacity/package.json infra/capacity/package-lock.json ./
RUN npm ci --ignore-scripts \
    && npm prune --omit=dev --ignore-scripts

COPY scripts/capacity/fixtures/rustpbx-router.ts ./scripts/capacity/fixtures/rustpbx-router.ts
COPY src/config/converact-env.ts ./src/config/converact-env.ts

LABEL org.opencontainers.image.revision="fa4fd69e3474c0e0739363c0976a5dc508ed9695" \
      io.converact.product-candidate="e4f8dd49c5e3ecec684bddeb6811a13aa9c8079a" \
      io.converact.component="g03-validation-tools" \
      io.converact.validation-scope="router-and-docker-cli"

USER node
CMD ["node", "--import", "tsx", "scripts/capacity/fixtures/rustpbx-router.ts"]
