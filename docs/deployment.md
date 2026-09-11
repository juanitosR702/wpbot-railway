# Despliegue de BandalandBot en Bandelion Enterprise

## Arquitectura

El bot se ejecuta como un solo contenedor Node 20 en el Docker Engine que ya usa Portainer. La imagen incluye `ffmpeg`, `yt-dlp` fijado en `2025.02.19`, `tini` y `curl`; no incluye secretos, la sesión de WhatsApp ni `node_modules` del host.

El código usa MongoDB obligatoriamente para los estados de plugins (economía, moderación, IA, niveles y propietario). No escribe estados JSON persistentes: los únicos archivos locales de ejecución son la sesión multifichero de Baileys y temporales en `/tmp` para FFmpeg/stickers. Por ello sólo se monta de forma persistente `storage/auth`. No se ejecuta MongoDB local; configure un `MONGODB_URI` externo, normalmente `mongodb+srv://...`.

La aplicación usa `AUTH_DIR`; en contenedor vale `/app/bridge/auth` y se monta desde `storage/auth`. Sin ese override, la ruta local por defecto es `../bridge/auth` desde `bot/`. Esto corrige la ruta relativa que no coincidía con el Dockerfile anterior.

El servicio HTTP interno ofrece:

- `GET /health`: proceso, ping real de MongoDB, estado de WhatsApp, uptime y timestamp. Devuelve 200 si el proceso y MongoDB funcionan; `ready` sólo es `true` cuando WhatsApp también está conectado. Así el primer despliegue puede quedar saludable mientras se escanea el QR.
- `GET /qr?token=...`: PNG del QR, protegido por `QR_ACCESS_TOKEN`.

Compose publica el puerto exclusivamente en `127.0.0.1:3000`. No se abre al Internet ni se modifica SSH.

Se eligió construir en el VPS. La inspección encontró 273 paquetes bloqueados, `sharp` con binario precompilado, FFmpeg/yt-dlp, y ninguna dependencia de Chromium, Puppeteer o Python. El build sigue pudiendo consumir CPU durante `npm ci`; el contenedor queda limitado a `0.75` CPU y `1 GiB`. Si el VPS empieza a alojar cargas sensibles a build, la alternativa es trasladar el mismo `docker build` a GHCR y cambiar el wrapper para hacer `pull`; no es necesaria hoy.

## Entornos y persistencia

| Rama | Directorio | Compose | Contenedor | Puerto local |
|---|---|---|---|---|
| `prod` | `/opt/bandelion/apps/bandalandbot/prod` | `bandalandbot-prod` | `bandalandbot-prod` | 3000 |

Producción tiene su propio `.env`, `storage/auth` y tags `prod-<sha>`. La sesión nunca se comparte ni se incorpora en la imagen.

Portainer detecta los contenedores normales del mismo Docker Engine. Las labels identifican servicio, entorno, repositorio, commit, rama y hora de despliegue.

## Preparación única del VPS

Ejecuta estos pasos una vez mediante Tailscale, con un checkout temporal de una revisión confiable. No ejecute el bootstrap desde una URL no revisada.

```bash
ssh bandelion@100.93.232.29
git clone <URL-DEL-REPOSITORIO> /tmp/bandalandbot-bootstrap
cd /tmp/bandalandbot-bootstrap
sudo bash deploy/bootstrap-vps.sh
rm -rf /tmp/bandalandbot-bootstrap
```

El script valida Debian y Docker/Compose, crea los directorios sin borrar datos, instala `/usr/local/sbin/deploy-bandalandbot` y valida con `visudo` este permiso restringido:

```text
bandelion ALL=(root) NOPASSWD: /usr/local/sbin/deploy-bandalandbot *
```

No añade al usuario al grupo `docker`, no instala Tailscale, no toca SSH y no arranca el bot.

Después crea el archivo de secretos sólo en el VPS:

```bash
sudoedit /opt/bandelion/apps/bandalandbot/prod/.env
```

Usa los `.env.example` adyacentes como plantilla. Da permisos restrictivos:

```bash
sudo chown root:bandelion /opt/bandelion/apps/bandalandbot/prod/.env
sudo chmod 640 /opt/bandelion/apps/bandalandbot/prod/.env
```

Verifica que MongoDB permita la IP/red del VPS.

## Variables de aplicación

Las variables completas y reales están documentadas en [`.env.example`](../.env.example). Obligatorio en producción: `MONGODB_URI`, `CREATOR_NUMBERS`, `BOT_NUMBERS` y `QR_ACCESS_TOKEN`; `MONGODB_DB` tiene default `bot_whatsapp`. `GEMINI_API_KEY` sólo es obligatorio si `AI_PROVIDER=gemini`; `OPENAI_API_KEY` sólo si se escoge OpenAI. `NSFW_PROVIDER` acepta `disabled`, `local`, `gemini`, `openrouter`, `openai`, `sightengine`, `nudenet` o `custom`; cada proveedor remoto necesita sus variables listadas en la plantilla.

`AUTH_DIR` debe continuar como `/app/bridge/auth`. `YTDLP_PATH=yt-dlp` coincide con el binario incluido. `YTDLP_COOKIES` es opcional y requiere un override privado que monte el archivo dentro del contenedor; no añadas cookies al repositorio ni al YAML versionado.

`QR_ACCESS_TOKEN`, URI de Mongo y claves de IA son secretos. Nunca los pongas en Actions, etiquetas, imágenes, logs ni commits. El workflow no copia ni reemplaza `.env`.

## GitHub Actions y Tailscale

Configura estas **Repository variables**:

```text
REMOTE_HOST=100.93.232.29
REMOTE_USER=bandelion
REMOTE_APP_ROOT=/opt/bandelion/apps/bandalandbot
```

Configura estos **Repository secrets**:

```text
SSH_PRIVATE_KEY=<clave privada del usuario bandelion, exclusiva para despliegue>
TS_OAUTH_CLIENT_ID=<OAuth client ID de Tailscale>
TS_OAUTH_SECRET=<OAuth client secret de Tailscale>
```

El workflow usa `tailscale/github-action@v3` con una máquina efímera etiquetada `tag:github-actions`. Crea el OAuth client de Tailscale con permiso de autenticar esa etiqueta y una ACL/grant que permita a `tag:github-actions` llegar por SSH al nodo `100.93.232.29` (puerto 22). No se necesita `TS_AUDIENCE` para esta acción; no lo configures salvo que tu propia política de Tailscale lo requiera. Mantén el host como IP de Tailscale, nunca una IP pública.

En cada push a `prod` (o desde **Run workflow** sobre esa rama), Actions crea un staging privado, transfiere un tar sin `.env`, sesiones, datos ni `node_modules`, y llama al wrapper restringido. El wrapper valida todos los argumentos, construye y etiqueta `bandalandbot:prod-<sha>`, ejecuta `compose config`, actualiza sin volúmenes, espera el healthcheck y conserva la imagen previa. El directorio temporal se elimina incluso si falla el workflow.

## Primer despliegue y QR

Haz push de cada rama después de preparar su `.env`, o ejecuta manualmente el workflow. Para confirmar:

```bash
ssh bandelion@100.93.232.29 'curl --fail http://127.0.0.1:3000/health'
```

Para escanear el QR de producción desde tu equipo, crea un túnel Tailscale/SSH y abre el URL local resultante. Sustituye el token sin compartirlo:

```bash
ssh -N -L 3000:127.0.0.1:3000 bandelion@100.93.232.29
# Navegador local: http://127.0.0.1:3000/qr?token=<QR_ACCESS_TOKEN_DE_PROD>
```

Tras vincularlo, confirma que `/health` devuelve `"whatsapp":"connected"` y `"ready":true`.

## Operación, rollback y backup

En un usuario que tenga el sudo administrativo habitual, los comandos útiles son:

```bash
sudo docker logs --tail 100 -f bandalandbot-prod
sudo docker inspect --format '{{.State.Health.Status}}' bandalandbot-prod
sudo docker restart bandalandbot-prod
sudo /usr/local/sbin/deploy-bandalandbot --rollback --environment production
sudo docker image ls 'bandalandbot:*'
```

El rollback automático se ejecuta si el nuevo contenedor falla. El rollback manual usa `.rollback.env`, que guarda el tag conocido anterior y nunca contiene secretos. También puedes volver a ejecutar el workflow sobre el commit anterior. Los datos de MongoDB y `storage/auth` nunca se eliminan por un deploy o rollback.

Haz una copia cifrada y fuera del VPS de la sesión cuando el bot esté detenido para evitar una copia inconsistente:

```bash
sudo docker stop bandalandbot-prod
sudo tar -C /opt/bandelion/apps/bandalandbot/prod/storage -czf /opt/bandelion/backups/bandalandbot-prod-auth-$(date +%F).tar.gz auth
sudo docker start bandalandbot-prod
```

Para restaurar, detén el contenedor, guarda la carpeta `auth` actual como respaldo, extrae el archivo en `storage/` con propietario `10001:10001`, y vuelve a iniciarlo. Una restauración de sesión no reemplaza MongoDB; respalda MongoDB según tu proveedor.

El wrapper retiene de forma segura la imagen activa, la previa y una adicional por entorno. No uses `docker system prune --volumes`, `docker compose down -v`, ni borres `storage/auth`; esos comandos pueden perder la sesión o volúmenes ajenos. Para limpieza manual de una imagen concreta y no usada, valida primero su tag y usa `sudo docker image rm bandalandbot:prod-<sha>`.
