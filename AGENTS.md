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
- **Router** (`interfaces/bot/router.js`): parsea `!command`, primer handler que devuelva non-null gana. `registerPlugin(plugin, options)` pasa deps a `plugin.register(api, options)`. El contexto incluye `args` (normalizados) y `commandBody` (texto original tras el comando, con espacios y saltos de línea intactos; lo usan `setwelcome`/`setbye`)
- **Bienvenida/despedida** (`groupAdmin` + `shared/utils/welcomeTemplate.js`): variables `@user`/`{user}` (etiqueta), `{group}` (nombre del grupo) y `{count}`/`{total}` (participantes). Se renderizan al enviar, no al configurar. Solo `add`/`remove` disparan el mensaje; `promote`/`demote` se ignoran
- **Plugins** en `interfaces/commands/<name>/index.js`, registrados en `bootstrap.js`. Reciben deps por `options` (`ownerPolicy`, `ownerRepository`, `{ router }` en bench). Plugins que usan permisos: `moderation`, `groupAdmin`, `antiNsfw` (ownerPolicy), `owner` (ownerPolicy + ownerRepository), `economy` (ownerPolicy), `ai` (ownerRepository para `botNumberJids`)
- **`autoPromote`** (`shared/utils/autoPromote.js`): DI vía `deps = { creatorNumbers, isBotAdmin }`, se pasa desde `bootstrap.js` en `ready`
- `minecraft` (wizard `!setserver` que **consume mensajes no-comando** vía `WIZARD_SESSIONS` en memoria), `bench` (`!bench` / `!bench stress`, corre todos los comandos con services mockeados)
- **NSFW** (`infrastructure/nsfw/`): proveedores `disabled` (default) | `local` (HSV via sharp) | `gemini` | `openai` | `nvidia` (Nemotron via integrate.api.nvidia.com) | `sightengine` | `nudenet` | `custom` | `openrouter`. Remotos caen a `local` ante fallo. Cache en memoria (`NSFW_CACHE_TTL_MS`, default 10min)
- **Song** (`commands/song/`, `infrastructure/youtube/downloader.js`): yt-dlp a mp3, busca por nombre o URL. **Solo HTTPS de YouTube**, tope 15MB, `YTDLP_COOKIES` opcional
- **Stickers** (`infrastructure/stickers/processor.js`): sharp para estáticos (webp), ffmpeg para animados/gif (`fit: contain` + trim + padding transparente, tope 512KB). `getFfmpegCommand()` verifica con `fs.access(X_OK)` que el binario de `ffmpeg-static` exista —el Dockerfile instala con `--ignore-scripts` y el binario puede no descargarse— y si no, usa el `ffmpeg` del sistema. `exec` con timeout 90s; ante fallo el error SÍ sale en `[stickers]`
- **Auth**: `AUTH_PATH = env("AUTH_DIR", "../bridge/auth")` se resuelve contra CWD. Local (CWD=`bot/`) → `bridge/auth` del repo; Docker (CWD=`/app/bot`) → `/app/bridge/auth`. Al hacer logout/forbidden borra la sesión y pide QR nuevo

## QR y /health (operación crítica)
- No hay QR en terminal. `bootstrap.js` levanta el visor HTTP en `PORT` (default 3000). Todo exige `QR_ACCESS_TOKEN` y se compara con `timingSafeEqual`; sin token → 503, token mal → 404:
  - `GET /` o `/qr?token=...` → visor HTML (`interfaces/web/qrPage.js`), refresca solo cada 3 s y muestra QR, estado y antigüedad del código
  - `GET /qr.png?token=...` → PNG crudo (sin QR activo → 404 con texto)
  - `GET /qr/status?token=...` → JSON `{active, connected, qrUpdatedAt, qrAgeSeconds, uptimeSeconds}` que consume el visor
- Origen del QR: Baileys `connection.update` (campo `qr`) → `Connection` emite `"qr"` → `bootstrap.js` guarda `currentQr`/`currentQrAt`. Al `ready` se limpia para no mostrar un código ya usado.
- `GET /health` devuelve 200 siempre (incluso degradado): `ready` solo es `true` con Mongo + WhatsApp conectados. Es lo que se chequea tras escanear
- QR rota (~60s): ante fallo de escaneo, recargar la página
- Baileys normal pre-vinculación: `restartRequired` (515), `unavailableService` (503), `timedOut` (408) con reconnect. No son bugs

## Railway (producción)
- CLI linkeado al proyecto; solo lectura segura: `railway status`, `railway logs --lines N`. **Nunca imprimas valores de variables** (solo nombres + longitudes)
- El servicio **no** tiene source de GitHub: `git push` NO despliega. Código nuevo → `railway up -c -m "..."` (rebuild Docker, ~5 min). Cambios solo de variables → `railway redeploy -y` (reusa la imagen)
- Plan free exige flag **serverless** (el bot se duerme); en plan pago va **OFF** (24/7)
- Volumen en `/app/bridge/auth` obligatorio: sin él cada redeploy pierde sesión y pide QR nuevo
- Railway monta el volumen como **root** y el bot corre como uid 10001 (`bot`): sin ajuste, Baileys falla al guardar `creds.json` con `EACCES`. Por eso `docker-entrypoint.sh` arranca como root, hace `chown -R bot:bot "$AUTH_DIR"` y baja privilegios con `gosu bot`. No pongas `USER bot` antes del ENTRYPOINT ni borres `gosu` del `apt-get install`
- `.env` está en `.dockerignore`: la imagen no lleva secretos, todo sale de Railway Variables
- `Dockerfile` HEALTHCHECK usa `http://127.0.0.1:${PORT:-3000}/health`

## Identidad LID (causa #1 de bugs de permisos)
- En grupos nuevos los participantes vienen como `@lid`, no como teléfono. NUNCA compares por string de teléfono a mano
- Usa siempre `sameParticipant()` / `findParticipant()` (`shared/utils/jid.js`) y el central `ownerPolicy.isBotAdmin()` (resuelve por JID de sesión + LID + `BOT_NUMBERS` + fallback a teléfono). No dupliques la búsqueda en el plugin (ese fue el bug de `kirk`)
- Comandos del creador: `ownerPolicy.isCreatorJid()` + metadata del grupo. `CREATOR_NUMBERS`/`BOT_NUMBERS` del env, con **defaults hardcodeados** si faltan; protegidos extra en colección Mongo `owner` vía `!protected` / `!protegidos`
- Comandos de expulsión: **`kick`** es el normal (solo texto, admin + bot admin, respeta `isProtectedJid`). **`kirk`** sigue existiendo como **easter egg** por escribir mal `kick`: manda la foto de `assets/kirkeado.*` y **no aparece en el menú ni en el catálogo de la IA** (se quita de `meta.commands` al registrarlo). `kirkrandom` conserva la foto

## Convenciones clave
- Handlers: return string/object (reply) o null (pass). Router captura errores por plugin
- `cleanJid()` quita `@server` y `:device`
- Stores Mongo: `BaseStore` (`infrastructure/database/baseStore.js`) = 1 colección por store, documento único `{_id:"state"}`. `ready()` antes de usar (idempotente con race-guard). `getDb()` lazy con race-guard. Metadata de grupos cacheada 60s en `commands/moderation/index.js`
- ES modules; imports con extensión `.js`

## Env vars importantes
- `MONGODB_URI`, `MONGODB_DB` (requeridos), `PREFIX` (default `!`), `CREATOR_NUMBERS`, `BOT_NUMBERS`
- `QR_ACCESS_TOKEN`, `PORT`, `AUTH_DIR` (Docker: `/app/bridge/auth`)
- `NSFW_PROVIDER` (default `disabled`), `NSFW_THRESHOLD`, `NSFW_TIMEOUT_MS`, `NSFW_MAX_BYTES`, `NSFW_KICK_THRESHOLD`
- `GEMINI_API_KEY`, `GEMINI_MODEL` (default `gemini-3.5-flash`; AI y provider NSFW gemini); `OPENROUTER_API_KEY`, `OPENAI_API_KEY`; `SIGHTENGINE_API_USER/SECRET`, `NUDENET_URL`, `NSFW_CUSTOM_URL`
- `AI_PROVIDER` (`gemini`/`openai`), `AI_SYSTEM_PROMPT` (sobrescribe el prompt por defecto), `AI_COMMAND_CONFIRM_MS` (TTL de confirmación, default 90000)
- `YTDLP_PATH` (default `yt-dlp`), `YTDLP_COOKIES`

## IA con ejecución de comandos
- El plugin `ai` responde con el comando explícito `!ai` / `!ia` / `!ask` **y cuando mencionan al bot con `@` en el texto** (`contextInfo.mentionedJid` + token `@<numero>`). Responder a un mensaje del bot **no** lo activa: solo alimenta el historial (`buscar_persona`) y las confirmaciones. Puede **ejecutar comandos reales** en lenguaje natural. No inventa lógica: `commandRunner.js` reinyecta un mensaje sintético con `__aiSynthetic` en el `Router`, así que aplican todas las validaciones existentes (admin, bot admin, protegidos, creador, etc.). El handler de IA ignora esos mensajes para no recursar.
- Catálogo (`commandCatalog.js`): se construye **lazy** desde `Router.getCommands()` en el primer uso y añade descripción/nivel/palabras clave. `bench` está excluido. Coste por mención: índice compacto (~300 tokens) + 4 herramientas (`buscar_comandos`, `ver_comando`, `buscar_persona`, `ejecutar_comando`); el detalle se pide bajo demanda.
- Niveles por comando: `user` / `admin` / `creator` (por defecto `user`). Pre-chequeo en el runner + validación del plugin original.
- Comandos destructivos piden confirmación (`sí`/`no`, TTL `AI_COMMAND_CONFIRM_MS`, default 90 s). Confirma el mismo remitente o un admin/creador que mencione al bot. Al construir el mensaje sintético se quita al bot de `mentionedJid` para que `targetJid` no lo elija como objetivo.
- `buscar_persona` usa `AiStore.recentMessages` (nombre + JID); si hay ambigüedad el modelo pregunta.
- Si Google retira el modelo configurado o el nuevo está saturado (`503 UNAVAILABLE` / "high demand"), `geminiClient._generate` reintenta hasta 3 intentos: primero con el reemplazo que sugiere el propio error (`use models/...`), luego con la lista `FALLBACK_MODELS` (`gemini-3.5-flash`, `3.8`, `3.7`, `3.6`). El que funciona se recuerda en memoria (`config.model`) y queda el log `[ai] Modelo "<x>" no disponible (...); probando "<y>".`
- Gemini 3 exige reenviar el `thoughtSignature` de cada `functionCall` en el siguiente turno. `chatWithTools` lo devuelve en `functionCall.thoughtSignature` y `toGeminiTurn` lo vuelve a poner en la part. Sin eso la API responde "Function call is missing a thought_signature in functionCall parts".

## Control por grupo (apagado y módulos)
- `group_settings` (`GroupSettingsStore`, singleton `getGroupSettingsStore()`): por grupo `{ botEnabled, disabledModules[] }`.
- `!bot on|off` (admin) apaga el bot **entero** en ese grupo: no responde a nada, ni comandos ni IA, y tampoco manda bienvenidas/despedidas.
- `!modulo on|off <modulo>` (admin) desactiva plugins concretos: `economia`, `casino`, `niveles`, `stickers`, `tiktok`, `ia`, `moderacion`, `antinsfw`, `encuestas`, `musica`, `imagen`, `minecraft`, `utilidades`, `ayuda`, `administracion`. Acepta clave, nombre de plugin o etiqueta (`economia`/`economy`/`Economía`).
- `!modulos` manda un **menú numerado con ✅/❌** (módulos + `Bienvenidas y despedidas`). El usuario responde **citando ese mensaje** con los números (`2` o `2 5`) y se alternan; también `!modulo 2`. Solo se aceptan respuestas que citen el mensaje del menú (guardado en memoria con TTL 10 min) para que un número suelto en el chat no cambie nada.
- `Router.setGroupGate(fn)` se inyecta en `bootstrap.js`: `null` = sin restricciones, `{ disabled }` = apagado total, `{ allows(plugin) }` filtra handlers por `meta.plugin`. `GROUP_CONFIG_COMMANDS` (`!bot`, `!modulo`, `!modulos`) siempre pasan para poder reactivar aunque el bot esté apagado.


## Console logs
- `[cmd] <command> (<n> args) — <phone> (<sender>) en grupo "<name>" (<id>)`
- `[anti_nsfw] <group>: <mediaType> → <provider> score=<s> nsfw=<b>`
- `[nsfw] <Provider> falló, usando local:`, `[stickers] ... outputSize=`, `[stickers] Error creando sticker:`
- `[router] Error en <plugin>:`, `[song] Error:`, `[monitor] RAM ... | CPU ... | uptime ...`, `[view-once] Reenviado: <id>`, `[bot] QR recibido. Disponible en el visor privado.`
- `src/index.js`: duplica console.log/warn a `logs/bot.log` (resuelve `logs/` del CWD con fallback a `/tmp`; Dockerfile pre-crea `/app/bot/logs`), filtra ruido de sesión Baileys, monitor cada 10s. View-once se reenvía automáticamente
