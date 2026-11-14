#!/bin/sh
# Railway monta el volumen como root; el bot corre como usuario `bot` (uid 10001).
# Ajustamos el dueño de AUTH_DIR y bajamos privilegios antes de arrancar Node.
set -eu

AUTH_DIR="${AUTH_DIR:-/app/bridge/auth}"

# Cookies de YouTube para yt-dlp: se aceptan en base64 en una variable para no
# subir el archivo a mano en cada despliegue. Se escriben en el volumen y, si no
# hay YTDLP_COOKIES explícito, yt-dlp apunta a esa ruta.
if [ -n "${YTDLP_COOKIES_B64:-}" ]; then
  mkdir -p "$AUTH_DIR"
  if printf '%s' "$YTDLP_COOKIES_B64" | base64 -d > "$AUTH_DIR/cookies.txt" 2>/dev/null && [ -s "$AUTH_DIR/cookies.txt" ]; then
    if [ -z "${YTDLP_COOKIES:-}" ]; then
      YTDLP_COOKIES="$AUTH_DIR/cookies.txt"
      export YTDLP_COOKIES
    fi
    echo "[entrypoint] cookies de YouTube escritas en $AUTH_DIR/cookies.txt"
  else
    rm -f "$AUTH_DIR/cookies.txt"
    echo "[entrypoint] YTDLP_COOKIES_B64 no se pudo decodificar; se ignora."
  fi
fi

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$AUTH_DIR"
  chown -R bot:bot "$AUTH_DIR" 2>/dev/null || true
  [ -f "$AUTH_DIR/cookies.txt" ] && chmod 600 "$AUTH_DIR/cookies.txt" 2>/dev/null || true
  exec gosu bot "$@"
fi

exec "$@"
