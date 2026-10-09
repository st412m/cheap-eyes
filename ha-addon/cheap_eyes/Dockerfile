# Home Assistant add-on image. Supervisor builds it from this folder; nothing is
# copied from the repository root: the server comes from npm, pinned below.
# Release: publish cheap-eyes to npm first, then bump the package version here and
# `version` in config.yaml together (same number as the core; tools/check-release.mjs).
FROM ghcr.io/home-assistant/base:3.24-2026.08.0

ARG BUILD_ARCH

# Not npm -g: it ignores --omit=optional, and native @napi-rs/canvas must not be in the image (SIGILL without AVX).
# npm may leave an empty node_modules/@napi-rs scope folder: removed if empty, then the build fails if it is still there.
RUN apk add --no-cache nodejs npm \
    && mkdir -p /opt/cheap-eyes \
    && cd /opt/cheap-eyes \
    && npm install --ignore-scripts --omit=optional --no-package-lock --no-save cheap-eyes@0.2.0 \
    && ln -s /opt/cheap-eyes/node_modules/.bin/cheap-eyes /usr/local/bin/cheap-eyes \
    && npm cache clean --force \
    && { rmdir /opt/cheap-eyes/node_modules/@napi-rs 2>/dev/null || true; } \
    && ! test -e /opt/cheap-eyes/node_modules/@napi-rs

COPY run.sh /
RUN chmod a+x /run.sh

LABEL \
    io.hass.name="cheap-eyes" \
    io.hass.description="MCP server that hands bulk reading to cheap OpenRouter models" \
    io.hass.version="0.2.0" \
    io.hass.type="app" \
    io.hass.arch="${BUILD_ARCH}" \
    org.opencontainers.image.source="https://github.com/st412m/cheap-eyes" \
    org.opencontainers.image.licenses="MIT"

CMD [ "/run.sh" ]
