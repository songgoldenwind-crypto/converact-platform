FROM ubuntu@sha256:4fbb8e6a8395de5a7550b33509421a2bafbc0aab6c06ba2cef9ebffbc7092d90

ARG ASTERISK_VERSION=1:20.6.0~dfsg+~cs6.13.40431414-2build5

USER root
RUN apt-get update -qq \
    && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y \
      "asterisk=${ASTERISK_VERSION}" \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

COPY asterisk/pjsip.conf /etc/asterisk/pjsip.conf
COPY asterisk/extensions.conf /etc/asterisk/extensions.conf
COPY asterisk/logger.conf /etc/asterisk/logger.conf

LABEL org.opencontainers.image.revision="6655675005aac51d8989bc750bdab8a5bbe240df" \
      io.converact.product-candidate="e4f8dd49c5e3ecec684bddeb6811a13aa9c8079a" \
      io.converact.component="g03-real-sip-peer" \
      io.converact.asterisk-package="1:20.6.0~dfsg+~cs6.13.40431414-2build5"

EXPOSE 5060/udp

CMD ["asterisk", "-f", "-U", "asterisk", "-G", "asterisk", "-vvv"]
