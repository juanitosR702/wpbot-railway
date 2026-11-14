#!/bin/sh
# Railway monta el volumen como root; el bot corre como usuario `bot` (uid 10001).
# Ajustamos el dueño de AUTH_DIR y bajamos privilegios antes de arrancar Node.
set -eu

AUTH_DIR="${AUTH_DIR:-/app/bridge/auth}"
COOKIE_FILE="$AUTH_DIR/cookies.txt"

# Cookies de YouTube para yt-dlp. Una variable de Railway admite 32768
# caracteres y un cookies.txt completo en base64 se pasa, así que también se
# acepta comprimido con gzip: YTDLP_COOKIES_GZ_B64. Se escribe en el volumen y,
# si no hay YTDLP_COOKIES explícito, yt-dlp apunta a esa ruta.
cookie_ok() {
  [ -s "$COOKIE_FILE" ] && grep -q "youtube.com" "$COOKIE_FILE"
}

cookies_loaded=0
if [ -n "${YTDLP_COOKIES_GZ_B64:-}" ]; then
  mkdir -p "$AUTH_DIR"
  if printf '%s' "$YTDLP_COOKIES_GZ_B64" | base64 -d | gzip -dc > "$COOKIE_FILE" 2>/dev/null && cookie_ok; then
    cookies_loaded=1
  else
    rm -f "$COOKIE_FILE"
    echo "[entrypoint] YTDLP_COOKIES_GZ_B64 no se pudo descomprimir; se ignora."
  fi
fi

if [ "$cookies_loaded" = "0" ] && [ -n "${YTDLP_COOKIES_B64:-}" ]; then
  mkdir -p "$AUTH_DIR"
  if printf '%s' "$YTDLP_COOKIES_B64" | base64 -d > "$COOKIE_FILE" 2>/dev/null && cookie_ok; then
    cookies_loaded=1
  else
    rm -f "$COOKIE_FILE"
    echo "[entrypoint] YTDLP_COOKIES_B64 no se pudo decodificar; se ignora."
  fi
fi

if [ "$cookies_loaded" = "1" ]; then
  if [ -z "${YTDLP_COOKIES:-}" ]; then
    YTDLP_COOKIES="$COOKIE_FILE"
    export YTDLP_COOKIES
  fi
  echo "[entrypoint] cookies de YouTube escritas en $COOKIE_FILE"
fi

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$AUTH_DIR"
  chown -R bot:bot "$AUTH_DIR" 2>/dev/null || true
  [ -f "$COOKIE_FILE" ] && chmod 600 "$COOKIE_FILE" 2>/dev/null || true
  exec gosu bot "$@"
fi

exec "$@"
