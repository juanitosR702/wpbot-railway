import { MinecraftStore } from "../../../infrastructure/storage/minecraftStore.js";

const store = new MinecraftStore();

const WIZARD_SESSIONS = new Map();

const STEPS = [
  { key: "name",     question: "🏷 *Nombre del servidor:*" },
  { key: "ip",       question: "🌐 *IP o dominio del servidor:*" },
  { key: "port",     question: "🔌 *Puerto:* (default: 25565)" },
  { key: "description", question: "📝 *Descripción del servidor:*" },
  { key: "version",  question: "⛏ *Versión de Minecraft:* (ej: 1.20.4)" },
  { key: "image",    question: "🖼 *URL de imagen del servidor:* (opcional, escribe *skip* para omitir)" },
];

function sessionKey(ctx) {
  return `${ctx.sender}:${ctx.phone}`;
}

export const minecraftPlugin = {
  name: "minecraft",
  version: "1.0.0",

  register(router) {
    router.register(async (ctx) => {
      await store.ready();
      if (!ctx.isCommand && !ctx.mediaType && WIZARD_SESSIONS.has(sessionKey(ctx))) {
        const session = WIZARD_SESSIONS.get(sessionKey(ctx));
        const val = ctx.text.trim().toLowerCase();

        if (val === "cancel") {
          WIZARD_SESSIONS.delete(sessionKey(ctx));
          return "❌ Configuración cancelada.";
        }

        const step = STEPS[session.step];

        if (step.key === "port") {
          const port = val || "25565";
          session.data.port = port;
          session.step++;
        } else if (step.key === "image") {
          const image = val === "skip" ? "" : ctx.text.trim();
          session.data.image = image;
          session.step++;
        } else if (!ctx.text.trim()) {
          return "⚠️ Responde con un valor válido o escribe *cancel* para salir.";
        } else {
          session.data[step.key] = ctx.text.trim();
          session.step++;
        }

        if (session.step >= STEPS.length) {
          WIZARD_SESSIONS.delete(sessionKey(ctx));
          store.setServer(ctx.phone, session.data);
          const lines = [
            "*✅ Servidor guardado correctamente*",
            "",
            `🏷 *Nombre:* ${session.data.name}`,
            `🌐 *IP:* ${session.data.ip}`,
            `🔌 *Puerto:* ${session.data.port || "25565"}`,
            `📝 *Descripción:* ${session.data.description}`,
            `⛏ *Versión:* ${session.data.version}`,
          ];
          if (session.data.image) {
            lines.push(`🖼 *Imagen:* ${session.data.image}`);
          }
          return lines.join("\n");
        }

        return STEPS[session.step].question;
      }

      if (!ctx.isCommand) return null;

      if (ctx.command === "setserver") {
        if (WIZARD_SESSIONS.has(sessionKey(ctx))) {
          return "⚠️ Ya tienes una configuración activa. Usa *!cancelserver* para cancelarla.";
        }
        WIZARD_SESSIONS.set(sessionKey(ctx), {
          step: 0,
          data: {},
        });
        return [
          "*⚙️ Configuración de servidor Minecraft*",
          "",
          "Responde a cada pregunta. Envía *cancel* en cualquier momento para salir.",
          "",
          STEPS[0].question,
        ].join("\n");
      }

      if (ctx.command === "cancelserver") {
        if (WIZARD_SESSIONS.has(sessionKey(ctx))) {
          WIZARD_SESSIONS.delete(sessionKey(ctx));
          return "❌ Configuración cancelada.";
        }
        return null;
      }

      if (ctx.command === "server") {
        const server = store.getServer(ctx.phone);
        if (!server) {
          return "❌ No hay un servidor configurado en este grupo. Usa *!setserver* para configurar uno.";
        }
        const lines = [
          "*🎮 Servidor Minecraft*",
          "",
          `🏷 *Nombre:* ${server.name}`,
          `🌐 *IP:* ${server.ip}`,
          `🔌 *Puerto:* ${server.port || "25565"}`,
          `📝 *Descripción:* ${server.description}`,
          `⛏ *Versión:* ${server.version}`,
        ];
        if (server.image) {
          lines.push(`🖼 *Imagen:* ${server.image}`);
        }
        const fecha = new Date(server.setAt).toLocaleString("es-CO", { timeZone: "America/Bogota" });
        lines.push("", `📅 Configurado: ${fecha}`);
        return lines.join("\n");
      }

      return null;
    }, { category: "MINECRAFT", commands: ["setserver", "server", "cancelserver"] });
  },
};
