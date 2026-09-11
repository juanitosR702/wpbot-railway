import { createHash } from "crypto";
import { AntiNsfwStore } from "../../../infrastructure/storage/antiNsfwStore.js";
import { MSG } from "../../../shared/messages.js";
import { jidUser, isAdminParticipant, findParticipant, resolvePhoneJid, cleanJid } from "../../../shared/utils/jid.js";
import { createNsfwDetector, getNsfwConfig } from "../../../infrastructure/nsfw/nsfwDetector.js";

const COMMANDS = ["antinsfw on", "antinsfw off", "antinsfw status", "antinsfw mode", "antinsfw block", "antinsfw unblock", "antinsfw blocklist", "kickwarning", "open"];
const MODES = new Set(["delete", "warn", "kick"]);

function sha256(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}


async function getGroupAuth(ctx, cachedMeta, ownerPolicy) {
  if (!ctx.isGroup) return { ok: false, reason: MSG.SOLO_GRUPOS };

  const metadata = cachedMeta || await ctx.getGroupMetadata().catch(() => null);
  if (!metadata) return { ok: false, reason: "No se pudo obtener metadata del grupo" };
  const sender = findParticipant(metadata, [
    ctx.sender,
    ctx.raw.key?.participant,
    ctx.raw.participant,
    ctx.raw.participantPn,
    ctx.raw.participantLid,
  ]);
  return {
    ok: isAdminParticipant(sender),
    reason: MSG.SOLO_ADMIN,
    metadata,
    botIsAdmin: await ownerPolicy.isBotAdmin(ctx.getGroupMetadata, ctx.botJid, ctx.botLid, metadata),
  };
}

function mediaContentFrom(message = {}) {
  const unwrap = (m) =>
    m?.ephemeralMessage?.message ||
    m?.viewOnceMessageV2?.message ||
    m?.viewOnceMessageV2Extension?.message ||
    m?.documentWithCaptionMessage?.message ||
    m;
  const msg = unwrap(message);

  if (msg.imageMessage) {
    return { mediaType: "image", mimetype: msg.imageMessage.mimetype || "image/jpeg", message };
  }

  if (msg.stickerMessage) {
    return { mediaType: "sticker", mimetype: msg.stickerMessage.mimetype || "image/webp", message };
  }

  if (msg.videoMessage) {
    return { mediaType: "video", mimetype: msg.videoMessage.mimetype || "video/mp4", message };
  }

  if (msg.documentMessage?.mimetype?.startsWith("image/")) {
    return { mediaType: "image", mimetype: msg.documentMessage.mimetype, message };
  }

  if (msg.documentMessage?.mimetype?.startsWith("video/")) {
    return { mediaType: "video", mimetype: msg.documentMessage.mimetype, message };
  }

  return null;
}

function mediaSource(ctx) {
  const media = mediaContentFrom(ctx.raw.message);
  if (!media) return null;
  return { ...media, rawMessage: ctx.raw };
}

async function safeDelete(ctx) {
  const delays = [500, 1000, 2000, 3000, 5000];
  for (const delay of delays) {
    try {
      await ctx.deleteMessage(ctx.raw.key);
      return true;
    } catch (err) {
      const msg = err?.message || "";
      if (!msg.includes("rate-overlimit") && err?.data !== 429) {
        console.warn("[anti_nsfw] No se pudo eliminar mensaje:", msg);
        return false;
      }
      await new Promise(r => setTimeout(r, delay));
    }
  }
  return false;
}

async function safeKick(ctx, target) {
  try {
    await ctx.updateParticipants([target], "remove");
    return true;
  } catch (err) {
    console.warn("[anti_nsfw] No se pudo expulsar usuario:", err?.message || err);
    return false;
  }
}

function makeStatus(ctx, group, detectorConfig) {
  return [
    "*Anti-NSFW* 🔞",
    `Estado: ${group.enabled ? "✅ activado" : "❌ desactivado"}`,
    `Modo: ${group.mode}`,
    `Protección owner: ${group.protectOwner !== false ? "✅ activada" : "❌ desactivada"}`,
    `Proveedor: ${detectorConfig.provider}`,
    `Umbral: ${detectorConfig.threshold}`,
    `Umbral kick: ${group.kickThreshold}`,
  ].join("\n");
}

function fmtLog(ctx, meta) {
  const phone = ctx.raw.key?.participantPn ? cleanJid(ctx.raw.key.participantPn) : ctx.sender;
  let info = `${phone} (${ctx.sender})`;
  if (ctx.isGroup) {
    const name = meta?.subject ? `"${meta.subject}" ` : "";
    info += ` en grupo ${name}(${ctx.phone})`;
  }
  return info;
}

function makeHandler(options = {}) {
  const config = { ...options };
  const store = new AntiNsfwStore();
  const detectorConfig = getNsfwConfig();
  const detector = createNsfwDetector(detectorConfig);
  const ownerPolicy = options.ownerPolicy;

  return async (ctx) => {
    await store.ready();
    const group = store.group(ctx.phone);

    if (ctx.isCommand && ctx.command === "antinsfw") {
      const action = ctx.args?.[0]?.toLowerCase();
      const auth = await getGroupAuth(ctx, null, ownerPolicy);
      if (!auth.ok) return auth.reason;

      if (action === "on") {
        group.enabled = true;
        store.log({ type: "config", group: ctx.phone, by: ctx.sender, enabled: true });
        console.log(`[anti_nsfw] ${fmtLog(ctx, auth.metadata)}: activado`);
        store.save();
        if (detectorConfig.provider === "disabled") {
          return "✅ Anti-NSFW activado, pero falta configurar el proveedor (NSFW_PROVIDER). Consulta el .env.example 📋";
        }
        return `✅ Anti-NSFW activado usando el proveedor: ${detectorConfig.provider}.`;
      }

      if (action === "off") {
        group.enabled = false;
        store.log({ type: "config", group: ctx.phone, by: ctx.sender, enabled: false });
        console.log(`[anti_nsfw] ${fmtLog(ctx, auth.metadata)}: desactivado`);
        store.save();
        return "✅ Anti-NSFW desactivado.";
      }

      if (action === "status") {
        store.log({ type: "status", group: ctx.phone, by: ctx.sender });
        console.log(`[anti_nsfw] ${fmtLog(ctx, auth.metadata)}: status consultado`);
        return makeStatus(ctx, group, detectorConfig);
      }

      if (action === "mode") {
        const mode = ctx.args?.[1]?.toLowerCase();
        if (!MODES.has(mode)) return `Los modos disponibles son: delete, warn o kick 🔧\nUsa ${ctx.prefix}antinsfw mode <modo>.`;
        group.mode = mode;
        store.log({ type: "mode", group: ctx.phone, by: ctx.sender, mode });
        console.log(`[anti_nsfw] ${fmtLog(ctx, auth.metadata)}: modo "${mode}"`);
        store.save();
        return `✅ Modo Anti-NSFW actualizado a: *${mode}*.`;
      }

      if (action === "ow") {
        if (!ctx.isGroup) return MSG.SOLO_GRUPOS;
        const meta = await ctx.getGroupMetadata().catch(() => null);
        if (!ownerPolicy.isCreatorJid(ctx.sender, meta)) return MSG.SOLO_CREADOR;

        const value = ctx.args?.[1]?.toLowerCase();
        if (value !== "on" && value !== "off") return `Usa ${ctx.prefix}antinsfw ow on|off 🔧`;
        group.protectOwner = value === "on";
        store.log({ type: "protectowner", group: ctx.phone, by: ctx.sender, protectOwner: group.protectOwner });
        console.log(`[anti_nsfw] ${fmtLog(ctx, meta)}: protectOwner ${group.protectOwner ? "on" : "off"}`);
        store.save();
        return group.protectOwner
          ? "✅ Protección del owner activada."
          : "✅ Protección del owner desactivada.";
      }

      if (action === "block") {
        const contextInfo = ctx.raw.message?.extendedTextMessage?.contextInfo;
        if (!contextInfo?.quotedMessage) return "Responde a un sticker o imagen para bloquearlo 📎";
        const media = mediaContentFrom(contextInfo.quotedMessage);
        if (!media) return "Solo puedes bloquear stickers, imagenes o videos 📎";
        let buffer;
        try {
          buffer = await ctx.downloadMedia({
            key: {
              remoteJid: ctx.raw.key.remoteJid,
              id: contextInfo.stanzaId,
              fromMe: false,
              participant: contextInfo.participant,
            },
            message: contextInfo.quotedMessage,
          });
        } catch (err) {
          return "No pude descargar el contenido para bloquearlo";
        }
        const hash = sha256(buffer);
        if (group.mediaBlocklist.includes(hash)) return "Ese contenido ya esta bloqueado";
        group.mediaBlocklist.push(hash);
        store.log({ type: "block", group: ctx.phone, by: ctx.sender, hash });
        store.save();
        console.log(`[anti_nsfw] ${fmtLog(ctx, auth.metadata)}: blocklist add ${hash.slice(0, 12)}...`);
        return `✅ Contenido bloqueado (${hash.slice(0, 12)}...)`;
      }

      if (action === "unblock") {
        const hash = ctx.args?.[1]?.toLowerCase();
        if (!hash) return "Indica el hash a desbloquear. Usa !antinsfw blocklist para ver los hashes";
        const idx = group.mediaBlocklist.indexOf(hash);
        if (idx === -1) return "Ese hash no esta en la lista de bloqueados";
        group.mediaBlocklist.splice(idx, 1);
        store.save();
        console.log(`[anti_nsfw] ${fmtLog(ctx, auth.metadata)}: blocklist remove ${hash.slice(0, 12)}...`);
        return `✅ Hash desbloqueado`;
      }

      if (action === "blocklist") {
        const list = group.mediaBlocklist || [];
        if (!list.length) return "No hay contenido bloqueado en este grupo";
        return ["📋 *Contenido bloqueado:*", ...list.map((h, i) => `${i + 1}. ${h.slice(0, 16)}...`)].join("\n");
      }

      return `Opciones: on, off, status, mode, block, unblock, blocklist 🔧\nUsa ${ctx.prefix}antinsfw <opción>.`;
    }

    if (ctx.isCommand && ctx.command === "open") {
      const meta = await ctx.getGroupMetadata().catch(() => null);
      if (!meta) return "No se pudo obtener metadata del grupo";
      const sender = findParticipant(meta, [ctx.sender, ctx.raw.key?.participant, ctx.raw.participant]);
      if (!isAdminParticipant(sender)) return "Solo admins pueden abrir el grupo 🙅";
      await ctx.updateGroupSetting("not_announcement");
      group.closed = false;
      group.consecutiveNsfw = 0;
      group.consecutiveErrors = 0;
      group.consecutiveMedia = 0;
      store.save();
      console.log(`[anti_nsfw] ${fmtLog(ctx, meta)}: grupo REABIERTO`);
      return "✅ Grupo abierto. Los miembros ya pueden enviar mensajes.";
    }

    if (ctx.isCommand && ctx.command === "kickwarning") {
      const meta = await ctx.getGroupMetadata().catch(() => null);
      if (!meta) return "No se pudo obtener metadata del grupo";
      const sender = findParticipant(meta, [ctx.sender, ctx.raw.key?.participant, ctx.raw.participant]);
      if (!isAdminParticipant(sender)) return "Solo admins pueden configurar el umbral 🙅";
      const n = parseInt(ctx.args?.[0], 10);
      if (isNaN(n) || !ctx.args?.[0]) {
        return `El umbral actual es ${group.kickThreshold} infracciones.\nUsa ${ctx.prefix}kickwarning <1-20> para cambiarlo.`;
      }
      if (n < 1 || n > 20) return `Usa ${ctx.prefix}kickwarning <1-20>`;
      store.setKickThreshold(ctx.phone, n);
      console.log(`[anti_nsfw] ${fmtLog(ctx, meta)}: kickThreshold=${n}`);
      return `✅ Umbral de expulsión actualizado a ${n} infracciones.`;
    }

    // blocklist pre-check (runs even when anti-nsfw is disabled)
    if (ctx.isGroup) {
      const preSource = mediaSource(ctx);
      if (preSource) {
        let preBuffer;
        try {
          preBuffer = await ctx.downloadMedia(preSource.rawMessage);
        } catch {}
        if (preBuffer) {
          const preHash = sha256(preBuffer);
          if (group.mediaBlocklist.includes(preHash)) {
            console.log(`[anti_nsfw] ${fmtLog(ctx)}: ${preSource.mediaType} → blocklist pre-delete`);
            store.log({ type: "blocklist-pre-delete", group: ctx.phone, by: ctx.sender, hash: preHash });
            await safeDelete(ctx).catch(() => {});
            return null;
          }
        }
      }
    }

    if (!ctx.isGroup || !group.enabled) return null;
    if (group.closed) return null;

    const source = mediaSource(ctx);
    if (!source) return null;

    const spamCount = store.incrementConsecutiveMedia(ctx.phone, Date.now());
    if (spamCount > 5) {
      await ctx.updateGroupSetting("announcement").catch(() => {});
      group.closed = true;
      store.save();
      console.log(`[anti_nsfw] ${fmtLog(ctx)}: grupo CERRADO por spam (${spamCount})`);
      store.log({ type: "auto-close", group: ctx.phone, reason: `spam (${spamCount})` });
      ctx.restart().catch(() => {});
      return null;
    }

    const meta = await ctx.getGroupMetadata().catch(() => null);
    if (!meta) {
      const errCount = store.incrementConsecutiveErrors(ctx.phone);
      if (errCount > 0 && !group.closed) {
        await ctx.updateGroupSetting("announcement").catch(() => {});
        group.closed = true;
        store.save();
        console.log(`[anti_nsfw] ${fmtLog(ctx, meta)}: grupo CERRADO por errores (${errCount})`);
        store.log({ type: "auto-close", group: ctx.phone, reason: `errores (${errCount})` });
        ctx.restart().catch(() => {});
      }
      return null;
    }
    if (group.protectOwner !== false && ownerPolicy.isProtectedJid(ctx.sender, ctx, meta)) {
      console.log(`[anti_nsfw] ${fmtLog(ctx, meta)}: omitido por protectOwner`);
      return null;
    }

    let buffer;
    try {
      buffer = await ctx.downloadMedia(source.rawMessage);
    } catch (err) {
      store.log({ type: "download-error", group: ctx.phone, by: ctx.sender, error: err?.message || String(err) });
      console.log(`[anti_nsfw] ${fmtLog(ctx, meta)}: error descarga ${err?.message || ""}`);
      return null;
    }

    const mediaHash = sha256(buffer);
    let result;

    if (group.mediaBlocklist.includes(mediaHash)) {
      result = { nsfw: true, score: 1.0, reason: "blocklist", provider: "blocklist", details: {} };
      console.log(`[anti_nsfw] ${fmtLog(ctx, meta)}: ${source.mediaType} → blocklist score=1.0 nsfw=true [blocked]`);
    } else {
      result = await detector.analyze(buffer, {
        mimeType: source.mimetype,
        filename: `${source.mediaType}.${source.mimetype.split("/")[1] || "bin"}`,
      });
    }

    store.log({
      type: "scan",
      group: ctx.phone,
      by: ctx.sender,
      mediaType: source.mediaType,
      provider: result.provider,
      score: result.score,
      nsfw: result.nsfw,
      reason: result.reason,
      skipped: result.skipped,
      error: result.error,
      cached: result.cached,
    });

    const d = result.details || {};
    const bloodRatio = d.bloodRatio || 0;
    const fleshRatio = d.fleshRatio || 0;
    const reason = (result.reason || "").toLowerCase();
    let typeTag = "";
    if (bloodRatio > fleshRatio && bloodRatio > 0) typeTag = " [gore]";
    else if (fleshRatio > 0) typeTag = " [porn]";
    else if (/sangre|gore|blood|herida|violen|dead|kill|murder|wound/i.test(reason)) typeTag = " [gore]";
    else if (/sexual|desnud|porn|nude|sex|erot|pornhub|xxx|explicit/i.test(reason)) typeTag = " [porn]";

    if (result.provider !== "blocklist") {
      console.log(`[anti_nsfw] ${fmtLog(ctx, meta)}: ${source.mediaType} → ${result.provider} score=${result.score} nsfw=${result.nsfw}${typeTag}${result.error ? ` err=${result.error}` : ""}${result.skipped ? " SKIPPED" : ""}`);
    }

    if (!result.nsfw) {
      store.resetConsecutiveMedia(ctx.phone);
      store.resetConsecutiveNsfw(ctx.phone);
      store.resetConsecutiveErrors(ctx.phone);
      return null;
    }

    if (group.closed) return null;

    const nsfwCount = store.incrementConsecutiveNsfw(ctx.phone);
    if (nsfwCount > 9) {
      await ctx.updateGroupSetting("announcement").catch(() => {});
      group.closed = true;
      store.save();
      console.log(`[anti_nsfw] ${fmtLog(ctx, meta)}: grupo CERRADO por flood NSFW (${nsfwCount})`);
      store.log({ type: "auto-close", group: ctx.phone, reason: `flood NSFW (${nsfwCount})` });
      ctx.restart().catch(() => {});
      return null;
    }

    const auth = await getGroupAuth(ctx, meta, ownerPolicy);
    const infractions = store.addInfraction(ctx.phone, ctx.sender);
    const nsfwPhone = resolvePhoneJid(ctx.sender, meta);
    const mention = `@${jidUser(nsfwPhone)}`;
    const m = (text) => ({ text, mentions: [nsfwPhone] });

    if (group.mode === "delete") {
      if (result.provider === "blocklist") {
        await safeDelete(ctx).catch(() => {});
        store.log({ type: "delete", group: ctx.phone, target: ctx.sender, ok: true, score: 1 });
        return null;
      }
      if (!auth.botIsAdmin) return "Detecté contenido inapropiado, pero necesito ser admin del grupo para eliminarlo 🤖";
      const deleted = await safeDelete(ctx);
      store.log({ type: "delete", group: ctx.phone, target: ctx.sender, ok: deleted, score: result.score });
      if (deleted) {
        store.resetConsecutiveErrors(ctx.phone);
        console.log(`[anti_nsfw] ${fmtLog(ctx, meta)}: mensaje ELIMINADO score=${result.score}`);
        return m(`⚠️ ${mention} contenido inapropiado detectado y eliminado.`);
      }
      const errCountDel = store.incrementConsecutiveErrors(ctx.phone);
      if (errCountDel > 0) {
        await ctx.updateGroupSetting("announcement").catch(() => {});
        group.closed = true;
        store.save();
        console.log(`[anti_nsfw] ${fmtLog(ctx, meta)}: grupo CERRADO por errores (${errCountDel})`);
        store.log({ type: "auto-close", group: ctx.phone, reason: `errores (${errCountDel})` });
        ctx.restart().catch(() => {});
        return null;
      }
      return "Detecté contenido inapropiado pero no pude eliminarlo. Verifica los permisos del bot ⚠️";
    }

    if (group.mode === "kick") {
      if (infractions < group.kickThreshold) {
        console.log(`[anti_nsfw] ${fmtLog(ctx, meta)}: advertencia ${infractions}/${group.kickThreshold}`);
        return m(`⚠️ ${mention} advertencia por contenido inapropiado (${infractions}/${group.kickThreshold}).`);
      }

      if (!auth.botIsAdmin) return m(`⚠️ ${mention} alcanzó el límite de advertencias, pero necesito ser admin para expulsar 🤖`);
      await ctx.sendMessage({ text: `🫵 ${mention} se lo gano oyo.`, mentions: [nsfwPhone] }).catch(() => {});
      const kicked = await safeKick(ctx, ctx.sender);
      store.log({ type: "kick", group: ctx.phone, target: ctx.sender, ok: kicked, score: result.score });
      console.log(`[anti_nsfw] ${fmtLog(ctx, meta)}: usuario EXPULSADO score=${result.score}`);
      return kicked
        ? null
        : m(`⚠️ ${mention} no pude expulsarlo. Verifica los permisos del bot.`);
    }

    if (infractions >= group.kickThreshold) {
      if (!auth.botIsAdmin) return m(`⚠️ ${mention} alcanzó ${group.kickThreshold} infracciones.`);
      await ctx.sendMessage({ text: `🫵 ${mention} se lo gano oyo por superar ${group.kickThreshold} infracciones.`, mentions: [nsfwPhone] }).catch(() => {});
      const kicked = await safeKick(ctx, ctx.sender);
      store.log({ type: "kick", group: ctx.phone, target: ctx.sender, ok: kicked, score: result.score });
      console.log(`[anti_nsfw] ${fmtLog(ctx, meta)}: usuario EXPULSADO por superar ${group.kickThreshold} infracciones`);
      return kicked
        ? null
        : m(`⚠️ ${mention} alcanzó ${group.kickThreshold} infracciones pero no pude expulsarlo.`);
    }
    return m(`⚠️ ${mention} advertencia por contenido inapropiado (${infractions}/${group.kickThreshold}).`);
  };
}

export const antiNsfwPlugin = {
  name: "anti_nsfw",
  version: "1.0.0",
  register(router, options = {}) {
    router.register(makeHandler(options), {
      category: "ANTI-NSFW",
      commands: COMMANDS,
    });
  },
};
