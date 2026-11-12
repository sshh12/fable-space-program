# The ONE image (ARCHITECTURE 16.1): every role of the game runs from it, selected by ROLES.
#   docker build -f deploy/Dockerfile --build-arg COMMIT=$(git rev-parse HEAD) -t fsp .
#   docker run -e ROLES=shell -e PORT=8080 ... fsp
#
# Node is pinned by digest (journal replay is defined on the exact runtime). The build computes the buildId
# from that digest and the server bundle's hash (deploy/build/stamp.mjs); CI builds this same file at the
# same commit and records the id, and the rollout refuses a deployment whose id differs (16.2).
# The dump role needs pg_dump of the server's major: the PGDG postgresql-client-18 is installed beside Node.
# Baked data is NOT in the image (data/tiles is not in the repository): packs live in the packs bucket and
# shell loads the boot pack from it at start (10.4).

ARG NODE_IMAGE=node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203

FROM ${NODE_IMAGE} AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --ignore-scripts && npm rebuild esbuild
COPY . .
RUN node deploy/build/build-server.mjs --out=/out/server \
 && node tools/dev/build-client.mjs --target=ci \
 && mkdir -p /out && cp -r out/ci/client /out/client \
 && find /out/client -name '*.map' -delete \
 && if grep -rl 'sourceMappingURL' /out/client --include='*.js' --include='*.css'; then echo 'a source map reference reached the image' >&2; exit 1; fi \
 && cp deploy/build/stamp.mjs /out/server/stamp.mjs

FROM ${NODE_IMAGE}
ARG NODE_IMAGE
ARG COMMIT=unknown
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl gnupg \
 && install -d /usr/share/postgresql-common/pgdg \
 && curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc https://www.postgresql.org/media/keys/ACCC4CF8.asc \
 && echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] https://apt.postgresql.org/pub/repos/apt bookworm-pgdg main" > /etc/apt/sources.list.d/pgdg.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends postgresql-client-18 \
 && apt-get purge -y gnupg && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out/server /app/server
COPY --from=build /out/client /app/client
# boot-manifest.json and pack-sets.json are written by the upload tool (tools/pack/cli.ts upload); a shell
# without them fails its health check by design. boot-pack.json is always there, so the glob never matches nothing.
COPY deploy/*.json /app/deploy/
RUN node /app/server/stamp.mjs --bundle=/app/server/main.mjs --node-digest="${NODE_IMAGE##*@}" --commit="${COMMIT}"
ENV NODE_ENV=production \
    STATIC_DIR=/app/client \
    BOOT_MANIFEST=/app/deploy/boot-manifest.json \
    PACK_SETS_FILE=/app/deploy/pack-sets.json \
    PG_DUMP=/usr/lib/postgresql/18/bin/pg_dump
USER node
EXPOSE 8080
CMD ["node", "/app/server/main.mjs"]
