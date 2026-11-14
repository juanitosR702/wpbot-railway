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

**Cookies**: cuenta desechable, nunca la principal. El entrypoint acepta dos variables y escribe siempre `$AUTH_DIR/cookies.txt` (modo 600, en el volumen, sobrevive a los redeploys):

- `YTDLP_COOKIES_GZ_B64` — **recomendada**: `gzip -c cookies.txt | base64 -w0`. Una variable de Railway admite 32768 caracteres y un `cookies.txt` completo en base64 puede pasarse; comprimido cabe de sobra.
- `YTDLP_COOKIES_B64` — `base64 -w0 cookies.txt`, solo si el archivo es pequeño.

Si el valor no decodifica o el archivo no contiene cookies de `youtube.com`, se descarta y el log avisa. Las cookies caducan cada semanas y hay que renovarlas.

**SoundCloud no sirve como respaldo**: sin sesión solo entrega 30 s de muestra (`hls_mp3_1_0_preview`) y algunos temas están protegidos con DRM. Se probó y se descartó.

### 403 al descargar el audio (`unable to download video data`)

Algunos videos (típicamente de discográficas) resuelven el formato de audio DASH pero rechazan los bytes con `HTTP Error 403`. En ese caso se reintenta con el **formato progresivo** (video+audio en un solo archivo) y se extrae la pista de audio.

Ojo: yt-dlp **no posprocesa** al escribir en stdout, aunque se pase `--extract-audio`; entrega el stream tal cual (webm/mp4). Por eso el respaldo progresivo pasa el buffer por `transcodeToMp3()` (ffmpeg: `-vn -acodec libmp3lame -b:a 128k`), que reduce 14 MB de mp4 a ~3,4 MB de mp3 real.

### Limitaciones

- Tamaño máximo: 15MB (límite de WhatsApp); un audio mayor corta en `stdout maxBuffer length exceeded`
- Duración máxima: ~10min a 192kbps
- Sin búsqueda persistente: siempre descarga el primer resultado
- Enlaces directos: solo HTTPS de YouTube

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
[song] El audio DASH devolvió 403; probando el formato progresivo.
[entrypoint] cookies de YouTube escritas en /app/bridge/auth/cookies.txt
[entrypoint] YTDLP_COOKIES_GZ_B64 no se pudo descomprimir; se ignora.
[entrypoint] YTDLP_COOKIES_B64 no se pudo decodificar; se ignora.
```
