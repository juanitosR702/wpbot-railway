import { findParticipant, isAdminParticipant, participantIds, jidUser } from "./jid.js";
import { hasFilters, pickExcuse, reviewFicha } from "./lobbyFilters.js";
import { renderWelcomeTemplate } from "./welcomeTemplate.js";

// Flujo automático lobby -> general.
//
// Toda la E/S entra por `deps` (Baileys, Mongo y el router se inyectan desde
// `app/bootstrap.js`), así que este módulo se puede testear sin WhatsApp ni
// base de datos. Nada de acá importa `infrastructure/`.

export const LOBBY_DEFAULTS = {
  welcomeDelayMs: 5000,
  pollMs: 60000,
  revokeCooldownMs: 15000,
  messageGapMs: 800,
};

export const LOBBY_TEXTS = {
  welcome: [
    "👋 ¡Bienvenido/a @user a *{group}*!",
    "",
    "Para pasar al grupo general primero llena tu ficha de ingreso.",
    "Te la envío ahora 👇",
  ].join("\n"),
  needsFicha: [
    "⛔ Todavía no puedo aceptarte en el grupo general.",
    "",
    "Primero llena tu ficha en el grupo lobby. Cuando la envíes te paso el link por aquí.",
  ].join("\n"),
};

export function fichaSentText(link) {
  return [
    "✅ *Ficha recibida.*",
    "",
    "Para entrar al grupo general usa este link:",
    link,
    "",
    "Tu solicitud la acepto yo automáticamente; en cuanto entres te saco del lobby.",
  ].join("\n");
}

export function inviteUrl(code) {
  const value = String(code || "").trim();
  if (!value) return "";
  return /^https?:/i.test(value) ? value : `https://chat.whatsapp.com/${value}`;
}

// Acepta "123@g.us", "123" o el JID completo y devuelve siempre JID de grupo.
export function groupJid(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (raw.endsWith("@g.us")) return raw;
  const digits = raw.split("@")[0].replace(/\D/g, "");
  return digits ? `${digits}@g.us` : "";
}

// El mismo remitente puede venir como teléfono o como LID (y cambiar entre
// mensajes), así que se compara por todas sus variantes.
function identityKeys(jid, metadata) {
  const keys = new Set();
  const user = jidUser(jid);
  if (user) keys.add(user);
  const participant = findParticipant(metadata, [jid]);
  for (const id of participantIds(participant || {})) {
    const key = jidUser(id);
    if (key) keys.add(key);
  }
  return [...keys];
}

function displayJid(jid, metadata) {
  const participant = findParticipant(metadata, [jid]);
  return participant?.id || jid;
}

// Dueño del bot, números del bot, lista de protegidos y admins de cualquiera de
// los dos grupos quedan fuera del flujo: ni saludo, ni ficha, ni link, ni kick.
export function isExemptParticipant(jid, { ownerPolicy, metadataList = [], botJid, botLid } = {}) {
  const metas = metadataList.filter(Boolean);
  try {
    if (ownerPolicy?.isProtectedJid?.(jid, { botJid, botLid }, metas[0] || null)) return true;
  } catch {
    // Política no disponible (tests); se sigue con la comprobación de admin.
  }
  return metas.some((metadata) => isAdminParticipant(findParticipant(metadata, [jid])));
}

export function createLobbyFlow(deps = {}) {
  const {
    store,
    ownerPolicy,
    sendMessage,
    getGroupMetadata,
    approve,
    reject,
    listRequests,
    removeParticipants,
    inviteCode,
    revokeInvite,
    startFicha,
    delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now = () => Date.now(),
    logger = console,
    botJid = () => undefined,
    botLid = () => undefined,
    revokeCooldownMs = LOBBY_DEFAULTS.revokeCooldownMs,
    messageGapMs = LOBBY_DEFAULTS.messageGapMs,
  } = deps;

  function config() {
    if (!store?.config) return null;
    const cfg = store.config();
    if (!cfg?.lobbyJid || !cfg?.generalJid) return cfg; // incompleto: los handlers lo cortan
    return cfg;
  }

  function enabledConfig() {
    const cfg = config();
    if (!cfg || !cfg.enabled || !cfg.lobbyJid || !cfg.generalJid) return null;
    return cfg;
  }

  async function save() {
    try {
      await store?.save?.();
    } catch (err) {
      logger?.warn?.("[lobby] no se pudo guardar estado:", err?.message || err);
    }
  }

  async function safeMetadata(jid) {
    if (!jid) return null;
    try {
      return (await getGroupMetadata?.(jid)) || null;
    } catch {
      return null;
    }
  }

  function exempt(jid, metas) {
    return isExemptParticipant(jid, {
      ownerPolicy,
      metadataList: metas,
      botJid: botJid(),
      botLid: botLid(),
    });
  }

  function hasSubmitted(jid, metadata) {
    return identityKeys(jid, metadata).some((key) => store?.wasSubmitted?.(key));
  }

  function markSubmitted(jid, metadata) {
    for (const key of identityKeys(jid, metadata)) store?.markSubmitted?.(key);
  }

  function wasGreeted(jid, metadata) {
    return identityKeys(jid, metadata).some((key) => store?.wasGreeted?.(key));
  }

  function markGreeted(jid, metadata) {
    for (const key of identityKeys(jid, metadata)) store?.markGreeted?.(key);
  }

  async function ensureGeneralLink() {
    const cfg = config();
    if (!cfg?.generalJid) return "";
    if (cfg.generalCode) return inviteUrl(cfg.generalCode);
    try {
      const code = await inviteCode?.(cfg.generalJid);
      if (!code) return "";
      store?.setGeneralCode?.(code);
      await save();
      return inviteUrl(code);
    } catch (err) {
      logger?.warn?.("[lobby] no pude obtener el link del general:", err?.message || err);
      return "";
    }
  }

  // Restablece el link para que el que ya se usó no sirva a nadie más.
  async function rotateGeneralLink({ force = false } = {}) {
    const cfg = config();
    if (!cfg?.generalJid) return "";
    if (!force && cfg.generalCodeAt && now() - cfg.generalCodeAt < revokeCooldownMs) {
      return inviteUrl(cfg.generalCode);
    }
    try {
      const result = await revokeInvite?.(cfg.generalJid);
      const code = typeof result === "string" ? result : result?.code || result?.invite || "";
      if (code) {
        store?.setGeneralCode?.(code, now());
        await save();
        logger?.log?.(`[lobby] link del general restablecido (${cfg.generalJid}).`);
        return inviteUrl(code);
      }
    } catch (err) {
      logger?.warn?.("[lobby] no pude restablecer el link del general:", err?.message || err);
    }
    return ensureGeneralLink();
  }

  async function approveIn(jid, participant) {
    await approve?.(jid, [participant]);
  }

  async function handleJoinRequest(update = {}) {
    const cfg = enabledConfig();
    if (!cfg) return { handled: false, reason: "sin-configurar" };
    if (update.action && update.action !== "created") return { handled: false, reason: "accion-ignorada" };

    const group = String(update.id || "");
    const participant = update.participant;
    if (!participant) return { handled: false, reason: "sin-participante" };

    if (group === cfg.lobbyJid) {
      try {
        await approveIn(group, participant);
        logger?.log?.(`[lobby] solicitud aprobada en el lobby: ${participant}`);
        return { handled: true, approved: true, group: "lobby" };
      } catch (err) {
        logger?.error?.("[lobby] no pude aprobar en el lobby:", err?.message || err);
        return { handled: true, approved: false, group: "lobby", error: err?.message };
      }
    }

    if (group === cfg.generalJid) {
      const [generalMeta, lobbyMeta] = await Promise.all([
        safeMetadata(group),
        safeMetadata(cfg.lobbyJid),
      ]);

      if (exempt(participant, [generalMeta, lobbyMeta]) || hasSubmitted(participant, generalMeta)) {
        try {
          await approveIn(group, participant);
          logger?.log?.(`[lobby] solicitud aprobada en general: ${participant}`);
          return { handled: true, approved: true, group: "general" };
        } catch (err) {
          logger?.error?.("[lobby] no pude aprobar en general:", err?.message || err);
          return { handled: true, approved: false, group: "general", error: err?.message };
        }
      }

      // Sin ficha: se rechaza la entrada y se avisa por privado. Con filtros
      // activos el aviso es la misma excusa creíble: para la persona "no envió
      // ficha" y "la ficha no cumple" deben verse igual.
      try {
        await reject?.(group, [participant]);
        logger?.log?.(`[lobby] solicitud rechazada en general (sin ficha): ${participant}`);
      } catch (err) {
        logger?.warn?.("[lobby] no pude rechazar en general:", err?.message || err);
      }
      const denial = hasFilters(cfg) ? pickExcuse(cfg.excuse, participant) : LOBBY_TEXTS.needsFicha;
      await notifyPrivately(participant, generalMeta, denial);
      return { handled: true, approved: false, group: "general", reason: "sin-ficha" };
    }

    return { handled: false, reason: "grupo-ajeno" };
  }

  async function handleParticipantsUpdate(update = {}) {
    const cfg = enabledConfig();
    if (!cfg) return { handled: false, reason: "sin-configurar" };
    if (update.action !== "add") return { handled: false, reason: "accion-ignorada" };

    const group = String(update.id || "");
    const participants = (update.participants || []).filter(Boolean);
    if (!participants.length) return { handled: false, reason: "sin-participantes" };

    if (group === cfg.lobbyJid) {
      await welcomeNewcomers(cfg, participants);
      return { handled: true, group: "lobby", greeted: participants.length };
    }

    if (group === cfg.generalJid) {
      await removeFromLobby(cfg, participants);
      const link = await rotateGeneralLink();
      return { handled: true, group: "general", link };
    }

    return { handled: false, reason: "grupo-ajeno" };
  }

  async function welcomeNewcomers(cfg, participants) {
    const generalMeta = await safeMetadata(cfg.generalJid);

    for (const participant of participants) {
      const initialMeta = await safeMetadata(cfg.lobbyJid);
      if (exempt(participant, [initialMeta, generalMeta])) {
        logger?.log?.(`[lobby] exento del flujo: ${participant}`);
        continue;
      }
      if (wasGreeted(participant, initialMeta)) continue;

      // La demora es el arreglo del "no ven la bienvenida": WhatsApp todavía
      // no terminó de sincronizar el grupo en el cliente del recién llegado.
      await delay(Math.max(0, Number(cfg.welcomeDelayMs) || 0));

      const metadata = await safeMetadata(cfg.lobbyJid);
      if (metadata?.participants?.length && !findParticipant(metadata, [participant])) {
        logger?.log?.(`[lobby] ya no está en el lobby, no saludo: ${participant}`);
        continue;
      }

      const target = displayJid(participant, metadata);
      const user = `@${jidUser(target)}`;
      const text = renderWelcomeTemplate(LOBBY_TEXTS.welcome, {
        user,
        group: metadata?.subject || "el grupo",
        count: metadata?.participants?.length,
      });

      try {
        await sendMessage?.(cfg.lobbyJid, { text, mentions: [target] });
        markGreeted(participant, metadata);
        await save();
      } catch (err) {
        logger?.warn?.("[lobby] no pude saludar:", err?.message || err);
        continue;
      }

      if (Number(messageGapMs) > 0) await delay(Number(messageGapMs));

      try {
        await startFicha?.(cfg.lobbyJid, target);
      } catch (err) {
        logger?.warn?.("[lobby] no pude iniciar la ficha:", err?.message || err);
      }
    }
  }

  async function removeFromLobby(cfg, participants) {
    const lobbyMeta = await safeMetadata(cfg.lobbyJid);
    const generalMeta = await safeMetadata(cfg.generalJid);

    for (const participant of participants) {
      if (exempt(participant, [generalMeta, lobbyMeta])) continue;
      const entry = findParticipant(lobbyMeta, [participant]);
      if (!entry && lobbyMeta?.participants?.length) continue; // no está en el lobby
      const target = entry?.id || participant;
      try {
        await removeParticipants?.(cfg.lobbyJid, [target]);
        logger?.log?.(`[lobby] expulsado del lobby por entrar a general: ${target}`);
      } catch (err) {
        logger?.warn?.("[lobby] no pude expulsar del lobby:", err?.message || err);
      }
    }
  }

  async function notifyPrivately(jid, metadata, text) {
    const target = displayJid(jid, metadata);
    try {
      await sendMessage?.(target, { text });
      return true;
    } catch (err) {
      logger?.warn?.("[lobby] no pude escribir por privado:", err?.message || err);
      return false;
    }
  }

  // Se llama cuando una ficha termina de enviarse. Devuelve el texto extra que
  // el plugin de fichas añade a su respuesta (o "" si no aplica).
  async function onFichaSubmitted(ctx = {}, info = {}) {
    const cfg = config();
    if (!cfg?.enabled || !cfg?.lobbyJid || !cfg?.generalJid) return "";
    const group = `${ctx.phone || ""}`.includes("@g.us") ? ctx.phone : `${ctx.phone || ""}@g.us`;
    if (group !== cfg.lobbyJid) return "";

    const metadata = await safeMetadata(cfg.lobbyJid);
    if (exempt(ctx.sender, [metadata, await safeMetadata(cfg.generalJid)])) return "";

    // Filtros de admisión (edad, país, iniciales). El rechazo se decide aquí y
    // nunca se marca `submitted`, así que la solicitud al general también se
    // rechaza si lo intenta después.
    const verdict = reviewFicha(info?.session?.form, info?.session?.values, cfg);
    if (verdict.warnings.length) {
      logger?.warn?.(`[lobby] aviso de filtros: ${verdict.warnings.join(" | ")}`);
    }
    if (!verdict.ok) {
      logger?.log?.(`[lobby] rechazo ${ctx.sender}: ${verdict.reasons.join(", ") || "revisión"}`);
      await annotateFicha(info?.store, ctx, verdict);
      // Excusa creíble: no revela el motivo real, así que no puede corregir sus
      // datos y reintentar.
      return pickExcuse(cfg.excuse, ctx.sender || "");
    }

    markSubmitted(ctx.sender, metadata);
    await save();

    const link = await ensureGeneralLink();
    const text = link
      ? fichaSentText(link)
      : [
          "✅ *Ficha recibida.*",
          "",
          "Un admin te pasará el link del grupo general.",
        ].join("\n");

    const sent = await notifyPrivately(ctx.sender, metadata, text);
    return sent
      ? "📩 Te envié el link del grupo general por privado."
      : "⚠️ No pude escribirte por privado. Escríbeme por aquí y te paso el link del general.";
  }

  // Deja rastro en el grupo de fichas para que los admins vean por qué no pasó
  // (la persona rechazada no está ahí y nunca ve este mensaje).
  async function annotateFicha(fichaStore, ctx, verdict) {
    let destination = "";
    try {
      destination = fichaStore?.destination?.() || "";
    } catch {
      destination = "";
    }
    if (!destination) return;

    const reasons = verdict.reasons.join(", ") || "revisión";
    try {
      await sendMessage?.(destination, {
        text: `🚫 _No cumple los filtros: ${reasons}_`,
        mentions: ctx.sender ? [ctx.sender] : [],
      });
    } catch (err) {
      logger?.warn?.("[lobby] no pude avisar del rechazo al grupo de fichas:", err?.message || err);
    }
  }

  // Repaso de solicitudes pendientes (el bot puede estar dormido cuando llegan).
  async function sync() {
    const cfg = enabledConfig();
    if (!cfg) return { handled: false, reason: "sin-configurar" };

    const results = [];
    for (const group of [cfg.lobbyJid, cfg.generalJid]) {
      let pending = [];
      try {
        pending = (await listRequests?.(group)) || [];
      } catch (err) {
        logger?.warn?.("[lobby] no pude listar solicitudes:", err?.message || err);
        continue;
      }
      for (const request of pending) {
        const participant = request?.jid || request?.id || request?.phoneNumber;
        if (!participant) continue;
        results.push(await handleJoinRequest({ id: group, participant, action: "created" }));
      }
    }
    return { handled: true, results };
  }

  return {
    handleJoinRequest,
    handleParticipantsUpdate,
    onFichaSubmitted,
    sync,
    ensureGeneralLink,
    rotateGeneralLink,
    inviteUrl,
  };
}
