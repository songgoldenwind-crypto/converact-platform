ARG LIVEKIT_SIP_BUILDER_IMAGE
FROM ${LIVEKIT_SIP_BUILDER_IMAGE} AS builder

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      libopus-dev \
      libopusfile-dev \
      libsoxr-dev \
      pkg-config \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

COPY go.mod go.sum ./
RUN go mod download && go mod verify

COPY res/ res/
COPY cmd/ cmd/
COPY pkg/ pkg/
COPY version/ version/
COPY LICENSE.txt NOTICE ./

ARG TARGETARCH
ARG LIVEKIT_SIP_VERSION
RUN go test ./pkg/... \
    && arch="${TARGETARCH:-$(go env GOARCH)}" \
    && CGO_ENABLED=1 GOOS=linux GOARCH="${arch}" GO111MODULE=on go build -trimpath \
      -ldflags "-s -w -X github.com/livekit/sip/version.Version=${LIVEKIT_SIP_VERSION}" \
      -o /out/livekit-sip ./cmd/livekit-sip

ARG LIVEKIT_SIP_RUNTIME_IMAGE
FROM ${LIVEKIT_SIP_RUNTIME_IMAGE}

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      libopus0 \
      libopusfile0 \
      libsoxr0 \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 livekit-sip \
    && useradd --uid 10001 --gid 10001 --home-dir /sip --shell /usr/sbin/nologin livekit-sip \
    && install -d -o 10001 -g 10001 /sip

COPY --from=builder /out/livekit-sip /usr/local/bin/livekit-sip
COPY --from=builder /workspace/LICENSE.txt /workspace/NOTICE /usr/share/doc/livekit-sip/

WORKDIR /sip
USER 10001:10001
EXPOSE 5060/udp 5060/tcp 10000-20000/udp
ENTRYPOINT ["/usr/local/bin/livekit-sip"]
CMD ["--config=/sip/config.yaml"]
