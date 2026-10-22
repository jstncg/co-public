FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90 AS media-fetcher

ARG YT_DLP_VERSION=2026.06.09
ARG YT_DLP_SHA256=e5d57466682cfa9d61e9cf7c8a4f09b00f4a62af37d3bbdc4bcffdf63615feac

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && curl --fail --show-error --location --retry 3 "https://github.com/yt-dlp/yt-dlp/releases/download/${YT_DLP_VERSION}/yt-dlp" --output /usr/local/bin/yt-dlp \
    && echo "${YT_DLP_SHA256}  /usr/local/bin/yt-dlp" | sha256sum --check --strict \
    && chmod 0755 /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

FROM node:22.19.0-bookworm-slim@sha256:4a4884e8a44826194dff92ba316264f392056cbe243dcc9fd3551e71cea02b90 AS runtime

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates python3 tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=media-fetcher /usr/local/bin/yt-dlp /usr/local/bin/yt-dlp

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

COPY --chown=node:node src ./src
COPY --chown=node:node skills ./skills
COPY --chown=node:node distributions ./distributions
COPY --chown=node:node README.md ARCHITECTURE.md goal.md ./

RUN mkdir -p /data /data/profiles /data/workspaces /data/backups \
    && chown -R node:node /data

ENV NODE_ENV=production \
    CO_ENV=production \
    CO_HOME=/data

USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8787/health/ready').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"]

ENTRYPOINT ["/usr/bin/tini", "--", "node", "src/cli.ts"]
CMD ["daemon", "--host", "0.0.0.0", "--port", "8787"]
