# Standalone image: cheap-eyes over Streamable HTTP. Built by the user, not published.
#   docker build -t cheap-eyes .
# Nothing is copied from the repository: the server comes from npm, pinned below.
FROM node:22.23.3-alpine3.24

RUN npm install -g --ignore-scripts cheap-eyes@0.2.0 \
    && npm cache clean --force \
    && mkdir /data \
    && chown node:node /data

# Results store, usage log and export manifest; runs as the unprivileged "node"
# user (uid 1000), so a bind-mounted /data or export folder must be writable by it.
# Config: mount a file and point CHEAP_EYES_CONFIG at it (see compose.example.yaml).
ENV CHEAP_EYES_STATE_DIR=/data
VOLUME /data

USER node
EXPOSE 3400
CMD ["cheap-eyes", "serve", "--http", "--host", "0.0.0.0", "--port", "3400"]
