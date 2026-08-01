FROM rust:1.94-bookworm@sha256:6ae102bdbf528294bc79ad6e1fae682f6f7c2a6e6621506ba959f9685b308a55 AS builder

WORKDIR /src

COPY services/voice-media-rs/Cargo.toml services/voice-media-rs/Cargo.lock ./
COPY services/voice-media-rs/src ./src

RUN cargo build --locked --release

FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818

ARG CONVERACT_SOURCE_COMMIT=unknown
LABEL org.opencontainers.image.revision="${CONVERACT_SOURCE_COMMIT}"
LABEL org.opencontainers.image.description="Converact Fabric bounded RTP processing pool"

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 converact \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin converact

COPY --from=builder /src/target/release/voice-media-rs /usr/local/bin/voice-media-rs

USER 10001:10001

EXPOSE 8093/tcp

ENTRYPOINT ["/usr/local/bin/voice-media-rs"]
