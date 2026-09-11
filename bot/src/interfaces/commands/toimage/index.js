import sharp from "sharp";

const COMMANDS = new Set(["toimage", "img"]);

function stickerSource(ctx) {
  if (ctx.raw.message?.stickerMessage) {
    return { message: ctx.raw };
  }

  const info = ctx.raw.message?.extendedTextMessage?.contextInfo;
  if (info?.quotedMessage?.stickerMessage) {
    return {
      message: {
        key: {
          remoteJid: info.remoteJid || ctx.phone,
          participant: info.participant,
          id: info.stanzaId,
        },
        message: info.quotedMessage,
      },
    };
  }

  return null;
}

function makeHandler() {
  return async (ctx) => {
    if (!ctx.isCommand || !COMMANDS.has(ctx.command)) return null;

    const source = stickerSource(ctx);
    if (!source) return "Enviá o respondé a un sticker con `!toimage`";

    try {
      const webp = await ctx.downloadMedia(source.message);
      const meta = await sharp(webp).metadata();
      const animado = (meta.pages || 1) > 1;

      const png = animado
        ? await sharp(webp, { page: 0 }).png().toBuffer()
        : await sharp(webp).png().toBuffer();

      await ctx.sendMessage({
        image: png,
        mimetype: "image/png",
        caption: animado
          ? "aca tienes tu imagen (primer frame, era animado)"
          : "aca tienes tu imagen",
      });

      return null;
    } catch (err) {
      console.error("[toimage] Error:", err);
      return `No pude convertir el sticker 😕`;
    }
  };
}

export const toImagePlugin = {
  name: "toimage",
  version: "1.0.0",
  register(router) {
    router.register(makeHandler(), {
      category: "STICKERS",
      commands: [...COMMANDS],
    });
  },
};