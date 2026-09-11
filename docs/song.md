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
  - `YTDLP_COOKIES` opcional para pasar cookies a yt-dlp

### Limitaciones

- Tamaño máximo: 15MB (límite de WhatsApp)
- Duración máxima: ~30min en MP3
- Sin búsqueda persistente: siempre descarga el primer resultado
- Solo HTTPS de YouTube: URLs directas de otras fuentes se rechazan

## Env vars

| Variable | Default | Descripción |
|----------|---------|-------------|
| `YTDLP_PATH` | `yt-dlp` | Path al binario de yt-dlp |
| `YTDLP_COOKIES` | — | Cookies opcionales para yt-dlp |

## Logs

```
[song] Error: <mensaje>
```
