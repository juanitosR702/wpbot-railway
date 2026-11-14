FROM node:20.18.3-bookworm-slim

# yt-dlp se instala desde la última release para no quedarse con extractores
# viejos cuando YouTube cambia. Fija una versión concreta si una release rompe
# algo: `railway up --build-arg YTDLP_VERSION=2026.10.26`.
ARG YTDLP_VERSION=latest
# Deno es el runtime JavaScript que yt-dlp habilita por defecto para resolver
# los challenges de YouTube (sin él se pierden formatos).
ARG DENO_VERSION=latest

ENV NODE_ENV=production \
    TZ=America/Bogota \
    AUTH_DIR=/app/bridge/auth

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl ffmpeg gosu tini tzdata unzip \
    && if [ "$YTDLP_VERSION" = "latest" ]; then \
         YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux"; \
       else \
         YTDLP_URL="https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp_linux"; \
       fi \
    && curl --fail --location --retry 3 "$YTDLP_URL" --output /usr/local/bin/yt-dlp \
    && chmod 0755 /usr/local/bin/yt-dlp \
    && if [ "$DENO_VERSION" = "latest" ]; then \
         DENO_URL="https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip"; \
       else \
         DENO_URL="https://github.com/denoland/deno/releases/download/v${DENO_VERSION}/deno-x86_64-unknown-linux-gnu.zip"; \
       fi \
    && curl --fail --location --retry 3 "$DENO_URL" --output /tmp/deno.zip \
    && unzip -o /tmp/deno.zip -d /usr/local/bin \
    && chmod 0755 /usr/local/bin/deno \
    && rm -f /tmp/deno.zip \
    && /usr/local/bin/yt-dlp --version \
    && /usr/local/bin/deno --version \
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
