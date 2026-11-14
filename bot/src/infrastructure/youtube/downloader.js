import { execFile } from "child_process";
import { env } from "../../shared/config/env.js";

const YTDLP_BIN = env("YTDLP_PATH", "yt-dlp");
const YTDLP_COOKIES = env("YTDLP_COOKIES").trim();
const YTDLP_PROXY = env("YTDLP_PROXY").trim();
const YTDLP_EXTRACTOR_ARGS = env("YTDLP_EXTRACTOR_ARGS").trim();
const YTDLP_JS_RUNTIMES = env("YTDLP_JS_RUNTIMES").trim();
const YTDLP_EXTRA_ARGS = env("YTDLP_EXTRA_ARGS").trim();
const MAX_FILE_SIZE = 15 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
const BASE_ARGS = ["-4", "--no-warnings", "--retries", "3", "--socket-timeout", "20"];
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);

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

/** Traduce el error crudo de yt-dlp a algo que un usuario de WhatsApp entienda. */
export function describeYtDlpError(err) {
  const raw = `${err?.stderr || ""} ${err?.message || ""}`.toLowerCase();
  if (/sign in to confirm|not a bot|bot.?check|confirm you.re not a bot/.test(raw)) {
    return "YouTube está pidiendo verificación de bot para esta conexión. Intenta con otra canción o más tarde.";
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
  _authArgs() {
    const args = [];
    if (YTDLP_COOKIES) args.push("--cookies", YTDLP_COOKIES);
    if (YTDLP_PROXY) args.push("--proxy", YTDLP_PROXY);
    if (YTDLP_EXTRACTOR_ARGS) args.push("--extractor-args", YTDLP_EXTRACTOR_ARGS);
    if (YTDLP_JS_RUNTIMES) args.push("--js-runtimes", YTDLP_JS_RUNTIMES);
    return args;
  }

  _baseArgs() {
    return [...this._authArgs(), ...BASE_ARGS, ...splitArgs(YTDLP_EXTRA_ARGS)];
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

  async _downloadAudio(url) {
    const { stdout } = await this._exec([
      ...this._baseArgs(),
      "--no-playlist",
      "--extract-audio",
      "--audio-format", "mp3",
      "--audio-quality", "5",
      "--output", "-",
      url,
    ], { encoding: "buffer", maxBuffer: MAX_FILE_SIZE + 1024 * 1024 });

    const buffer = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    if (!buffer.length) throw new Error("yt-dlp no devolvió audio.");
    if (buffer.length > MAX_FILE_SIZE) throw new Error("El audio excede el límite de 15 MB de WhatsApp.");
    return buffer;
  }

  async searchAndDownload(input) {
    const resolved = await this.resolve(input);
    const buffer = await this._downloadAudio(resolved.value);
    return {
      buffer,
      title: resolved.searchResult?.title || "audio",
      durationSeconds: resolved.searchResult?.duration || 0,
      searchResult: resolved.searchResult,
    };
  }
}
