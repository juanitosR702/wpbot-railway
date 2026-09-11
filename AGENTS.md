# AGENTS.md

## Proyecto
- `bot/` — WhatsApp bot (Baileys v6, ES modules). Entry: `bot/src/index.js` → `app/bootstrap.js`. `bot/index.js` raíz es solo re-export
- `bridge/` — solo `auth/` (credenciales de sesión WhatsApp) + backups `auth_old_*`. Sin FastAPI
- `.env` va en **raíz del repo**; lo lee `shared/config/env.js` desde CWD (`process.env` → `.env` → `../.env`), cacheado al importar
- Persistencia: **MongoDB**, no JSON. `MONGODB_URI` y `MONGODB_DB` son **requeridos** (el bot lanza error si faltan)
- Docker: `Dockerfile` (Node 20-slim + ffmpeg + yt-dlp)

## Comandos
- `cd bot && npm run dev` — entry local. No hay tests/lint/typecheck
- `npm install --legacy-peer-deps` (necesario, no plain install)

## Arquitectura
- **Hexagonal**: `domain/` no importa `infrastructure/` (regla de dependencia). Puertos en `domain/ports/` (`OwnerRepository`, `NsfwAnalyzer`, `AiClient`, `MediaDownloader`, `StateRepository`, `HALT`). `domain/users/ownerPolicy.js` es fábrica pura `createOwnerPolicy(providers)` (inyecta `creatorJids`/`botNumberJids`/`extraProtectedJids`)
- **Composition root**: `app/bootstrap.js` crea `ownerRepository = createOwnerRepository()` (adapter en `infrastructure/users/ownerStorage.js`) y `ownerPolicy = createOwnerPolicy({...})`, y los pasa a los plugins vía `router.registerPlugin(plugin, options)`
- **Router** (`interfaces/bot/router.js`): parsea `!command`, primer handler que devuelva non-null gana. Handler puede devolver `HALT` para consumir el mensaje sin responder (detiene plugins posteriores). `registerPlugin(plugin, options)` pasa deps a `plugin.register(api, options)`
- **Plugins** en `interfaces/commands/<name>/index.js`, registrados en `bootstrap.js`. Reciben deps por `options` (`ownerPolicy`, `ownerRepository`, `{ router }` en bench). Plugins que usan permisos: `moderation`, `groupAdmin`, `antiNsfw` (ownerPolicy), `owner` (ownerPolicy + ownerRepository), `economy` (ownerPolicy), `ai` (ownerRepository para `botNumberJids`)
- **`autoPromote`** (`shared/utils/autoPromote.js`): DI vía `deps = { creatorNumbers, isBotAdmin }`, se pasa desde `bootstrap.js` en `ready`
- Plugins nuevos vs. docs viejas: `minecraft` (wizard `!setserver` que **consume mensajes no-comando** vía `WIZARD_SESSIONS` en memoria), `bench` (`!bench` / `!bench stress`, corre todos los comandos con services mockeados)
- **NSFW** (`infrastructure/nsfw/`): proveedores `disabled` (default) | `local` (HSV via sharp) | `gemini` | `openai` | `nvidia` (Nemotron Content Safety via integrate.api.nvidia.com) | `sightengine` | `nudenet` | `custom` | `openrouter`. Gemini/OpenAI/NVIDIA/OpenRouter caen a `local` ante fallo. Detector con cache en memoria (`NSFW_CACHE_TTL_MS`, default 10min)
- **Song** (`commands/song/`, `infrastructure/youtube/downloader.js`): yt-dlp a mp3, busca por nombre o URL. **Solo HTTPS de YouTube**, tope 15MB, `YTDLP_COOKIES` opcional
- **Stickers** (`infrastructure/stickers/processor.js`): sharp para estáticos (webp), ffmpeg para animados/gif. `fit: contain` + trim + padding transparente, tope 512KB
- **Auth**: `AUTH_PATH = "../../bridge/auth"` se resuelve contra CWD. Local (CWD=`bot/`) → `bridge/auth` del repo; Docker (CWD=`/app/bot`) → `/app/bridge/auth`. Al hacer logout/forbidden borra la carpeta de sesión y pide QR nuevo

## QR (operación crítica)
- No hay QR en terminal. `bootstrap.js` levanta un visor HTTP: `GET /qr?token=<QR_ACCESS_TOKEN>` en `PORT` (default 3000). Token se compara con `timingSafeEqual`; sin token → 503
- `src/index.js` además: duplica console.log/warn a `logs/bot.log`, filtra ruido de sesión de Baileys, y loguea `[monitor]` RAM/CPU cada 10s. View-once (fotos/videos de una vez) se reenvían automáticamente

## Convenciones clave
- Handlers: return string/object (reply) o null (pass). Router captura errores por plugin
- JIDs: `cleanJid()` quita `@server` y `:device`. Usar `sameParticipant()`/`findParticipant()` para comparar (grupos: participant puede ser LID)
- Comandos del creador: `ownerPolicy.isCreatorJid()` + metadata del grupo (`domain/users/ownerPolicy.js`). `CREATOR_NUMBERS`/`BOT_NUMBERS` del .env, con **defaults hardcodeados** si faltan; protegidos extra en colección Mongo `owner` vía `!protected`
- Stores Mongo: `BaseStore` (`infrastructure/database/baseStore.js`) = 1 colección por store, documento único `{_id:"state"}`. `ready()` debe llamarse antes de usar (idempotente y con race-guard). `getDb()` (`infrastructure/database/connection.js`) conecta lazy con race-guard. Metadata de grupos se cachea 60s en `commands/moderation/index.js`
- ES modules; imports con extensión `.js`

## Env vars importantes
- `MONGODB_URI`, `MONGODB_DB` (requeridos), `PREFIX` (default `!`), `CREATOR_NUMBERS`, `BOT_NUMBERS`
- `QR_ACCESS_TOKEN`, `PORT`
- `NSFW_PROVIDER` (default `disabled`), `NSFW_THRESHOLD`, `NSFW_TIMEOUT_MS`, `NSFW_MAX_BYTES`, `NSFW_KICK_THRESHOLD`
- `GEMINI_API_KEY`, `GEMINI_MODEL` (AI y provider NSFW gemini); `OPENROUTER_API_KEY`, `OPENAI_API_KEY`; `SIGHTENGINE_API_USER/SECRET`, `NUDENET_URL`, `NSFW_CUSTOM_URL`
- `YTDLP_PATH` (default `yt-dlp`), `YTDLP_COOKIES`

## Console logs
- `[cmd] <command> (<n> args) — <phone> (<sender>) en grupo "<name>" (<id>)`
- `[anti_nsfw] <group>: <mediaType> → <provider> score=<s> nsfw=<b>`
- `[nsfw] <Provider> falló, usando local:` (Gemini/OpenAI/OpenRouter)
- `[router] Error en <plugin>:`, `[song] Error:`, `[monitor] RAM ... | CPU ... | uptime ...`, `[view-once] Reenviado: <id>`, `[qr] Visor privado activo en el puerto <p>`
