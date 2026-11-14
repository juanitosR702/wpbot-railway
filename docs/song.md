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

### Limitaciones

- Tamaño máximo: 15MB (límite de WhatsApp)
- Duración máxima: ~30min en MP3
- Sin búsqueda persistente: siempre descarga el primer resultado
- Solo HTTPS de YouTube: URLs directas de otras fuentes se rechazan

## Env vars

| Variable | Default | Descripción |
|----------|---------|-------------|
| `YTDLP_PATH` | `yt-dlp` | Path al binario de yt-dlp |
| `YTDLP_COOKIES` | — | Ruta a un `cookies.txt` (formato Netscape) para `--cookies` |
| `YTDLP_PROXY` | — | Proxy para `--proxy` (p. ej. residencial si la IP del hosting queda bloqueada) |
| `YTDLP_EXTRACTOR_ARGS` | — | `--extractor-args`, p. ej. `youtube:player_client=tv_simply,web_embedded` |
| `YTDLP_JS_RUNTIMES` | — | `--js-runtimes`, p. ej. `node:22` (Deno ya se usa por estar en PATH) |
| `YTDLP_EXTRA_ARGS` | — | Argumentos extra sueltos (`--sleep-requests 1`, `--retries 5`, ...) |

## Logs

```
[song] Error: <mensaje>
```
