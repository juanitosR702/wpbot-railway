#!/usr/bin/env bash
# Ejecutar manualmente en el VPS: sudo bash deploy/bootstrap-vps.sh
set -Eeuo pipefail

DEPLOY_USER="bandelion"
APP_ROOT="/opt/bandelion/apps/bandalandbot"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"

die() { printf 'Error: %s\n' "$*" >&2; exit 1; }

[[ ${EUID} -eq 0 ]] || die "Ejecuta este script con sudo."
[[ -r /etc/os-release ]] || die "No se encontró /etc/os-release."
# shellcheck disable=SC1091
. /etc/os-release
[[ ${ID:-} == "debian" ]] || die "Este bootstrap está limitado a Debian (detectado: ${ID:-desconocido})."
id "$DEPLOY_USER" >/dev/null 2>&1 || die "No existe el usuario ${DEPLOY_USER}."
command -v docker >/dev/null || die "Docker no está instalado."
docker info >/dev/null || die "El daemon de Docker no está disponible."
docker compose version >/dev/null || die "Docker Compose v2 no está disponible."
[[ -f "$SCRIPT_DIR/compose.yml" ]] || die "No se encontró deploy/compose.yml."
[[ -f "$SCRIPT_DIR/deploy-remote.sh" ]] || die "No se encontró deploy/deploy-remote.sh."
[[ -f "$REPO_ROOT/.env.example" ]] || die "No se encontró .env.example."

install -d -m 0755 -o root -g root /opt/bandelion /opt/bandelion/apps "$APP_ROOT"

for environment in prod; do
  app_dir="$APP_ROOT/$environment"
  install -d -m 0750 -o root -g "$DEPLOY_USER" "$app_dir" "$app_dir/scripts" "$app_dir/storage"
  install -d -m 0700 -o 10001 -g 10001 "$app_dir/storage/auth"
  install -d -m 0750 -o root -g "$DEPLOY_USER" "$app_dir/backups"
  install -m 0640 -o root -g "$DEPLOY_USER" "$SCRIPT_DIR/compose.yml" "$app_dir/compose.yml"
  install -m 0640 -o root -g "$DEPLOY_USER" "$REPO_ROOT/.env.example" "$app_dir/.env.example"
done

install -m 0750 -o root -g root "$SCRIPT_DIR/deploy-remote.sh" /usr/local/sbin/deploy-bandalandbot
sudoers_file="/etc/sudoers.d/bandalandbot-deploy"
printf '%s\n' \
  '# Allows only the validated BandalandBot deploy wrapper; it does not grant Docker access.' \
  "${DEPLOY_USER} ALL=(root) NOPASSWD: /usr/local/sbin/deploy-bandalandbot *" \
  > "$sudoers_file"
chmod 0440 "$sudoers_file"
visudo -cf "$sudoers_file"

printf '%s\n' "Bootstrap terminado. No se inició ningún contenedor."
printf '%s\n' "Crea $APP_ROOT/prod/.env desde su .env.example antes del primer despliegue."
