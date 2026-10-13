# AGENTS.md

## Repos (no te equivoques de checkout)
- Railway despliega desde **`C:\Users\Erika\Documents\wpbot-railway`** (remoto `juanitosR702/wpbot-railway.git`, rama `prod`). Solo edita ahí.
- `python/bot_de_discord/bot_de_whatsapp` es OTRO repo (remotos `bot-whatsapp` / `bot-nuevo`) y **no** se despliega. Cambios ahí no llegan a Railway.

## Proyecto
- `bot/` — WhatsApp bot (Baileys v6, ES modules). Entry: `bot/src/index.js` → `app/bootstrap.js`. `bot/index.js` raíz es solo re-export
- `bridge/` — solo `auth/` (sesión Baileys) + backups `auth_old_*`. Sin FastAPI
- `.env` va en **raíz del repo** (no se commitea; solo existe `.env.example` en git); lo lee `shared/config/env.js` desde CWD: `process.env` → `.env` → `../.env`, cacheado al importar
- Persistencia: **MongoDB**, no JSON. `MONGODB_URI` y `MONGODB_DB` son **requeridos** (lanza si faltan)
- Docker: `Dockerfile` (Node 20-slim + ffmpeg + yt-dlp). Sin `railway.json`: Railway autodetecta el Dockerfile

## Comandos
- `cd bot && npm run dev` — entry local
- `npm install --legacy-peer-deps` (necesario, no plain install). Ojo: este npm bloquea deps git (`EALLOWGIT`, ej. `libsignal`), así que un `node_modules` local puede quedar incompleto
- Tests SÍ existen (`bot/test/`, 5 archivos): `cd bot && npm test`. Si el install local quedó incompleto, los tests de stores fallan por `Cannot find package 'mongodb'`; para verificación enfocada corre un archivo: `node --experimental-test-module-mocks --test test/cloudApi.test.js`. No hay lint/typecheck

## Arquitectura
- **Hexagonal**: `domain/` no importa `infrastructure/` (regla de dependencia). Puertos en `domain/ports/` (`OwnerRepository`, `NsfwAnalyzer`, `AiClient`, `MediaDownloader`, `StateRepository`). `HALT` NO es puerto: es el sentinel del router para consumir un mensaje sin responder
- **Composition root**: `app/bootstrap.js` crea `ownerRepository = createOwnerRepository()` (adapter en `infrastructure/users/ownerStorage.js`) y `ownerPolicy = createOwnerPolicy({...})`, y los pasa a los plugins vía `router.registerPlugin(plugin, options)`
- **Router** (`interfaces/bot/router.js`): parsea `!command`, primer handler que devuelva non-null gana. `registerPlugin(plugin, options)` pasa deps a `plugin.register(api, options)`
- **Plugins** en `interfaces/commands/<name>/index.js`, registrados en `bootstrap.js`. Reciben deps por `options` (`ownerPolicy`, `ownerRepository`, `{ router }` en bench). Plugins que usan permisos: `moderation`, `groupAdmin`, `antiNsfw` (ownerPolicy), `owner` (ownerPolicy + ownerRepository), `economy` (ownerPolicy), `ai` (ownerRepository para `botNumberJids`)
- **`autoPromote`** (`shared/utils/autoPromote.js`): DI vía `deps = { creatorNumbers, isBotAdmin }`, se pasa desde `bootstrap.js` en `ready`
- `minecraft` (wizard `!setserver` que **consume mensajes no-comando** vía `WIZARD_SESSIONS` en memoria), `bench` (`!bench` / `!bench stress`, corre todos los comandos con services mockeados)
- **NSFW** (`infrastructure/nsfw/`): proveedores `disabled` (default) | `local` (HSV via sharp) | `gemini` | `openai` | `nvidia` (Nemotron via integrate.api.nvidia.com) | `sightengine` | `nudenet` | `custom` | `openrouter`. Remotos caen a `local` ante fallo. Cache en memoria (`NSFW_CACHE_TTL_MS`, default 10min)
- **Song** (`commands/song/`, `infrastructure/youtube/downloader.js`): yt-dlp a mp3, busca por nombre o URL. **Solo HTTPS de YouTube**, tope 15MB, `YTDLP_COOKIES` opcional
- **Stickers** (`infrastructure/stickers/processor.js`): sharp para estáticos (webp), ffmpeg para animados/gif (`fit: contain` + trim + padding transparente, tope 512KB). `getFfmpegCommand()` verifica con `fs.access(X_OK)` que el binario de `ffmpeg-static` exista —el Dockerfile instala con `--ignore-scripts` y el binario puede no descargarse— y si no, usa el `ffmpeg` del sistema. `exec` con timeout 90s; ante fallo el error SÍ sale en `[stickers]`
- **Auth**: `AUTH_PATH = env("AUTH_DIR", "../bridge/auth")` se resuelve contra CWD. Local (CWD=`bot/`) → `bridge/auth` del repo; Docker (CWD=`/app/bot`) → `/app/bridge/auth`. Al hacer logout/forbidden borra la sesión y pide QR nuevo

## QR y /health (operación crítica)
- No hay QR en terminal. `bootstrap.js` levanta visor HTTP: `GET /qr?token=<QR_ACCESS_TOKEN>` en `PORT` (default 3000). Token con `timingSafeEqual`; sin token → 503, token mal → 404, sin QR activo → 404 con texto
- `GET /health` devuelve 200 siempre (incluso degradado): `ready` solo es `true` con Mongo + WhatsApp conectados. Es lo que se chequea tras escanear
- QR rota (~60s): ante fallo de escaneo, recargar la página
- Baileys normal pre-vinculación: `restartRequired` (515), `unavailableService` (503), `timedOut` (408) con reconnect. No son bugs

## Railway (producción)
- CLI linkeado al proyecto; solo lectura segura: `railway status`, `railway logs --lines N`. Redeploy de lo pusheado: `railway redeploy --from-source -y`. **Nunca imprimas valores de variables** (solo nombres + longitudes)
- Plan free exige flag **serverless** (el bot se duerme); en plan pago va **OFF** (24/7)
- Volumen en `/app/bridge/auth` obligatorio: sin él cada redeploy pierde sesión y pide QR nuevo
- `.env` está en `.dockerignore`: la imagen no lleva secretos, todo sale de Railway Variables
- `Dockerfile` HEALTHCHECK usa `http://127.0.0.1:${PORT:-3000}/health`

## Identidad LID (causa #1 de bugs de permisos)
- En grupos nuevos los participantes vienen como `@lid`, no como teléfono. NUNCA compares por string de teléfono a mano
- Usa siempre `sameParticipant()` / `findParticipant()` (`shared/utils/jid.js`) y el central `ownerPolicy.isBotAdmin()` (resuelve por JID de sesión + LID + `BOT_NUMBERS` + fallback a teléfono). No dupliques la búsqueda en el plugin (ese fue el bug de `kirk`)
- Comandos del creador: `ownerPolicy.isCreatorJid()` + metadata del grupo. `CREATOR_NUMBERS`/`BOT_NUMBERS` del env, con **defaults hardcodeados** si faltan; protegidos extra en colección Mongo `owner` vía `!protected` / `!protegidos`
- Comando de expulsión se llama **`kirk`** (no `kick`): avisa `🚨 @user te han kirkeado.` antes del `remove`. Respeta `isProtectedJid` (creadores, bot, protegidos)

## Convenciones clave
- Handlers: return string/object (reply) o null (pass). Router captura errores por plugin
- `cleanJid()` quita `@server` y `:device`
- Stores Mongo: `BaseStore` (`infrastructure/database/baseStore.js`) = 1 colección por store, documento único `{_id:"state"}`. `ready()` antes de usar (idempotente con race-guard). `getDb()` lazy con race-guard. Metadata de grupos cacheada 60s en `commands/moderation/index.js`
- ES modules; imports con extensión `.js`

## Env vars importantes
- `MONGODB_URI`, `MONGODB_DB` (requeridos), `PREFIX` (default `!`), `CREATOR_NUMBERS`, `BOT_NUMBERS`
- `QR_ACCESS_TOKEN`, `PORT`, `AUTH_DIR` (Docker: `/app/bridge/auth`)
- `NSFW_PROVIDER` (default `disabled`), `NSFW_THRESHOLD`, `NSFW_TIMEOUT_MS`, `NSFW_MAX_BYTES`, `NSFW_KICK_THRESHOLD`
- `GEMINI_API_KEY`, `GEMINI_MODEL` (AI y provider NSFW gemini); `OPENROUTER_API_KEY`, `OPENAI_API_KEY`; `SIGHTENGINE_API_USER/SECRET`, `NUDENET_URL`, `NSFW_CUSTOM_URL`
- `YTDLP_PATH` (default `yt-dlp`), `YTDLP_COOKIES`

## Console logs
- `[cmd] <command> (<n> args) — <phone> (<sender>) en grupo "<name>" (<id>)`
- `[anti_nsfw] <group>: <mediaType> → <provider> score=<s> nsfw=<b>`
- `[nsfw] <Provider> falló, usando local:`, `[stickers] ... outputSize=`, `[stickers] Error creando sticker:`
- `[router] Error en <plugin>:`, `[song] Error:`, `[monitor] RAM ... | CPU ... | uptime ...`, `[view-once] Reenviado: <id>`, `[bot] QR recibido. Disponible en el visor privado.`
- `src/index.js`: duplica console.log/warn a `logs/bot.log` (resuelve `logs/` del CWD con fallback a `/tmp`; Dockerfile pre-crea `/app/bot/logs`), filtra ruido de sesión Baileys, monitor cada 10s. View-once se reenvía automáticamente
