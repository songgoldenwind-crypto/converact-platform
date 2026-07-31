FROM rust:1.94-bookworm@sha256:6ae102bdbf528294bc79ad6e1fae682f6f7c2a6e6621506ba959f9685b308a55 AS builder

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      clang \
      cmake \
      libclang-dev \
      libsodium-dev \
      libsqlite3-dev \
      pkg-config && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /source
COPY . .
RUN cargo test --locked --all-features
RUN cargo build --locked --release --all-features

FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818

RUN apt-get update && \
    apt-get install -y --no-install-recommends \
      ca-certificates \
      libsodium23 \
      libsqlite3-0 && \
    rm -rf /var/lib/apt/lists/* && \
    groupadd --system --gid 10001 rustdesk && \
    useradd --system --uid 10001 --gid 10001 --home-dir /data rustdesk && \
    mkdir -p /data && \
    chown rustdesk:rustdesk /data

COPY --from=builder /source/target/release/hbbs /usr/local/bin/hbbs
COPY --from=builder /source/target/release/hbbr /usr/local/bin/hbbr
COPY --from=builder /source/target/release/rustdesk-utils /usr/local/bin/rustdesk-utils

WORKDIR /data
USER 10001:10001

EXPOSE 21115 21116 21116/udp 21117 21118 21119
VOLUME ["/data"]
CMD ["hbbs"]
