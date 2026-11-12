// Ejecutor de comandos para la IA.
//
// La IA NUNCA ejecuta lógica propia: traduce a un comando y lo reinyecta en el
// Router como si el usuario lo hubiera escrito. Así se aplican todas las
// validaciones existentes (admin del grupo, bot admin, protegidos, creador,
// grupo silenciado...). Aquí solo hay una pre-validación por nivel para dar un
// error claro y evitar que el modelo insista.

import { cleanJid, findParticipant, isAdminParticipant, sameParticipant } from "../../../shared/utils/jid.js";
import { LEVEL } from "./commandCatalog.js";

const MAX_ARGS_CHARS = 300;

function senderIds(ctx) {
  return [
    ctx.sender,
    ctx.raw?.key?.participant,
    ctx.raw?.participant,
    ctx.raw?.participantPn,
    ctx.raw?.participantLid,
  ].filter(Boolean);
}

function contextInfo(ctx) {
  const message = ctx.raw?.message || {};
  return (
    message.extendedTextMessage?.contextInfo ||
    message.imageMessage?.contextInfo ||
    message.videoMessage?.contextInfo ||
    message.documentMessage?.contextInfo ||
    null
  );
}

function hasTarget(ctx, args) {
  const info = contextInfo(ctx);
  return Boolean(info?.mentionedJid?.length || info?.participant || (args || []).length);
}

export function createCommandRunner({ router, ownerPolicy, catalog, botNumberJids = () => [] }) {
  async function groupMetadata(ctx) {
    if (!ctx.isGroup || typeof ctx.getGroupMetadata !== "function") return null;
    try {
      return await ctx.getGroupMetadata();
    } catch {
      return null;
    }
  }

  function isSenderAdmin(ctx, metadata) {
    const participant = findParticipant(metadata, senderIds(ctx));
    return isAdminParticipant(participant);
  }

  async function permissionsFor(ctx) {
    const metadata = await groupMetadata(ctx);
    const creator = ownerPolicy ? ownerPolicy.isCreatorJid(ctx.sender, metadata) : false;
    const admin = metadata ? isSenderAdmin(ctx, metadata) : false;
    return { metadata, creator, admin };
  }

  async function checkPermission(entry, ctx) {
    if (entry.groupOnly && !ctx.isGroup) {
      return "Ese comando solo funciona dentro de un grupo.";
    }

    if (entry.level === LEVEL.USER) return null;

    const perms = await permissionsFor(ctx);

    if (entry.level === LEVEL.CREATOR) {
      return perms.creator ? null : "Solo el creador del bot puede usar ese comando.";
    }

    // Nivel admin: sirve ser admin del grupo o el creador del bot.
    if (perms.creator) return null;
    if (perms.admin) return null;
    return "Solo los administradores del grupo pueden usar ese comando.";
  }

  function buildSyntheticMessage(ctx, entry, args) {
    const original = contextInfo(ctx);
    let info = null;

    if (original) {
      info = { ...original };
      // Quitamos al propio bot de las menciones: si fue mencionado antes que
      // el objetivo (ej. "@bot expulsa a @juan"), los comandos que leen
      // mentionedJid[0] apuntarian al bot.
      if (Array.isArray(info.mentionedJid)) {
        const ids = [ctx.botJid, ctx.botLid, ...botNumberJids()].filter(Boolean);
        const filtered = info.mentionedJid.filter(
          (mentioned) => !ids.some((id) => sameParticipant(mentioned, id)),
        );
        if (filtered.length) info.mentionedJid = filtered;
        else delete info.mentionedJid;
      }
    }

    const argText = (args || [])
      .join(" ")
      .replace(/[\r\n]+/g, " ")
      .slice(0, MAX_ARGS_CHARS)
      .trim();
    const text = `!${entry.name}${argText ? ` ${argText}` : ""}`;

    return {
      ...ctx.raw,
      key: { ...(ctx.raw?.key || {}), fromMe: false },
      message: {
        extendedTextMessage: {
          text,
          ...(info ? { contextInfo: info } : {}),
        },
      },
      __aiSynthetic: true,
    };
  }

  /**
   * Ejecuta un comando ya validado.
   * @returns {Promise<{ok: boolean, command?: string, reply?: any, error?: string}>}
   */
  async function run(name, args, ctx) {
    if (ctx.raw?.__aiSynthetic) {
      return { ok: false, error: "No se pueden encadenar comandos desde la IA." };
    }

    const entry = catalog.get(name);
    if (!entry) {
      return { ok: false, error: `El comando "${name}" no existe.` };
    }

    const denied = await checkPermission(entry, ctx);
    if (denied) {
      return { ok: false, command: entry.name, error: denied, denied: true };
    }

    if (entry.needsTarget && !hasTarget(ctx, args)) {
      return {
        ok: false,
        command: entry.name,
        error: "Falta el objetivo: menciona a la persona (@usuario), responde a su mensaje o pasa su número.",
      };
    }

    const synthetic = buildSyntheticMessage(ctx, entry, args);
    let reply = null;
    try {
      reply = await router.route(synthetic, ctx.services || {});
    } catch (err) {
      return { ok: false, command: entry.name, error: `Error ejecutando el comando: ${err?.message || err}` };
    }

    if (reply === null || reply === undefined) {
      // Algunos comandos responden por su cuenta (ctx.sendMessage) y devuelven
      // null. No es un fallo: solo no hay texto que reenviar.
      return { ok: true, command: entry.name, reply: null, silent: true, entry };
    }

    return { ok: true, command: entry.name, reply, entry };
  }

  return {
    run,
    checkPermission,
    permissionsFor,
    isSenderAdmin,
    senderIds,
    hasTarget,
    buildSyntheticMessage,
    contextInfo,
    cleanJid,
    sameParticipant,
  };
}
