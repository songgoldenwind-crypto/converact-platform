# syntax=docker/dockerfile:1.7

FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818 AS builder

ARG KAMAILIO_VERSION=6.0.7
ARG KAMAILIO_SOURCE_URL=https://www.kamailio.org/pub/kamailio/6.0.7/src/kamailio-6.0.7_src.tar.gz
ARG KAMAILIO_SOURCE_SHA256=f147c3237bb43749eac7bbc1bc97761f6636e7b9cacda120b0911c2be9447865
ARG LIBJWT_VERSION=2.1.3
ARG LIBJWT_SOURCE_URL=https://github.com/benmcollins/libjwt/releases/download/v2.1.3/libjwt-2.1.3.tar.xz
ARG LIBJWT_SOURCE_SHA256=f095f503c3a33fd9c6e3439212b461bda59d9c37ce64bffbe5a871fbd11ed29b

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bison \
      build-essential \
      ca-certificates \
      curl \
      flex \
      libcurl4-openssl-dev \
      libevent-dev \
      libjansson-dev \
      libpcre2-dev \
      libssl-dev \
      libunistring-dev \
      libxml2-dev \
      patch \
      pkg-config \
      xz-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /usr/src
COPY patches/0001-dispatcher-retain-probe-state.patch /tmp/0001-dispatcher-retain-probe-state.patch
RUN curl -fsSLo libjwt.tar.xz \
      "${LIBJWT_SOURCE_URL}" \
    && echo "${LIBJWT_SOURCE_SHA256}  libjwt.tar.xz" | sha256sum -c - \
    && tar -xJf libjwt.tar.xz \
    && rm libjwt.tar.xz

WORKDIR /usr/src/libjwt-${LIBJWT_VERSION}
RUN ./configure \
      --prefix=/opt/libjwt \
      --disable-static \
      --without-gnutls \
      --with-openssl \
    && make -j"$(nproc)" \
    && make install

ENV PKG_CONFIG_PATH="/opt/libjwt/lib/pkgconfig"

WORKDIR /usr/src
RUN curl -fsSLo kamailio.tar.gz \
      "${KAMAILIO_SOURCE_URL}" \
    && echo "${KAMAILIO_SOURCE_SHA256}  kamailio.tar.gz" | sha256sum -c - \
    && tar -xzf kamailio.tar.gz \
    && rm kamailio.tar.gz

WORKDIR /usr/src/kamailio-${KAMAILIO_VERSION}
RUN patch -p1 < /tmp/0001-dispatcher-retain-probe-state.patch \
    && make cfg prefix=/opt/kamailio group_include="standard" include_modules="dispatcher dialog dmq dmq_usrloc htable jansson jwt outbound path registrar siptrace tls usrloc websocket xhttp_prom" \
    && make -j"$(nproc)" all \
    && make install

FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818 AS runtime

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
      libjansson4 \
      libpcre2-8-0 \
      libssl3 \
      libunistring2 \
      libxml2 \
      netbase \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 kamailio \
    && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin kamailio \
    && install -d -o 10001 -g 10001 /etc/kamailio /var/lib/kamailio /var/run/kamailio

COPY --from=builder /opt/kamailio /opt/kamailio
COPY --from=builder /opt/libjwt/lib /opt/libjwt/lib

ENV LD_LIBRARY_PATH="/opt/libjwt/lib" \
    PATH="/opt/kamailio/sbin:${PATH}"
USER 10001:10001
WORKDIR /var/lib/kamailio
HEALTHCHECK NONE

ENTRYPOINT ["/opt/kamailio/sbin/kamailio"]
CMD ["-DD", "-E", "-f", "/etc/kamailio/kamailio.cfg"]
