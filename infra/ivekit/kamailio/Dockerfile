# syntax=docker/dockerfile:1.7

FROM debian:bookworm-slim AS builder

ARG KAMAILIO_VERSION=6.0.7
ARG KAMAILIO_SOURCE_SHA256=c4b5c17abba18d5378108df7138177caae33de7d54ead8c9ee1e28650b20d6b5

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bison \
      build-essential \
      ca-certificates \
      curl \
      flex \
      libcurl4-openssl-dev \
      libevent-dev \
      libpcre2-dev \
      libssl-dev \
      libunistring-dev \
      libxml2-dev \
      pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src
RUN curl -fsSLo kamailio.tar.gz \
      "https://github.com/kamailio/kamailio/archive/refs/tags/${KAMAILIO_VERSION}.tar.gz" \
    && echo "${KAMAILIO_SOURCE_SHA256}  kamailio.tar.gz" | sha256sum -c - \
    && tar -xzf kamailio.tar.gz \
    && rm kamailio.tar.gz

WORKDIR /usr/src/kamailio-${KAMAILIO_VERSION}
RUN make cfg prefix=/opt/kamailio group_include="standard" include_modules="dispatcher dialog htable tls websocket xhttp_prom" \
    && make -j"$(nproc)" all \
    && make install

FROM debian:bookworm-slim AS runtime

ARG KAMAILIO_VERSION=6.0.7
LABEL org.opencontainers.image.title="iveKit Kamailio SIP Edge" \
      org.opencontainers.image.version="${KAMAILIO_VERSION}" \
      org.opencontainers.image.source="https://github.com/kamailio/kamailio" \
      io.ivekit.upstream.ref="kamailio/kamailio@6.0.7"

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      libcurl4 \
      libevent-2.1-7 \
      libpcre2-8-0 \
      libssl3 \
      libunistring2 \
      libxml2 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 kamailio \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin kamailio \
    && install -d -o 10001 -g 10001 /etc/kamailio /var/lib/kamailio /var/run/kamailio

COPY --from=builder /opt/kamailio /opt/kamailio

ENV PATH="/opt/kamailio/sbin:${PATH}"
USER 10001:10001
WORKDIR /var/lib/kamailio
HEALTHCHECK NONE

ENTRYPOINT ["/opt/kamailio/sbin/kamailio"]
CMD ["-DD", "-E", "-f", "/etc/kamailio/kamailio.cfg"]
