#!/usr/bin/env bash
# Installed by bootstrap-vps.sh as /usr/local/sbin/deploy-bandalandbot.
set -Eeuo pipefail
IFS=$'\n\t'

readonly APP_ROOT="/opt/bandelion/apps/bandalandbot"
readonly REPOSITORY="juanitosR702/bot-nuevo"
readonly HEALTH_TIMEOUT_SECONDS=150

die() { printf 'deploy-bandalandbot: %s\n' "$*" >&2; exit 1; }
usage() {
  cat <<'EOF'
Usage: deploy-bandalandbot --environment production --image bandalandbot:prod-<sha> --commit <sha> --branch prod --source /tmp/bandelion-bandalandbot-XXXXXXXX
EOF
}

if [[ ${1:-} == "--check" && $# -eq 1 ]]; then
  command -v docker >/dev/null || die "Docker no está disponible."
  docker info >/dev/null || die "El daemon de Docker no está disponible."
  docker compose version >/dev/null || die "Docker Compose v2 no está disponible."
  printf '%s\n' "Docker y Docker Compose están disponibles."
  exit 0
fi

if [[ ${1:-} == "--rollback" && ${2:-} == "--environment" && $# -eq 3 ]]; then
  case "${3:-}" in
    production) rollback_dir="$APP_ROOT/prod"; rollback_container="bandalandbot-prod" ;;
    *) die "Entorno no permitido para rollback." ;;
  esac
  [[ -f "$rollback_dir/.env" && -f "$rollback_dir/.rollback.env" && -f "$rollback_dir/compose.yml" ]] || die "No existe una configuración previa para rollback."
  cp --preserve=mode,timestamps "$rollback_dir/.rollback.env" "$rollback_dir/.deployment.env"
  docker compose --env-file "$rollback_dir/.deployment.env" -f "$rollback_dir/compose.yml" config -q
  docker compose --env-file "$rollback_dir/.deployment.env" -f "$rollback_dir/compose.yml" up -d --no-build --remove-orphans
  deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  while (( SECONDS < deadline )); do
    health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$rollback_container")"
    [[ $health == "healthy" ]] && { printf '%s\n' "Rollback completado."; exit 0; }
    [[ $health != "unhealthy" && $health != "none" ]] || die "El rollback no superó el healthcheck ($health)."
    sleep 5
  done
  die "Tiempo agotado esperando el rollback."
fi

environment=""
image=""
commit=""
branch=""
source_dir=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --environment) [[ $# -ge 2 && -z $environment ]] || die "Argumento --environment inválido."; environment="$2"; shift 2 ;;
    --image) [[ $# -ge 2 && -z $image ]] || die "Argumento --image inválido."; image="$2"; shift 2 ;;
    --commit) [[ $# -ge 2 && -z $commit ]] || die "Argumento --commit inválido."; commit="$2"; shift 2 ;;
    --branch) [[ $# -ge 2 && -z $branch ]] || die "Argumento --branch inválido."; branch="$2"; shift 2 ;;
    --source) [[ $# -ge 2 && -z $source_dir ]] || die "Argumento --source inválido."; source_dir="$2"; shift 2 ;;
    --help) [[ $# -eq 1 ]] || die "--help no acepta otros argumentos."; usage; exit 0 ;;
    *) die "Argumento no permitido: $1" ;;
  esac
done

[[ -n $environment && -n $image && -n $commit && -n $branch && -n $source_dir ]] || { usage >&2; exit 2; }
[[ $commit =~ ^[a-f0-9]{7,40}$ ]] || die "Commit inválido."
[[ $source_dir =~ ^/tmp/bandelion-bandalandbot-[A-Za-z0-9]{8}$ && -d $source_dir ]] || die "Directorio temporal inválido."
[[ -f "$source_dir/Dockerfile" && -f "$source_dir/bot/package-lock.json" && -f "$source_dir/deploy/compose.yml" ]] || die "El origen no contiene los archivos de despliegue requeridos."

case "$environment" in
  production)
    app_dir="$APP_ROOT/prod"
    project_name="bandalandbot-prod"
    container_name="bandalandbot-prod"
    image_prefix="prod"
    expected_branch="prod"
    qr_host_port="3000"
    ;;
  *) die "Entorno no permitido." ;;
esac

[[ $branch == "$expected_branch" ]] || die "La rama no corresponde al entorno solicitado."
[[ $image == "bandalandbot:${image_prefix}-${commit}" ]] || die "El nombre o tag de imagen no corresponde al entorno y commit."
[[ -d $app_dir && -f "$app_dir/.env" ]] || die "Falta $app_dir/.env; créalo manualmente desde .env.example."
[[ -f "$app_dir/compose.yml" ]] || die "Falta $app_dir/compose.yml; ejecuta primero bootstrap-vps.sh."
command -v docker >/dev/null || die "Docker no está disponible."
docker info >/dev/null || die "El daemon de Docker no está disponible."
docker compose version >/dev/null || die "Docker Compose v2 no está disponible."

deploy_env="$app_dir/.deployment.env"
backup_dir="$app_dir/backups/$(date -u +%Y%m%dT%H%M%SZ)"
previous_image=""
if docker container inspect "$container_name" >/dev/null 2>&1; then
  previous_image="$(docker container inspect --format '{{.Config.Image}}' "$container_name")"
fi

rollback() {
  local status=$?
  if [[ $status -ne 0 && -n $previous_image ]]; then
    printf '%s\n' "El despliegue falló; restaurando la imagen anterior: $previous_image" >&2
    cat > "$deploy_env" <<EOF
COMPOSE_PROJECT_NAME=$project_name
CONTAINER_NAME=$container_name
IMAGE_TAG=$previous_image
QR_HOST_PORT=$qr_host_port
DEPLOY_ENVIRONMENT=$environment
DEPLOY_REPOSITORY=$REPOSITORY
DEPLOY_COMMIT=rollback-$commit
DEPLOY_BRANCH=$branch
DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TZ=America/Bogota
EOF
    docker compose --env-file "$deploy_env" -f "$app_dir/compose.yml" up -d --no-build --remove-orphans || printf '%s\n' "No se pudo completar el rollback automático." >&2
  fi
  exit "$status"
}
trap rollback EXIT

install -d -m 0750 "$backup_dir"
cp --preserve=mode,timestamps "$app_dir/compose.yml" "$backup_dir/compose.yml"
[[ ! -f $deploy_env ]] || cp --preserve=mode,timestamps "$deploy_env" "$backup_dir/deployment.env"
[[ ! -f $deploy_env ]] || cp --preserve=mode,timestamps "$deploy_env" "$app_dir/.rollback.env"
install -m 0640 "$source_dir/deploy/compose.yml" "$app_dir/compose.yml"

printf '%s\n' "Construyendo $image en el VPS..."
docker build --pull --tag "$image" "$source_dir"
docker tag "$image" "bandalandbot:${image_prefix}-latest"

cat > "$deploy_env" <<EOF
COMPOSE_PROJECT_NAME=$project_name
CONTAINER_NAME=$container_name
IMAGE_TAG=$image
QR_HOST_PORT=$qr_host_port
DEPLOY_ENVIRONMENT=$environment
DEPLOY_REPOSITORY=$REPOSITORY
DEPLOY_COMMIT=$commit
DEPLOY_BRANCH=$branch
DEPLOYED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
TZ=America/Bogota
EOF
chmod 0640 "$deploy_env"

docker compose --env-file "$deploy_env" -f "$app_dir/compose.yml" config -q
docker compose --env-file "$deploy_env" -f "$app_dir/compose.yml" up -d --no-build --remove-orphans

printf '%s\n' "Esperando el healthcheck..."
deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
while (( SECONDS < deadline )); do
  health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$container_name")"
  if [[ $health == "healthy" ]]; then
    printf '%s\n' "Despliegue correcto: $container_name está saludable."
    break
  fi
  if [[ $health == "unhealthy" || $health == "none" ]]; then
    docker compose --env-file "$deploy_env" -f "$app_dir/compose.yml" logs --tail 80 bot >&2
    die "El contenedor no superó el healthcheck (estado: $health)."
  fi
  sleep 5
done
(( SECONDS < deadline )) || die "Tiempo agotado esperando el healthcheck."

# Conserva la imagen activa, la anterior y hasta una imagen adicional por entorno.
mapfile -t images < <(docker image ls --format '{{.Repository}}:{{.Tag}}' --filter "reference=bandalandbot:${image_prefix}-*" | grep -E "^bandalandbot:${image_prefix}-[a-f0-9]{7,40}$" | while read -r tag; do printf '%s %s\n' "$(docker image inspect --format '{{.Created}}' "$tag")" "$tag"; done | sort -r)
kept=0
for entry in "${images[@]}"; do
  tag="${entry#* }"
  if [[ $tag == "$image" || $tag == "$previous_image" || $kept -lt 3 ]]; then
    ((kept += 1))
    continue
  fi
  if ! docker image rm "$tag"; then
    printf '%s\n' "No se eliminó la imagen antigua en uso: $tag" >&2
  fi
done

trap - EXIT
