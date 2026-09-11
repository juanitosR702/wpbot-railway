import { execFile } from "child_process";
import { env } from "../../shared/config/env.js";

const YTDLP_BIN = env("YTDLP_PATH", "yt-dlp");
const YTDLP_COOKIES = env("YTDLP_COOKIES").trim();
const MAX_FILE_SIZE = 15 * 1024 * 1024;
const COMMAND_TIMEOUT_MS = 120_000;
const YOUTUBE_HOSTS = new Set(["youtube.com", "www.youtube.com", "m.youtube.com", "music.youtube.com", "youtu.be"]);

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
    return YTDLP_COOKIES ? ["--cookies", YTDLP_COOKIES] : [];
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
      ...this._authArgs(),
      `ytsearch${limit}:${normalizedQuery}`,
      "--flat-playlist",
      "--dump-json",
      "--no-warnings",
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
      ...this._authArgs(),
      "--no-playlist",
      "--no-warnings",
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