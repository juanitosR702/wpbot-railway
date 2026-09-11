# 🤖 Bot WhatsApp — Taco

Bot multifuncional para WhatsApp con detección NSFW, economía, stickers, música y más. Construido con [Baileys v6](https://github.com/WhiskeySockets/Baileys).

## 🚀 Stack

| Componente | Tecnología |
|------------|------------|
| WhatsApp API | Baileys v6 |
| Runtime | Node.js 20+ |
| Formato | ES Modules |
| Audio | yt-dlp |
| Stickers | sharp + ffmpeg |
| NSFW | local (HSV/sharp), OpenRouter, Gemini, OpenAI |
| Base de datos | JSON (archivos planos) |

## 📋 Requisitos

### Local

- **Node.js 20+**
- **FFmpeg** — para stickers animados y conversión de audio
  - Windows: `winget install Gyan.FFmpeg`
  - macOS: `brew install ffmpeg`
  - Linux: `sudo apt install ffmpeg`
- **yt-dlp** — para búsqueda en YouTube
  - Windows: `winget install yt-dlp` o descargar de [yt-dlp.github.io](https://yt-dlp.github.io)
  - macOS: `brew install yt-dlp`
  - Linux: `sudo apt install yt-dlp` o descargar el binario

### Docker

Todo incluido en el `Dockerfile`:
- Node.js 20-slim
- FFmpeg
- yt-dlp
- curl

## ⚙️ Instalación

```bash
# 1. Clonar
git clone https://github.com/juanitosR702/bot-nuevo.git
cd bot-nuevo

# 2. Variables de entorno
cp .env.example .env
# Editar .env con tus valores

# 3. Instalar dependencias
cd bot && npm install --legacy-peer-deps

# 4. Ejecutar
npm run dev
```

## 🔧 Variables de entorno (`.env`)

| Variable | Descripción | Default |
|----------|-------------|---------|
| `PREFIX` | Prefijo de comandos | `!` |
| `BOT_NUMBERS` | Números del bot (separados por coma) | — |
| `CREATOR_NUMBERS` | Números del creador (separados por coma) | — |
| `NSFW_PROVIDER` | Proveedor NSWF (`local`, `openrouter`, `gemini`, `openai`) | `local` |
| `NSFW_THRESHOLD` | Umbral de detección NSFW | `0.85` |
| `GEMINI_API_KEY` | API Key de Gemini (si usás `gemini` como provider) | — |
| `GEMINI_MODEL` | Modelo de Gemini | `gemini-2.5-flash` |
| `DATA_ROOT` | Ruta de datos persistentes | `bot/data/` |
| `YTDLP_PATH` | Path al binario de yt-dlp | `yt-dlp` |

## 📦 Comandos

### Base
| Comando | Descripción |
|---------|-------------|
| `!ping` | Latencia del bot |
| `!status` | Estado de WhatsApp, MongoDB y tiempo activo |
| `!hola` | Saludo grupal |
| `!echo <texto>` | Repite el texto |
| `!info` | Info del chat |

### Música
| Comando | Descripción |
|---------|-------------|
| `!song <nombre o URL>` | Descarga audio de YouTube |
| `!musica <nombre o URL>` | Alias |
| `!music <nombre o URL>` | Alias |

### Stickers
| Comando | Descripción |
|---------|-------------|
| `!sticker` | Crea sticker desde imagen/video |
| `!tiktoksticker <url>` | Sticker desde TikTok |

### Administración
| Comando | Descripción |
|---------|-------------|
| `!mute <usuario>` | Silencia a un usuario |
| `!blacklist <usuario>` | Bloquea a un usuario |
| `!warn <usuario>` | Advierte a un usuario |
| `!antilink` | Activa/desactiva antilink |
| `!bienvenida` | Configura mensaje de bienvenida |

### Utilidades
| Comando | Descripción |
|---------|-------------|
| `!encuesta <pregunta \| op1 \| op2>` | Crea encuesta |
| `!toimage` | Convierte sticker a imagen |
| `!level` | Nivel de experiencia |
| `!rank` | Ranking del grupo |
| `!coinflip <cantidad>` | Apuesta cara o cruz |

## 🐳 Docker

```dockerfile
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y ffmpeg git curl && rm -rf /var/lib/apt/lists/*

RUN curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux \
  -o /usr/local/bin/yt-dlp && chmod a+x /usr/local/bin/yt-dlp
```

## 📁 Estructura

```
bot/
├── src/
│   ├── app/bootstrap.js          # Orquestador: registra plugins
│   ├── interfaces/
│   │   ├── bot/router.js         # Router de comandos
│   │   └── commands/             # Plugins
│   │       ├── song/             # Descarga de música
│   │       ├── stickers/         # Stickers
│   │       ├── antiNsfw/         # Detección NSFW
│   │       └── ...               # economy, casino, levels, etc.
│   └── infrastructure/
│       ├── youtube/downloader.js # yt-dlp
│       ├── stickers/             # Procesamiento de stickers
│       ├── nsfw/                 # Detectores NSFW
│       └── storage/              # Stores JSON persistentes
```

## 📄 Documentación

- [`docs/song.md`](docs/song.md) — Plugin de música
