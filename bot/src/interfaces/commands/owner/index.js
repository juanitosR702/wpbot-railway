import { MSG } from "../../../shared/messages.js";
import { jidFromNumber, jidUser } from "../../../shared/utils/jid.js";

const COMMANDS = [
  "creador",
  "owner",
  "ownerid",
  "ownerprotect",
  "protect",
  "proteger",
  "unprotect",
  "desproteger",
  "protected",
  "protegidos",
  "botuptime",
  "botoff",
  "apagarbot",
  "salirgrupo",
  "leavegroup",
];

function formatDuration(ms) {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `${hours}h ${minutes}m ${rest}s`;
}

async function isCreator(ctx, ownerPolicy) {
  const metadata = ctx.isGroup ? await ctx.getGroupMetadata().catch(() => null) : null;
  return ownerPolicy.isCreatorJid(ctx.sender, metadata);
}

function senderIds(ctx) {
  return [
    ctx.sender,
    ctx.raw.key?.participant,
    ctx.raw.participant,
    ctx.raw.participantPn,
    ctx.raw.participantLid,
    ctx.botJid,
    ctx.botLid,
  ].filter(Boolean);
}

function targetFrom(ctx) {
  const info = ctx.raw.message?.extendedTextMessage?.contextInfo;
  const mentioned = info?.mentionedJid?.[0];
  const quoted = info?.participant;
  const arg = ctx.args?.[0];
  return mentioned || quoted || (arg?.includes("@") ? arg : jidFromNumber(arg));
}

function mentionedJids(ctx) {
  return ctx.raw.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
}

async function mentionsCreator(ctx, ownerPolicy) {
  const metadata = ctx.isGroup ? await ctx.getGroupMetadata().catch(() => null) : null;
  return mentionedJids(ctx).some((jid) => ownerPolicy.isCreatorJid(jid, metadata));
}

function makeHandler(startedAt, deps) {
  const { ownerPolicy, ownerRepository } = deps;
  return async (ctx) => {
    if (!ctx.isCommand && ctx.isGroup && (await mentionsCreator(ctx, ownerPolicy)) && !(await isCreator(ctx, ownerPolicy))) {
      return "Ey, no molesten a mi creador 😅 Si necesitas ayuda, usa el comando help.";
    }

    if (!ctx.isCommand || !COMMANDS.includes(ctx.command)) return null;

    if (ctx.command === "creador" || ctx.command === "owner") {
      return "Mi creador es *Esquina* 🔐";
    }

    if (!(await isCreator(ctx, ownerPolicy))) return MSG.SOLO_CREADOR;

    if (ctx.command === "ownerid") {
      return ["*IDs detectados* 🔍", ...senderIds(ctx).map((jid) => `• ${jid}`)].join("\n");
    }

    if (ctx.command === "ownerprotect") {
      const extra = ownerRepository.extraProtectedEntries();
      return [
        "*Sistema de Protección* 🛡️",
        "Los usuarios protegidos no pueden ser afectados por mute, blacklist, warn, kick, antilink ni Anti-NSFW.",
        `Creador: ${ownerRepository.creatorNumbers().join(", ")}`,
        `Bot: ${ownerRepository.botNumbers().join(", ")}`,
        `Extras: ${[...extra.numbers, ...extra.jids].join(", ") || "ninguno"}`,
      ].join("\n");
    }

    if (ctx.command === "protect" || ctx.command === "proteger") {
      const target = targetFrom(ctx);
      if (!target) return `Usa ${ctx.prefix}${ctx.command} <numero> o menciona/responde a alguien 👤`;

      ownerRepository.addProtectedTarget(target);
      return { text: `✅ @${jidUser(target) || target} ahora está protegido 🛡️`, mentions: [target] };
    }

    if (ctx.command === "unprotect" || ctx.command === "desproteger") {
      const target = targetFrom(ctx);
      if (!target) return `Usa ${ctx.prefix}${ctx.command} <numero> o menciona/responde a alguien 👤`;

      ownerRepository.removeProtectedTarget(target);
      return { text: `✅ @${jidUser(target) || target} ya no está protegido.`, mentions: [target] };
    }

    if (ctx.command === "protected" || ctx.command === "protegidos") {
      const extra = ownerRepository.extraProtectedEntries();
      return [
        "*Usuarios Protegidos* 🛡️",
        `Creador: ${ownerRepository.creatorNumbers().join(", ")}`,
        `Bot: ${ownerRepository.botNumbers().join(", ")}`,
        `Extras: ${[...extra.numbers, ...extra.jids].join(", ") || "ninguno"}`,
      ].join("\n");
    }

    if (ctx.command === "botuptime") {
      return `⏱️ Uptime: ${formatDuration(Date.now() - startedAt)}.`;
    }

    if (ctx.command === "salirgrupo" || ctx.command === "leavegroup") {
      if (!ctx.isGroup) return "Este comando solo funciona en grupos 📍";
      await ctx.sendMessage({ text: "Me retiro del grupo. ¡Hasta luego! 👋" });
      await ctx.leaveGroup();
      return null;
    }

    if (ctx.command === "botoff" || ctx.command === "apagarbot") {
      await ctx.sendMessage({ text: "Apagando el bot... ¡Hasta luego! 👋" });
      setTimeout(() => ctx.shutdown(), 500);
      return null;
    }

    return null;
  };
}

export const ownerPlugin = {
  name: "owner",
  version: "1.0.0",
  register(router, options = {}) {
    router.register(makeHandler(Date.now(), {
      ownerPolicy: options.ownerPolicy,
      ownerRepository: options.ownerRepository,
    }), {
      category: "CREADOR",
      commands: COMMANDS,
    });
  },
};
