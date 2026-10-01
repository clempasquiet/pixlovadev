# syntax=docker/dockerfile:1
# Images de recette pixlova (ADR-015). Contexte : racine du dépôt.
#   api     : API (listener public 3000, interne 127.0.0.1:3001), migrations et bucket
#   worker  : worker média/manifests/alertes, avec FFmpeg
#   gateway : passerelle Caddy (dashboard, Player Web, routage API et stockage)
#   admin   : administration plateforme privée (listener 8081, console) — ADR-016
#   site    : site public statique (Caddy, 8090) — ADR-018, origines fixées au build
# Utilisateurs non root, aucune dépendance de développement dans les images finales.

ARG NODE_IMAGE=node:24.21.0-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6
ARG CADDY_IMAGE=caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b

FROM ${NODE_IMAGE} AS build
ENV PNPM_HOME=/pnpm CI=true
RUN corepack enable
WORKDIR /src
COPY . .
RUN --mount=type=cache,id=pixlova-pnpm,target=/pnpm/store \
    pnpm install --frozen-lockfile
RUN pnpm --workspace-concurrency=1 \
      --filter "@pixlova/api..." --filter "@pixlova/workers..." \
      --filter "@pixlova/dashboard..." --filter "@pixlova/web-player..." \
      --filter "@pixlova/admin-console..." \
      run build

# Dépendances de production seulement, liens du workspace conservés.
FROM build AS server-files
RUN --mount=type=cache,id=pixlova-pnpm,target=/pnpm/store \
    rm -rf node_modules apps/*/node_modules packages/*/node_modules \
 && pnpm install --frozen-lockfile --prod --offline \
      --filter "@pixlova/api..." --filter "@pixlova/workers..." \
 && rm -rf apps/dashboard apps/web-player apps/admin-console apps/render-lab apps/player-shell apps/site \
      scripts infra \
      apps/*/src apps/*/test packages/*/src packages/*/test

FROM ${NODE_IMAGE} AS node-base
ENV NODE_ENV=production
WORKDIR /app
COPY --from=server-files /src /app
USER node

FROM node-base AS api
ENV PUBLIC_HOST=0.0.0.0 PUBLIC_PORT=3000 INTERNAL_HOST=127.0.0.1 INTERNAL_PORT=3001
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.INTERNAL_PORT||3001)+'/internal/v1/ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/api/dist/server.js"]

FROM node-base AS admin
COPY --from=build /src/apps/admin-console/dist /app/admin-console
ENV ADMIN_HOST=0.0.0.0 ADMIN_PORT=8081 PIXLOVA_ADMIN_CONSOLE_DIR=/app/admin-console
EXPOSE 8081
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8081/admin-ready').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
CMD ["node", "apps/api/dist/admin-server.js"]

FROM node-base AS worker
USER root
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/* \
 && install -d -o node -g node -m 700 /var/tmp/pixlova-worker
USER node
ENV PIXLOVA_WORKER_TMP_DIR=/var/tmp/pixlova-worker/jobs \
    PIXLOVA_WORKER_HEALTH_FILE=/var/tmp/pixlova-worker/healthy
HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD ["node", "-e", "const s=require('fs').statSync(process.env.PIXLOVA_WORKER_HEALTH_FILE);process.exit(Date.now()-s.mtimeMs<60000?0:1)"]
CMD ["node", "apps/workers/dist/main.js"]

FROM ${CADDY_IMAGE} AS gateway
COPY infra/recette/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /src/apps/dashboard/dist /srv/dashboard
COPY --from=build /src/apps/web-player/dist /srv/play
# Port non privilégié : la capacité de fichier de caddy (cap_net_bind_service) est retirée
# pour démarrer avec cap_drop ALL et no-new-privileges. Clés publiques montées au démarrage.
RUN cp /usr/bin/caddy /tmp/caddy && mv /tmp/caddy /usr/bin/caddy \
 && mkdir -p /srv/play/trust && chown -R 65534:65534 /data /config
USER 65534:65534
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/gateway-health"]

# Site public : pages générées au build avec les origines passées en arguments (ADR-018).
FROM build AS site-build
ARG PIXLOVA_SITE_ORIGIN=
ARG PIXLOVA_SITE_APP_URL=
ARG PIXLOVA_SITE_STATUS_URL=
ARG PIXLOVA_SITE_INDEXABLE=false
RUN pnpm --filter @pixlova/site run build

FROM ${CADDY_IMAGE} AS site
COPY apps/site/Caddyfile /etc/caddy/Caddyfile
COPY --from=site-build /src/apps/site/dist /srv/site
RUN cp /usr/bin/caddy /tmp/caddy && mv /tmp/caddy /usr/bin/caddy \
 && chown -R 65534:65534 /data /config
USER 65534:65534
EXPOSE 8090
HEALTHCHECK --interval=15s --timeout=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8090/site-health"]
