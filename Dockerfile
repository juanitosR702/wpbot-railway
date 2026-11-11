FROM node:20.18.3-bookworm-slim

ARG YTDLP_VERSION=2025.02.19

ENV NODE_ENV=production \
    TZ=America/Bogota \
    AUTH_DIR=/app/bridge/auth

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg gosu tini tzdata \
    && curl --fail --location --retry 3 \
      "https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux" \
      --output /usr/local/bin/yt-dlp \
    && chmod 0755 /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app/bot

COPY bot/package.json bot/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm rebuild sharp \
    && npm cache clean --force

RUN groupadd --gid 10001 bot \
    && useradd --uid 10001 --gid bot --create-home --shell /usr/sbin/nologin bot \
    && install -d --owner bot --group bot --mode 0700 /app/bridge/auth

COPY --chown=bot:bot bot/ ./

RUN mkdir -p /app/bot/logs && chown bot:bot /app/bot/logs

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod 0755 /usr/local/bin/docker-entrypoint.sh

HEALTHCHECK --interval=30s --timeout=10s --start-period=45s --retries=3 \
  CMD curl --fail --silent --show-error "http://127.0.0.1:${PORT:-3000}/health" >/dev/null

# Arranca como root solo para ajustar el volumen y luego baja a `bot` (gosu).
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "src/index.js"]
