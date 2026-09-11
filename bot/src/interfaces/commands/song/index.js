import { YouTubeDownloader } from "../../../infrastructure/youtube/downloader.js";

const COMMANDS = new Set(["song", "musica", "music"]);

function makeHandler() {
  const yt = new YouTubeDownloader();

  return async (ctx) => {
    if (!ctx.isCommand || !COMMANDS.has(ctx.command)) return null;

    const query = ctx.args.join(" ").trim();
    if (!query) {
      return [
        `🎵 *Descargar música*`,
        ``,
        `Uso: ${ctx.prefix}song <nombre o URL>`,
        `Ej: ${ctx.prefix}song never gonna give you up`,
        `Ej: ${ctx.prefix}song https://youtube.com/watch?v=xxx`,
      ].join("\n");
    }

    await ctx.sendMessage({
      text: `🔍 Buscando "${query}"...`,
    });

    try {
      const result = await yt.searchAndDownload(query);

      await ctx.sendMessage({
        audio: result.buffer,
        mimetype: "audio/mpeg",
        seconds: Math.ceil(result.durationSeconds || 0),
      });

      return null;
    } catch (err) {
      console.error("[song] Error:", err?.message || err);
      return `No pude descargar la canción 😕\n${err.message || "error desconocido"}`;
    }
  };
}

export const songPlugin = {
  name: "song",
  version: "1.0.0",
  register(router) {
    router.register(makeHandler(), {
      category: "MÚSICA",
      commands: [...COMMANDS],
    });
  },
};
