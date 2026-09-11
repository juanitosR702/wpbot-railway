import { createHash } from "crypto";
import { execFile } from "child_process";
import { mkdtemp, writeFile, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import sharp from "sharp";
import { createNsfwProvider, getNsfwConfig } from "./nsfwProvider.js";

export { getNsfwConfig } from "./nsfwProvider.js";

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function now() {
  return Date.now();
}

async function extractVideoFrames(buffer, ext = "mp4") {
  const dir = await mkdtemp(join(tmpdir(), "nsfw-vid-"));
  const inputPath = join(dir, `in.${ext}`);
  const outputs = [join(dir, "f1.png"), join(dir, "f2.png"), join(dir, "f3.png")];
  let ffmpeg = "ffmpeg";
  let ffprobe = "ffprobe";
  try {
    const mod = await import("ffmpeg-static");
    if (mod.default) {
      ffmpeg = mod.default;
      ffprobe = mod.default.replace(/ffmpeg\.exe$/i, "ffprobe.exe").replace(/ffmpeg$/i, "ffprobe");
    }
  } catch {}

  try {
    if (ext === "webp") {
      try {
        const meta = await sharp(buffer).metadata();
        const pages = meta.pages || 1;
        if (pages > 1) {
          const idx = [0, Math.floor(pages / 2), Math.max(0, pages - 2)];
          for (let i = 0; i < 3; i++) {
            try {
              const frame = await sharp(buffer, { page: idx[i] }).png().toBuffer();
              await writeFile(outputs[i], frame);
            } catch {}
          }
        }
      } catch {}
    } else {
      await writeFile(inputPath, buffer);

      let duration = 0;
      try {
        const { stdout } = await new Promise((resolve, reject) => {
          execFile(ffprobe, ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", inputPath], { windowsHide: true, timeout: 10000 }, (err, stdout) => {
            if (err) reject(err);
            else resolve({ stdout });
          });
        });
        duration = parseFloat(stdout.trim());
      } catch {}

      const d = duration;
      let times;
      if (!d || d < 3) {
        times = [1, 3, 5];
      } else {
        const t1 = Math.min(1, d - 2);
        const t2 = Math.max(t1 + 0.5, Math.min(d / 2, d - 1));
        const t3 = Math.max(t2 + 0.5, d - 1);
        times = [t1, t2, t3];
      }

      for (let i = 0; i < 3; i++) {
        try {
          await new Promise((resolve, reject) => {
            execFile(ffmpeg, ["-y", "-ss", String(times[i]), "-i", inputPath, "-vframes", "1", "-q:v", "2", outputs[i]], { windowsHide: true, timeout: 15000 }, (err) => {
              if (err) reject(err);
              else resolve();
            });
          });
        } catch {}
      }
    }

    const frames = [];
    for (const p of outputs) {
      try { frames.push(await readFile(p)); } catch {}
    }
    return frames.length > 0 ? frames : null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export class NsfwDetector {
  constructor(options = {}) {
    this.config = { ...getNsfwConfig(), ...options };
    this.provider = typeof options.provider?.analyze === "function"
      ? options.provider
      : createNsfwProvider(this.config);
    this.cache = new Map();
  }

  _cacheGet(key) {
    const entry = this.cache.get(key);
    if (!entry) return null;
    if (now() - entry.at > this.config.cacheTtlMs) {
      this.cache.delete(key);
      return null;
    }
    return entry.result;
  }

  _cacheSet(key, result) {
    this.cache.set(key, { at: now(), result });
    while (this.cache.size > this.config.cacheMaxEntries) {
      const oldest = this.cache.keys().next().value;
      this.cache.delete(oldest);
    }
  }

  async _analyzeVideo(buffer, options) {
    const ext = options.mimeType === "image/webp" ? "webp" : "mp4";
    const frames = await extractVideoFrames(buffer, ext);
    if (!frames || frames.length === 0) {
      return { skipped: true, reason: "no se pudieron extraer frames del video", score: 0, nsfw: false, provider: this.provider.name };
    }

    const validFrames = frames.filter(f => f.length <= this.config.maxBytes);
    if (validFrames.length === 0) {
      return { skipped: true, reason: "frames de video demasiado grandes", score: 0, nsfw: false, provider: this.provider.name };
    }

    const results = [];
    for (const frame of validFrames) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
      try {
        const r = await this.provider.analyze(frame, { ...options, mimeType: "image/png", signal: controller.signal });
        results.push(r);
      } catch (err) {
        results.push({ error: err?.message || "error NSFW", score: 0, nsfw: false, provider: this.provider.name });
      } finally {
        clearTimeout(timer);
      }
    }

    let best = results[0];
    for (const r of results) {
      if (Number(r.score || 0) > Number(best.score || 0)) best = r;
    }

    const score = Number(best.score || 0);
    const normalized = {
      ...best,
      score,
      nsfw: score >= this.config.threshold,
      threshold: this.config.threshold,
      frames: results.length,
    };

    const key = sha256(buffer);
    this._cacheSet(key, normalized);
    return normalized;
  }

  async analyze(buffer, options = {}) {
    if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
      return { skipped: true, reason: "media vacia", score: 0, nsfw: false };
    }

    if (options.mimeType?.startsWith("video/")) {
      return this._analyzeVideo(buffer, options);
    }

    if (options.mimeType === "image/webp") {
      try {
        const meta = await sharp(buffer).metadata();
        if ((meta.pages || 1) > 1) return this._analyzeVideo(buffer, options);
      } catch {}
    }

    if (buffer.length > this.config.maxBytes) {
      return { skipped: true, reason: "media demasiado grande", score: 0, nsfw: false };
    }

    const key = sha256(buffer);
    const cached = this._cacheGet(key);
    if (cached) return { ...cached, cached: true };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      if (typeof this.provider?.analyze !== "function") {
        return { error: "proveedor NSFW invalido", score: 0, nsfw: false, provider: String(this.config.provider || "unknown") };
      }

      const result = await this.provider.analyze(buffer, { ...options, signal: controller.signal });
      const score = Number(result.score || 0);
      const normalized = {
        ...result,
        score,
        nsfw: score >= this.config.threshold,
        threshold: this.config.threshold,
      };
      this._cacheSet(key, normalized);
      return normalized;
    } catch (err) {
      const message = err?.name === "AbortError" ? "timeout del proveedor NSFW" : err?.message || "error NSFW";
      return { error: message, score: 0, nsfw: false, provider: this.provider.name };
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createNsfwDetector(options = {}) {
  return new NsfwDetector(options);
}
