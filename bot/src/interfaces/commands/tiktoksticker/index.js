import { execFile } from "child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { animatedToSticker, imageToSticker } from "../../../infrastructure/stickers/processor.js";
import { stickerSendOptions } from "../../../infrastructure/stickers/metadata.js";
import { DATA } from "../../../shared/config/paths.js";

const COMMANDS = new Set(["tiktoksticker"]);
const DEBUG_DIR = DATA.stickers;
const TIKWM_API = "https://www.tikwm.com/api/";
const MAX_VIDEO_BYTES = 15 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 30_000;

function assertRemoteHttpsUrl(value) {
  const parsed = new URL(value);
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== "https:" || host === "localhost" || host.endsWith(".local") || /^127\.|^0\.|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) {
    throw new Error("URL remota no permitida.");
  }
  return parsed.toString();
}

async function fetchBuffer(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(assertRemoteHttpsUrl(url), { signal: controller.signal, redirect: "error" });
    if (!response.ok) return null;
    const length = Number(response.headers.get("content-length") || 0);
    if (length > MAX_VIDEO_BYTES) throw new Error("El video excede 15 MB.");
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_VIDEO_BYTES) throw new Error("El video excede 15 MB.");
    return buffer;
  } finally {
    clearTimeout(timer);
  }
}
function getFfmpeg() {
  return import("ffmpeg-static")
    .then((mod) => mod.default || "ffmpeg")
    .catch(() => "ffmpeg");
}

const FFMPEG_TIMEOUT_MS = 60_000;

function execCmd(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: FFMPEG_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) { error.stderr = stderr; reject(error); return; }
      resolve({ stdout, stderr });
    });
  });
}

async function firstFrame(buffer) {
  const ffmpeg = await getFfmpeg();
  const dir = await mkdtemp(join(tmpdir(), "tiktoksticker-ff-"));
  const inputPath = join(dir, "in.mp4");
  const outputPath = join(dir, "frame.png");
  try {
    await writeFile(inputPath, buffer);
    await execCmd(ffmpeg, ["-y", "-i", inputPath, "-vframes", "1", "-f", "image2", outputPath]);
    return await readFile(outputPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function mediaContentFrom(message = {}) {
  if (message.imageMessage) {
    return { mediaType: "image", mimetype: message.imageMessage.mimetype || "image/jpeg" };
  }
  if (message.videoMessage) {
    return {
      mediaType: message.videoMessage.gifPlayback ? "gif" : "video",
      mimetype: message.videoMessage.mimetype || "video/mp4",
    };
  }
  if (message.documentMessage?.mimetype?.startsWith("image/")) {
    return { mediaType: "image", mimetype: message.documentMessage.mimetype };
  }
  if (message.documentMessage?.mimetype?.startsWith("video/")) {
    return { mediaType: "video", mimetype: message.documentMessage.mimetype };
  }
  return null;
}

function quotedMediaMessage(ctx) {
  const info = ctx.raw.message?.extendedTextMessage?.contextInfo;
  if (!info?.quotedMessage) return null;
  return {
    key: {
      remoteJid: info.remoteJid || ctx.phone,
      participant: info.participant,
      id: info.stanzaId,
    },
    message: info.quotedMessage,
  };
}

function selectMediaSource(ctx) {
  const direct = mediaContentFrom(ctx.raw.message);
  if (direct) return { message: ctx.raw, ...direct };

  const quoted = quotedMediaMessage(ctx);
  const quotedMedia = mediaContentFrom(quoted?.message);
  if (quoted && quotedMedia) return { message: quoted, ...quotedMedia };

  return null;
}

function extractTiktokUrl(args) {
  const fullText = (args || []).join(" ");
  const match = fullText.match(/https:\/\/(?:www\.|vm\.|m\.|vt\.)?tiktok\.com\/\S+/i);
  if (!match) return null;
  const url = match[0].replace(/[.,;:!?\s]+$/, "");
  return url;
}

function extractTiktokUrlFromReplied(ctx) {
  const info = ctx.raw.message?.extendedTextMessage?.contextInfo;
  if (!info?.quotedMessage) return null;
  const text = info.quotedMessage.conversation || info.quotedMessage.extendedTextMessage?.text || "";
  const match = text.match(/https:\/\/(?:www\.|vm\.|m\.|vt\.)?tiktok\.com\/\S+/i);
  if (!match) return null;
  return match[0].replace(/[.,;:!?\s]+$/, "");
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(assertRemoteHttpsUrl(url), { signal: controller.signal, redirect: "error" });
    if (!response.ok) return null;
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function tryTikwm(url) {
  const apiUrl = `${TIKWM_API}?url=${encodeURIComponent(url)}`;
  const json = await fetchJson(apiUrl);
  if (!json || json.code !== 0 || !json.data?.video) return null;
  const videoUrl = json.data.video.startsWith("http") ? json.data.video : `https://www.tikwm.com${json.data.video}`;
  return fetchBuffer(videoUrl);
}

async function tryTiktokDl(url) {
  try {
    const { Downloader } = await import("@tobyg74/tiktok-api-dl");
    const data = await Downloader(url, { version: "v3" });
    const videoUrl = data?.result?.videoSD || data?.result?.videoHD || data?.result?.video?.[0]?.url;
    if (!videoUrl) return null;
    return fetchBuffer(videoUrl);
  } catch {
    return null;
  }
}

async function downloadTiktokVideo(tiktokUrl) {
  let result = await tryTikwm(tiktokUrl);
  if (result) return result;

  let canonical = tiktokUrl;

  result = await tryTiktokDl(canonical);
  if (result) return result;

  result = await tryTiktokDl(tiktokUrl);
  if (result) return result;

  throw new Error("No se pudo obtener el video de TikTok (probá con otro link)");
}

async function sendSticker(ctx, sticker) {
  await mkdir(DEBUG_DIR, { recursive: true });

  const tmpPath = join(DEBUG_DIR, `tiktok-sticker-${Date.now()}-${Math.random().toString(36).slice(2)}.webp`);

  await writeFile(tmpPath, sticker);

  try {
    await ctx.sendMessage({
      sticker: { url: tmpPath },
      mimetype: "image/webp",
      ...stickerSendOptions,
    });
  } finally {
    await rm(tmpPath, { force: true });
  }
}

function makeHandler() {
  return async (ctx) => {
    if (!ctx.isCommand || !COMMANDS.has(ctx.command)) return null;

    const tiktokUrl = extractTiktokUrl(ctx.args) || extractTiktokUrlFromReplied(ctx);
    if (tiktokUrl) {
      try {
        const videoBuffer = await downloadTiktokVideo(tiktokUrl);

        try {
          const sticker = await animatedToSticker(videoBuffer, {
            mediaType: "video",
            mimetype: "video/mp4",
          });
          await sendSticker(ctx, sticker);
          return null;
        } catch {
          const frame = await firstFrame(videoBuffer);
          const sticker = await imageToSticker(frame);
          await sendSticker(ctx, sticker);
          return null;
        }
      } catch (err) {
        console.error("[tiktoksticker] Error con enlace TikTok:", err);
        return `No pude obtener el sticker desde ese enlace 😕 (${err.message || "error desconocido"})`;
      }
    }

    const source = selectMediaSource(ctx);
    if (!source) {
      return `Responde a una imagen, video o GIF, o envía un enlace de TikTok 📎`;
    }

    try {
      const media = await ctx.downloadMedia(source.message);

      let sticker;
      if (source.mediaType === "image" && !source.mimetype.includes("gif")) {
        sticker = await imageToSticker(media);
      } else {
        try {
          sticker = await animatedToSticker(media, {
            mediaType: source.mediaType,
            mimetype: source.mimetype,
          });
        } catch {
          const frame = await firstFrame(media);
          sticker = await imageToSticker(frame);
        }
      }

      await sendSticker(ctx, sticker);
      return null;
    } catch (err) {
      console.error("[tiktoksticker] Error creando sticker:", err);
      return `No pude crear el sticker 😕 (${err.message || "error desconocido"})`;
    }
  };
}

export const tiktokStickerPlugin = {
  name: "tiktoksticker",
  version: "1.0.0",
  register(router) {
    router.register(makeHandler(), {
      category: "STICKERS",
      commands: [...COMMANDS],
    });
  },
};
