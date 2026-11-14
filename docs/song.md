# Plugin `song`

Descarga audio de YouTube y lo envía como nota de audio a WhatsApp.

## Comandos

| Comando | Descripción |
|---------|-------------|
| `!song <query>` | Busca en YouTube y descarga el primer resultado |
| `!song <url>` | Descarga audio desde la URL directamente |
| `!musica <query>` | Alias |
| `!music <query>` | Alias |

## Ejemplos

```
!song never gonna give you up
!musica https://youtube.com/watch?v=dQw4w9WgXcQ
```

## Arquitectura

```
usuario → !song <query>
           │
           ├─ yt-dlp (ytsearch:) → obtiene URL del primer resultado
           │
           └─ yt-dlp (--extract-audio --audio-format mp3) → audio MP3
                                                           │
                                                           └─ se envía a WhatsApp
```

### Componentes

- **Plugin** (`bot/src/interfaces/commands/song/index.js`): maneja el comando, envía mensajes
- **Downloader** (`bot/src/infrastructure/youtube/downloader.js`): lógica de descarga

### Downloader

- **Búsqueda**: usa `yt-dlp` con `ytsearch:` (no requiere autenticación)
- **Descarga**: `yt-dlp --extract-audio --audio-format mp3 --audio-quality 5 --output -`
  - `ytsearch:` devuelve el primer resultado; las URLs directas deben ser **HTTPS de YouTube** (youtube.com, youtu.be, etc.)
  - `--audio-quality 5` (~192kbps VBR), tope 15MB
  - Argumentos base: `-4 --no-warnings --retries 3 --socket-timeout 20`
- **Versión**: el `Dockerfile` baja la **última** release de yt-dlp en cada build (`ARG YTDLP_VERSION=latest`; fija una fecha concreta si alguna rompe algo) e instala **Deno**, el runtime JS que YouTube exige para resolver challenges. Sin un runtime JS, yt-dlp avisa `No supported JavaScript runtime` y se pierden formatos
- **Errores**: `describeYtDlpError()` traduce el stderr de yt-dlp (bot check, 403, video privado, timeout) a un mensaje corto para el grupo; el detalle crudo queda en `[song] Error:`

### Bloqueo por IP (`Sign in to confirm you're not a bot`)

YouTube desconfía de las IPs de datacenter (Railway incluido) y pide sesión. El downloader no se rinde al primer fallo:

1. Reintenta la descarga con otros clientes del reproductor (`youtube:player_client=tv_simply,web_embedded`, luego `android_vr`). El chequeo no se aplica igual a todos.
2. Si todos responden lo mismo, propaga el error y el plugin explica que hace falta cargar cookies.

**Cookies**: `YTDLP_COOKIES_B64` con un `cookies.txt` en base64 (cuenta desechable, nunca la principal). `docker-entrypoint.sh` lo decodifica al volumen (`$AUTH_DIR/cookies.txt`, modo 600) y exporta `YTDLP_COOKIES` si no está definido, así sobrevive a los redeploys. Caducan cada semanas y hay que renovarlas.

**SoundCloud no sirve como respaldo**: sin sesión solo entrega 30 s de muestra (`hls_mp3_1_0_preview`) y algunos temas están protegidos con DRM. Se probó y se descartó.

### Limitaciones

- Tamaño máximo: 15MB (límite de WhatsApp); un audio mayor corta en `stdout maxBuffer length exceeded`
- Duración máxima: ~10min a 192kbps
- Sin búsqueda persistente: siempre descarga el primer resultado
- Enlaces directos: solo HTTPS de YouTube. SoundCloud se usa como respaldo de búsquedas, no como enlace de entrada

## Env vars

| Variable | Default | Descripción |
|----------|---------|-------------|
| `YTDLP_PATH` | `yt-dlp` | Path al binario de yt-dlp |
| `YTDLP_COOKIES` | — | Ruta a un `cookies.txt` (formato Netscape) para `--cookies` |
| `YTDLP_COOKIES_B64` | — | El mismo `cookies.txt` en base64; el entrypoint lo escribe en el volumen y apunta `YTDLP_COOKIES` |
| `YTDLP_PROXY` | — | Proxy para `--proxy` (p. ej. residencial si la IP del hosting queda bloqueada) |
| `YTDLP_EXTRACTOR_ARGS` | — | `--extractor-args`, p. ej. `youtube:player_client=tv_simply,web_embedded` |
| `YTDLP_JS_RUNTIMES` | — | `--js-runtimes`, p. ej. `node:22` (Deno ya se usa por estar en PATH) |
| `YTDLP_EXTRA_ARGS` | — | Argumentos extra sueltos (`--sleep-requests 1`, `--retries 5`, ...) |

## Logs

```
[song] Error: <mensaje>
[song] YouTube pidió verificación con "<cliente>"; probando otro cliente.
[entrypoint] cookies de YouTube escritas en /app/bridge/auth/cookies.txt
[entrypoint] YTDLP_COOKIES_B64 no se pudo decodificar; se ignora.
```
