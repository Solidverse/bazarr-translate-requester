FROM node:24-bookworm-slim AS base
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY src/ ./src/

FROM base AS development
ENV NODE_ENV=development
USER node
CMD ["npm", "run", "dev"]

FROM base AS production
RUN apt-get update \
    && apt-get install -y --no-install-recommends cron tzdata util-linux gosu tini procps \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/crontab /etc/cron.d/*
ENV TZ=Etc/UTC PUID=99 PGID=100
COPY scripts/setup-cron.mjs ./scripts/setup-cron.mjs
COPY --chmod=755 docker/entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY --chmod=755 docker/run.sh /usr/local/bin/run-requester
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "/usr/local/bin/docker-entrypoint.sh"]
