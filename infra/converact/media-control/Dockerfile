FROM node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d

ARG CONVERACT_SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.revision="${CONVERACT_SOURCE_COMMIT}"

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts && npm cache clean --force

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY shared ./shared

RUN install -d -m 0700 /var/lib/converact-media-control \
    && chown node:node /var/lib/converact-media-control

ENV NODE_ENV=production
ENV CONVERACT_FABRIC_MEDIA_CONTROL_HOST=0.0.0.0
ENV CONVERACT_FABRIC_MEDIA_CONTROL_PORT=3211

USER node:node

EXPOSE 3211

ENTRYPOINT ["node", "--import", "tsx", "scripts/converact-media-control-agent.ts"]
