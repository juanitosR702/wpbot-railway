import { execFile, spawn } from "child_process";
import { access, constants } from "fs/promises";
import { env } from "../../shared/config/env.js";

const YTDLP_BIN = env("YTDLP_PATH", "yt-dlp");
const YTDLP_COOKIES = env("YTDLP_COOKIES").trim();
const YTDLP_PROXY = env("YTDLP_PROXY").trim();
const YTDLP_EXTRACTOR_ARGS = env("YTDLP_EXTRACTOR_ARGS").trim();
const YTDLP_JS_RUNTIMES = env("YTDLP_JS_RUNTIMES").trim();
const YTDLP_EXTRA_ARGS = env("YTDLP_EXTRA_ARGS").trim();
const MAX_FILE_SIZE = 15 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
const CONVERT_TIMEOUT_MS = 120_000;
const BASE_ARGS = ["-4", "--no-warnings", "--retries", "3", "--socket-timeout", "20"];
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);

// Cuando YouTube bloquea la IP del hosting responde "Sign in to confirm you're
// not a bot". Antes de rendirse se prueban otros clientes del reproductor: el
// chequeo no se aplica igual a todos.
const BOT_CHECK_PATTERN = /sign in to confirm|not a bot|confirm you.re not a bot|bot.?check/i;
const CLIENT_VARIANTS = [
  "youtube:player_client=tv_simply,web_embedded",
  "youtube:player_client=android_vr",
];

// Algunos videos sirven audio DASH que YouTube rechaza con 403 ("unable to
// download video data"). El formato progresivo (video+audio en un solo archivo)
// sí se entrega; ffmpeg lo convierte a mp3 igual que el resto.
const PROGRESSIVE_FORMAT = "best[protocol^=http][acodec!=none][vcodec!=none]/bestaudio";

/** Divide una cadena de argumentos respetando comillas simples y dobles. */
function splitArgs(value) {
  const args = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match;
  while ((match = pattern.exec(value)) !== null) {
    args.push(match[1] ?? match[2] ?? match[3]);
  }
  return args;
}

/** true si el error de yt-dlp es el chequeo anti-bot de YouTube (bloqueo por IP). */
export function isBotCheck(err) {
  return BOT_CHECK_PATTERN.test(`${err?.stderr || ""} ${err?.message || ""}`);
}

/** true si el buffer ya es un mp3 (ID3 o cabecera de frame). */
export function looksLikeMp3(buffer) {
  if (!buffer || buffer.length < 3) return false;
  if (buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return true;
  return buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0;
}

async function resolveFfmpeg() {
  // Mismo criterio que en los stickers: ffmpeg-static puede no tener binario
  // (el Dockerfile instala con --ignore-scripts) y entonces se usa el del PATH.
  try {
    const mod = await import("ffmpeg-static");
    if (mod.default) {
      await access(mod.default, constants.X_OK);
      return mod.default;
    }
  } catch {
    // se usa el ffmpeg del sistema
  }
  return "ffmpeg";
}

/**
 * yt-dlp no posprocesa cuando escribe en stdout: entrega el stream descargado
 * (webm u mp4 progresivo). Aquí se extrae la pista de audio y se convierte a mp3.
 */
export async function transcodeToMp3(buffer) {
  if (looksLikeMp3(buffer)) return buffer;
  const ffmpeg = await resolveFfmpeg();

  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, [
      "-hide_banner", "-loglevel", "error",
      "-i", "pipe:0",
      "-vn", "-acodec", "libmp3lame", "-b:a", "128k", "-f", "mp3",
      "pipe:1",
    ], { windowsHide: true });

    const chunks = [];
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      const err = new Error("La conversión a mp3 tardó demasiado.");
      err.stderr = stderr;
      reject(err);
    }, CONVERT_TIMEOUT_MS);

    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-2000);
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      err.stderr = stderr;
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        const err = new Error(`ffmpeg terminó con código ${code}`);
        err.stderr = stderr;
        reject(err);
        return;
      }
      resolve(Buffer.concat(chunks));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(buffer);
  });
}

/** true si conviene reintentar con el formato progresivo (403 en el audio DASH). */
export function needsProgressiveFallback(err) {
  const raw = `${err?.stderr || ""} ${err?.message || ""}`.toLowerCase();
  return /http error 403|forbidden|requested format is not available/.test(raw);
}

/** Clientes a probar, en orden: el configurado primero y luego los de respaldo. */
export function extractorVariants(configured = YTDLP_EXTRACTOR_ARGS) {
  const variants = [];
  if (configured) variants.push(configured);
  for (const variant of CLIENT_VARIANTS) {
    if (!variants.includes(variant)) variants.push(variant);
  }
  return variants;
}

/** Traduce el error crudo de yt-dlp a algo que un usuario de WhatsApp entienda. */
export function describeYtDlpError(err) {
  const raw = `${err?.stderr || ""} ${err?.message || ""}`.toLowerCase();
  if (/sign in to confirm|not a bot|bot.?check|confirm you.re not a bot/.test(raw)) {
    return "YouTube está pidiendo verificación de bot para la conexión del servidor. Si eres admin del bot, carga las cookies de YouTube (YTDLP_COOKIES_B64); si no, intenta más tarde.";
  }
  if (/private video|members-only|join this channel|age.?restricted|confirm your age/.test(raw)) {
    return "Ese video es privado o está restringido por edad.";
  }
  if (/unsupported url|no suitable extractor|is not a valid url/.test(raw)) {
    return "Ese enlace no es de YouTube o no lo puedo leer.";
  }
  if (/http error 403|forbidden/.test(raw)) {
    return "YouTube rechazó la descarga desde el servidor (403).";
  }
  if (/unable to extract|failed to extract/.test(raw)) {
    return "YouTube cambió algo y no pude leer el video. Avisa al dueño del bot.";
  }
  if (/timed out|timeout|killed/.test(raw)) {
    return "La descarga tardó demasiado y la cancelé.";
  }
  if (/maxbuffer|enobufs/.test(raw)) {
    return "El audio es demasiado largo para enviarlo por WhatsApp.";
  }
  if (/video unavailable|not available in your country/.test(raw)) {
    return "Ese video no está disponible.";
  }
  return err?.message || "error desconocido";
}

function assertYouTubeUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("La URL no es válida.");
  }
  if (parsed.protocol !== "https:" || !YOUTUBE_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error("Solo se aceptan enlaces HTTPS de YouTube.");
  }
  return parsed.toString();
}

export class YouTubeDownloader {
  _authArgs(extractorArgs) {
    const args = [];
    if (YTDLP_COOKIES) args.push("--cookies", YTDLP_COOKIES);
    if (YTDLP_PROXY) args.push("--proxy", YTDLP_PROXY);
    const extractor = extractorArgs === undefined ? YTDLP_EXTRACTOR_ARGS : extractorArgs;
    if (extractor) args.push("--extractor-args", extractor);
    if (YTDLP_JS_RUNTIMES) args.push("--js-runtimes", YTDLP_JS_RUNTIMES);
    return args;
  }

  _baseArgs(extractorArgs) {
    return [...this._authArgs(extractorArgs), ...BASE_ARGS, ...splitArgs(YTDLP_EXTRA_ARGS)];
  }

  _exec(args, options = {}) {
    return new Promise((resolve, reject) => {
      execFile(YTDLP_BIN, args, {
        encoding: options.encoding ?? "utf8",
        maxBuffer: options.maxBuffer ?? 1024 * 1024 * 2,
        windowsHide: true,
        timeout: COMMAND_TIMEOUT_MS,
      }, (error, stdout, stderr) => {
        if (error) {
          error.stderr = stderr;
          reject(error);
          return;
        }
        resolve({ stdout, stderr });
      });
    });
  }

  isUrl(text) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(text.trim());
  }

  async search(query, maxResults = 5) {
    const normalizedQuery = String(query || "").trim();
    if (!normalizedQuery || normalizedQuery.length > 200) {
      throw new Error("La búsqueda debe tener entre 1 y 200 caracteres.");
    }
    const limit = Math.min(Math.max(Number(maxResults) || 1, 1), 5);
    const { stdout } = await this._exec([
      ...this._baseArgs(),
      `ytsearch${limit}:${normalizedQuery}`,
      "--flat-playlist",
      "--dump-json",
    ]);
    return stdout.trim().split("\n").filter(Boolean).map((line) => {
      const item = JSON.parse(line);
      if (!item.id) throw new Error("YouTube devolvió un resultado inválido.");
      return {
        id: item.id,
        title: item.title || "Sin título",
        url: `https://www.youtube.com/watch?v=${item.id}`,
        duration: item.duration ?? null,
      };
    });
  }

  async resolve(input) {
    const value = String(input || "").trim();
    if (this.isUrl(value)) return { value: assertYouTubeUrl(value), searchResult: null };

    const [result] = await this.search(value, 1);
    if (!result) throw new Error("No se encontraron resultados.");
    return { value: result.url, searchResult: result };
  }

  async _downloadAudio(url, extractorArgs, format) {
    const args = [
      ...this._baseArgs(extractorArgs),
      "--no-playlist",
      "--extract-audio",
      "--audio-format", "mp3",
      "--audio-quality", "5",
    ];
    if (format) args.push("--format", format);
    const { stdout } = await this._exec([...args, "--output", "-", url], {
      encoding: "buffer",
      maxBuffer: MAX_FILE_SIZE + 1024 * 1024,
    });

    const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    if (!buffer.length) throw new Error("yt-dlp no devolvió audio.");
    if (buffer.length > MAX_FILE_SIZE) throw new Error("El audio excede el límite de 15 MB de WhatsApp.");
    return buffer;
  }

  async _downloadYouTube(url) {
    let lastError = null;
    let retryProgressive = false;

    for (const variant of extractorVariants()) {
      try {
        return await this._downloadAudio(url, variant);
      } catch (err) {
        lastError = err;
        if (needsProgressiveFallback(err)) {
          retryProgressive = true;
          break;
        }
        if (!isBotCheck(err)) throw err;
        console.warn(`[song] YouTube pidió verificación con "${variant}"; probando otro cliente.`);
      }
    }

    if (retryProgressive) {
      console.warn("[song] El audio DASH devolvió 403; probando el formato progresivo.");
      for (const variant of extractorVariants()) {
        try {
          const raw = await this._downloadAudio(url, variant, PROGRESSIVE_FORMAT);
          return await transcodeToMp3(raw);
        } catch (err) {
          lastError = err;
          if (!needsProgressiveFallback(err) && !isBotCheck(err)) throw err;
        }
      }
    }

    throw lastError;
  }

  async searchAndDownload(input) {
    const resolved = await this.resolve(String(input || "").trim());
    const buffer = await this._downloadYouTube(resolved.value);
    return {
      buffer,
      title: resolved.searchResult?.title || "audio",
      durationSeconds: resolved.searchResult?.duration || 0,
      searchResult: resolved.searchResult,
    };
  }
}
