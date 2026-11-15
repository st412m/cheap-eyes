# cheap-eyes over Streamable HTTP. Published as ghcr.io/st412m/cheap-eyes by
# .github/workflows/image.yml on a version tag; to build it yourself:
#   docker build -t cheap-eyes:0.3.0 .
# The server comes from npm, pinned below. To build from an `npm pack` tarball placed
# next to this file instead (before a release, or a local change):
#   docker build --build-arg CHEAP_EYES_TARBALL=cheap-eyes-0.3.0.tgz -t cheap-eyes:0.3.0 .
FROM node:22.23.3-alpine3.24

# A tarball in the build context, by file name; empty = cheap-eyes from npm.
ARG CHEAP_EYES_TARBALL=

# Not npm -g: it ignores --omit=optional. The install goes into its own directory and
# a link, without the native canvas module of the PDF reader (text extraction does not
# need it). npm may leave an empty @napi-rs scope folder: removed when empty, and the
# build fails when anything is still in it. `check-config` runs offline at build time,
# or the build fails.
RUN --mount=type=bind,target=/ctx \
    SRC=cheap-eyes@0.3.0 \
    && if [ -n "$CHEAP_EYES_TARBALL" ]; then SRC="/ctx/$CHEAP_EYES_TARBALL"; fi \
    && mkdir -p /opt/cheap-eyes \
    && cd /opt/cheap-eyes \
    && npm install --ignore-scripts --omit=optional --no-package-lock --no-save "$SRC" \
    && { rmdir /opt/cheap-eyes/node_modules/@napi-rs 2>/dev/null || true; } \
    && ! test -e /opt/cheap-eyes/node_modules/@napi-rs \
    && ln -s /opt/cheap-eyes/node_modules/.bin/cheap-eyes /usr/local/bin/cheap-eyes \
    && npm cache clean --force \
    && mkdir -p /data /input \
    && chown node:node /data \
    && CHEAP_EYES_STATE_DIR=/tmp/cheap-eyes-check CHEAP_EYES_READ_ROOTS=/input cheap-eyes check-config \
    && rm -rf /tmp/cheap-eyes-check

# /data: the HTTP token (generated on the first start and shown once in the log),
# the results store, the usage log and the picked models. The process runs as "node"
# (uid 1000): /data must be writable by it.
# /input: the folders cheap-eyes may read, mounted read-only below it.
# Settings are variables of the container; refusals name the variable or the mount.
ENV CHEAP_EYES_STATE_DIR=/data CHEAP_EYES_READ_ROOTS=/input CHEAP_EYES_SETTINGS_UI="the environment of the container"
VOLUME /data

USER node
EXPOSE 3400
CMD ["cheap-eyes", "serve", "--http", "--host", "0.0.0.0", "--port", "3400"]
