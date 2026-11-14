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
- **NSFW** (`infrastructure/nsfw/`): proveedores `disabled` (default) | `local` (HSV via sharp) | `gemini` | `openai` | `nvidia` (Llama Guard 4 multimodal via integrate.api.nvidia.com; cadena `meta/llama-guard-4-12b` → `nvidia/nemotron-3.5-content-safety`, descarta el modelo que responda 404/400 y cae a local) | `sightengine` | `nudenet` | `custom` | `openrouter`. Remotos caen a `local` ante fallo. Cache en memoria (`NSFW_CACHE_TTL_MS`, default 10min)
- **Song** (`commands/song/`, `infrastructure/youtube/downloader.js`): yt-dlp a mp3, busca por nombre o URL. Enlaces directos: **solo HTTPS de YouTube**; tope 15MB. Si YouTube responde `Sign in to confirm you're not a bot` (IP de datacenter), reintenta con otros `player_client` (`tv_simply,web_embedded`, `android_vr`) antes de propagar el error; la solución real es `YTDLP_COOKIES_B64` (base64 de un `cookies.txt`), que `docker-entrypoint.sh` decodifica a `$AUTH_DIR/cookies.txt` y exporta como `YTDLP_COOKIES`. **SoundCloud no sirve de respaldo**: sin sesión solo da 30 s de muestra y hay DRM. `isBotCheck()`/`extractorVariants()` son puras y están testeadas en `songFallback.test.js`. Ajustes por variables: `YTDLP_COOKIES`, `YTDLP_PROXY`, `YTDLP_EXTRACTOR_ARGS`, `YTDLP_JS_RUNTIMES`, `YTDLP_EXTRA_ARGS`. El Dockerfile instala la **última** release de yt-dlp (fijable con `--build-arg YTDLP_VERSION=...`) y **Deno** (runtime JS que YouTube exige; sin él se pierden formatos). Los errores de yt-dlp se traducen con `describeYtDlpError()`
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
- Cadena de respaldo de la IA: `OPENROUTER_API_KEY` + `OPENROUTER_MODEL` (default `openrouter/auto`) y `NVIDIA_API_KEY` (si falta se reutiliza `NSFW_NVIDIA_API_KEY`) + `NVIDIA_MODEL` (default `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning`). `AI_FALLBACK_TIMEOUT_MS` (default 60000) es el timeout de los tramos OpenAI-compatibles
- `YTDLP_PATH` (default `yt-dlp`), `YTDLP_COOKIES`, `YTDLP_PROXY`, `YTDLP_EXTRACTOR_ARGS`, `YTDLP_JS_RUNTIMES`, `YTDLP_EXTRA_ARGS`
- Lobby: `LOBBY_POLL_MS` (default 60000) = cada cuánto se repasan las solicitudes de entrada pendientes

## IA con ejecución de comandos
- El plugin `ai` responde con el comando explícito `!ai` / `!ia` / `!ask` **y cuando mencionan al bot con `@` en el texto** (`contextInfo.mentionedJid` + token `@<numero>`). Responder a un mensaje del bot **no** lo activa: solo alimenta el historial (`buscar_persona`) y las confirmaciones. Puede **ejecutar comandos reales** en lenguaje natural. No inventa lógica: `commandRunner.js` reinyecta un mensaje sintético con `__aiSynthetic` en el `Router`, así que aplican todas las validaciones existentes (admin, bot admin, protegidos, creador, etc.). El handler de IA ignora esos mensajes para no recursar.
- Catálogo (`commandCatalog.js`): se construye **lazy** desde `Router.getCommands()` en el primer uso y añade descripción/nivel/palabras clave. `bench` está excluido. Coste por mención: índice compacto (~300 tokens) + 4 herramientas (`buscar_comandos`, `ver_comando`, `buscar_persona`, `ejecutar_comando`); el detalle se pide bajo demanda.
- Niveles por comando: `user` / `admin` / `creator` (por defecto `user`). Pre-chequeo en el runner + validación del plugin original.
- Comandos destructivos piden confirmación (`sí`/`no`, TTL `AI_COMMAND_CONFIRM_MS`, default 90 s). Confirma el mismo remitente o un admin/creador que mencione al bot. Al construir el mensaje sintético se quita al bot de `mentionedJid` para que `targetJid` no lo elija como objetivo.
- `buscar_persona` usa `AiStore.recentMessages` (nombre + JID); si hay ambigüedad el modelo pregunta.
- Si Google retira el modelo configurado, lo satura (`503 UNAVAILABLE` / "high demand") o agota su cuota diaria (`429 RESOURCE_EXHAUSTED`, la cuota gratuita es **por modelo**), `geminiClient._generate` prueba hasta 3 modelos: el reemplazo que sugiere el propio error (`use models/...`), el configurado y la lista `FALLBACK_MODELS` (`gemini-3.5-flash`, `gemini-3.1-flash-lite`, `3.8`, `3.7`, `3.6`). Un modelo retirado queda inválido en memoria (se adopta el sugerido como principal); uno sin cuota queda en cuarentena hasta el `Please retry in ...` que informa la API (1h por defecto). El principal no cambia por un 503 puntual: el respaldo es solo para esa petición. Logs `[ai] Cuota agotada para "<x>"; probando otro modelo.` / `[ai] Modelo "<x>" no disponible (...)`. `chat()/chatWithTools()` devuelven el modelo realmente usado en `result.model`.
- Gemini 3 exige reenviar el `thoughtSignature` de cada `functionCall` en el siguiente turno. `chatWithTools` lo devuelve en `functionCall.thoughtSignature` y `toGeminiTurn` lo vuelve a poner en la part. Sin eso la API responde "Function call is missing a thought_signature in functionCall parts".
- **Cadena de proveedores** (`createAiClient.js` + `fallbackClient.js`): Gemini (principal) → OpenRouter → NVIDIA. Los tramos sin clave se omiten, así que con solo `GEMINI_API_KEY` nada cambia; `AI_PROVIDER=openai` conserva el cliente único antiguo. `FallbackClient` prueba en orden cuando un proveedor falla por cuota/clave/saturación/red, devuelve `provider` + `model` reales y pone en cuarentena 10 min al que falla por `401/402/403/429` o mensaje de cuota/clave (`[ai] Proveedor "<x>" fallo (...); probando el siguiente.`). `chatWithTools` solo considera tramos con `supportsTools`; si todos fallan con `unsupported`, el plugin reintenta con `chat()` simple. `!aistatus` lista la cadena con ✅/❌/⏳.
- NVIDIA verificado con function calling (2 rondas) en `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` (~2 s) y `meta/llama-3.2-90b-vision-instruct` (~66 s, solo como alternativa manual). Los modelos `llama-3.1-70b`, `nemotron-super`, `kimi-k2.6`, `mistral-large-2` devuelven 404/410 con la clave actual.

## Control por grupo (apagado y módulos)
- `group_settings` (`GroupSettingsStore`, singleton `getGroupSettingsStore()`): por grupo `{ botEnabled, disabledModules[] }`.
- `!bot on|off` (admin) apaga el bot **entero** en ese grupo: no responde a nada, ni comandos ni IA, y tampoco manda bienvenidas/despedidas.
- `!modulo on|off <modulo>` (admin) desactiva plugins concretos: `economia`, `casino`, `niveles`, `stickers`, `tiktok`, `ia`, `moderacion`, `antinsfw`, `encuestas`, `musica`, `imagen`, `minecraft`, `utilidades`, `ayuda`, `administracion`, `fichas`, `lobby`. Acepta clave, nombre de plugin o etiqueta (`economia`/`economy`/`Economía`).
- `!modulos` manda un **menú numerado con ✅/❌** (módulos + `Bienvenidas y despedidas`). El usuario responde **citando ese mensaje** con los números (`2` o `2 5`) y se alternan; también `!modulo 2`. Solo se aceptan respuestas que citen el mensaje del menú (guardado en memoria con TTL 10 min) para que un número suelto en el chat no cambie nada.
- `Router.setGroupGate(fn)` se inyecta en `bootstrap.js`: `null` = sin restricciones, `{ disabled }` = apagado total, `{ allows(plugin) }` filtra handlers por `meta.plugin`. `GROUP_CONFIG_COMMANDS` (`!bot`, `!modulo`, `!modulos`) siempre pasan para poder reactivar aunque el bot esté apagado.


## Fichas de ingreso (plugin `fichas`)
- Comandos: `!ficha` (cualquier miembro del grupo), `!setficha [dragon|ver|reset]` y `!fichadestino [ver|off|JID]` (admin del grupo o creador).
- La ficha se configura **por grupo** en Mongo (`ficha_settings`, `FichaStore`): `forms[<jid>] = { header, footer, fields[] }`. Sin ficha propia se usa `DEFAULT_FICHA` (genérica, sin marca de ningún clan).
- `!setficha dragon` instala el preset `FICHA_PRESETS.dragon` (ficha GHOST DRAGONS exacta que pidió el usuario) y luego se puede editar.
- Formato de campos (asistente de 3 pasos: encabezado → campos → pie):
  - `# SECCION` → título de sección
  - `Campo | op1, op2` → **desplegable** (máx. 9 opciones, porque WhatsApp permite 10 filas y una se reserva)
  - `Campo` → texto libre (máx. 400 caracteres)
- `!fichadestino` se ejecuta **en el grupo almacén**: guarda ese JID como destino global (`destination`). Acepta un JID explícito, `ver` y `off`. El envío de la ficha terminada va **directo** a ese grupo con `services.sendMessage` (sin aprobación de admins).
- Sesiones de llenado en memoria (`Map`, TTL 20 min), clave `usuario:grupo`; se guardan bajo **todas** las variantes del remitente (`participant`, `participantPn`, `participantLid`, `participantAlt`) porque WhatsApp alterna entre teléfono y LID y la ficha se quedaba muda a mitad. Se pierden al reiniciar a propósito. Al final hay vista previa con Enviar / Corregir campo / Cancelar (acepta también `1`/`2`/`3`).
- Cada paso pregunta **solo el campo actual**; los campos con opciones llevan su desplegable. WhatsApp solo permite un desplegable por mensaje (un formulario completo en un único mensaje exigiría WhatsApp Flows/Business API).
- **Listas desplegables**: Baileys v6 NO acepta `sections` en `sendMessage` (lo trata como media y lanza "Invalid media type"). `infrastructure/bot/interactive.js` construye el `interactiveMessage` con botón `single_select` (`generateWAMessageFromContent` + `relayMessage`), con `interactiveMessage` directo y respaldo `viewOnceMessage`; `Connection.sendList` lo expone y el router lo pasa como `ctx.sendList`. Para que WhatsApp **pinte** el desplegable hacen falta dos cosas: `messageContextInfo.messageSecret` (32 bytes aleatorios) en el mensaje y `additionalNodes` en el relay con `<biz><interactive type="native_flow" v="1"><native_flow v="9" name="mixed"/></interactive></biz>`. Sin ellos el mensaje se acepta sin error pero el cliente lo ignora. El `header` solo se agrega si hay título (un header vacío no renderiza). Límites que se recortan en el adaptador: cuerpo 1024, pie 60, texto del botón 20, título de sección 24, título de fila 24, descripción 72. La respuesta llega en `interactiveResponseMessage.nativeFlowResponseMessage.paramsJson` y el router la normaliza a `ctx.selection` (igual que `listResponseMessage`/botones). Cada paso con opciones incluye **las opciones numeradas en el texto**, así que responder con el número siempre funciona; si el envío falla o `relayMessage` tarda más de 8 s, el plugin manda el mismo menú numerado en texto. Log `[interactive] lista enviada: <id>` cuando el relay se acepta.
- Logs: `[ficha] <grupo> fase=<fase> paso=<n> texto="..." seleccion=...` por cada respuesta dentro de una ficha; `[router] respuesta interactiva no reconocida: <claves> <json>` si WhatsApp manda una respuesta con otra forma.
- `ctx.selection` convive con `ctx.text` (vacío en las respuestas de lista).


## Lobby automático (plugin `lobby` + `shared/utils/lobbyFlow.js`)
- Configuración (admin del grupo o creador): `!lobby ver`, `!lobby on|off`, `!lobby aqui lobby`, `!lobby aqui general`, `!lobby demora <segundos>`, `!lobby reset`. Cada grupo se registra desde dentro con `!lobby aqui ...` (no hay que copiar JIDs).
- Estado en Mongo (`lobby`, `LobbyStore`): `{ enabled, lobbyJid, generalJid, welcomeDelayMs, generalCode, generalCodeAt, greeted{}, submitted{} }`.
- Flujo: `group.join-request` en el lobby → `groupRequestParticipantsUpdate(..., "approve")`. Al `add` en el lobby espera `welcomeDelayMs` (5 s por defecto), **relee metadata** y saluda con mención; luego reinyecta un `!ficha` sintético al router, así que aplican las mismas validaciones y desplegables que el comando real.
- Al enviarse la ficha en el lobby, el gancho `onSubmitted` del plugin `fichas` marca `submitted` y manda el link del general **por privado**; si el DM falla, lo dice en la respuesta pública.
- `group.join-request` en general: con ficha (o si está exento) aprueba; sin ficha → `"reject"` + DM explicando el motivo. Al `add` en general expulsa del lobby (`remove`) y restablece el link (`groupRevokeInvite`, cooldown 15 s) para que el usado no sirva a nadie más.
- Exentos del flujo (ni saludo, ni ficha, ni link, ni expulsión; sus solicitudes se aprueban sin filtro): dueño (`CREATOR_NUMBERS`), `BOT_NUMBERS`/`BOT_LIDS`, `!protegidos` y admins del lobby o del general. Se recalculan con metadata fresca en cada paso.
- Solicitudes que llegan con el bot dormido: se repasan al `ready` y cada `LOBBY_POLL_MS` con `groupRequestParticipantsList`.
- Requisitos de WhatsApp: el bot debe ser admin en ambos grupos y ambos con “aprobar nuevos miembros”. Sin lobby/general configurados el flujo no hace nada; `!lobby ver` muestra el estado y si el bot es admin.
- Validación de la ficha antes de enviarla (`validateFichaValues`): campos llenos, opciones válidas, edad entre 13 y 99 y “Sí” en los campos de aceptación (reglas/compromiso). Si algo falla se re-pregunta solo ese campo.
- Logs: `[lobby] solicitud aprobada ...`, `[lobby] solicitud rechazada en general (sin ficha) ...`, `[lobby] expulsado del lobby por entrar a general ...`, `[lobby] link del general restablecido`.


## Console logs
- `[cmd] <command> (<n> args) — <phone> (<sender>) en grupo "<name>" (<id>)`
- `[anti_nsfw] <group>: <mediaType> → <provider> score=<s> nsfw=<b>`
- `[nsfw] <Provider> falló, usando local:`, `[stickers] ... outputSize=`, `[stickers] Error creando sticker:`
- `[router] Error en <plugin>:`, `[song] Error:`, `[monitor] RAM ... | CPU ... | uptime ...`, `[view-once] Reenviado: <id>`, `[bot] QR recibido. Disponible en el visor privado.`
- `[lobby] solicitud aprobada/rechazada ...`, `[lobby] expulsado del lobby ...`, `[lobby] link del general restablecido ...`, `[lobby] no pude ...`
- `src/index.js`: duplica console.log/warn a `logs/bot.log` (resuelve `logs/` del CWD con fallback a `/tmp`; Dockerfile pre-crea `/app/bot/logs`), filtra ruido de sesión Baileys, monitor cada 10s. View-once se reenvía automáticamente
