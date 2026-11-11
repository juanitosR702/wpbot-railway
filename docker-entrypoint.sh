#!/bin/sh
# Railway monta el volumen como root; el bot corre como usuario `bot` (uid 10001).
# Ajustamos el dueño de AUTH_DIR y bajamos privilegios antes de arrancar Node.
set -eu

AUTH_DIR="${AUTH_DIR:-/app/bridge/auth}"

if [ "$(id -u)" = "0" ]; then
  mkdir -p "$AUTH_DIR"
  chown -R bot:bot "$AUTH_DIR" 2>/dev/null || true
  exec gosu bot "$@"
fi

exec "$@"
