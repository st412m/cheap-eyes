# Home Assistant add-on image. Supervisor builds it from this folder; nothing is
# copied from the repository root: the server comes from npm, pinned below.
# Release: publish cheap-eyes to npm first, then bump the package version here and
# `version` in config.yaml together (same number as the core).
FROM ghcr.io/home-assistant/base:3.24-2026.08.0

ARG BUILD_ARCH

RUN apk add --no-cache nodejs npm \
    && npm install -g --ignore-scripts cheap-eyes@0.1.0 \
    && npm cache clean --force

COPY run.sh /
RUN chmod a+x /run.sh

LABEL \
    io.hass.name="cheap-eyes" \
    io.hass.description="MCP server that hands bulk reading to cheap OpenRouter models" \
    io.hass.version="0.1.0" \
    io.hass.type="app" \
    io.hass.arch="${BUILD_ARCH}" \
    org.opencontainers.image.source="https://github.com/st412m/cheap-eyes" \
    org.opencontainers.image.licenses="MIT"

CMD [ "/run.sh" ]
