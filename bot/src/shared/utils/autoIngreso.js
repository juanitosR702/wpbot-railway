import { cleanJid } from "./jid.js";

// Flujo de ingreso automático:
//   1. Solicitud para entrar al Lobby   -> se aprueba sola.
//   2. Entra al Lobby                   -> tras `delayMs` saluda y arranca la ficha.
//   3. Termina la ficha                 -> el plugin de fichas manda el enlace de General.
//   4. Solicitud para entrar a General  -> se aprueba sola y se saca del Lobby.
//   5. Entra a General (aunque lo agregue un admin) -> se saca del Lobby.
//
// La lógica es pura a propósito: los efectos (aprobar, expulsar, saludar,
// iniciar ficha) llegan inyectados desde `bootstrap.js`.

export const DEFAULT_DELAY_MS = 15000;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

/** Id de grupo sin sufijo (`1203...@g.us` -> `1203...`). */
export function groupIdOf(jid) {
  return cleanJid(jid);
}

export function normalizeConfig(config = {}) {
  return {
    lobby: config.lobby || "",
    general: config.general || "",
    delayMs: Number.isFinite(Number(config.delayMs)) ? Number(config.delayMs) : DEFAULT_DELAY_MS,
    enabled: Boolean(config.enabled),
  };
}

export function isLobby(config, jid) {
  return Boolean(config.enabled && config.lobby && groupIdOf(jid) === config.lobby);
}

export function isGeneral(config, jid) {
  return Boolean(config.enabled && config.general && groupIdOf(jid) === config.general);
}

/**
 * Solicitudes de unión (`group.join-request`).
 * `approve(jid, participant)` y `removeFromLobby(participant)` los pone bootstrap.
 */
export async function onJoinRequest(update, deps = {}) {
  const config = normalizeConfig(deps.config);
  const { approve, removeFromLobby, logger = console } = deps;

  if (!config.enabled) return null;
  const participant = update?.participant;
  if (!participant) return null;
  // `created` es la solicitud nueva; `revoked`/`rejected` no se tocan.
  if (update.action && update.action !== "created") return null;

  const groupJid = update.id;

  if (isLobby(config, groupJid)) {
    await approve?.(groupJid, participant, "approve");
    logger.log(`[ingreso] solicitud aprobada en Lobby: ${participant}`);
    return "lobby";
  }

  if (isGeneral(config, groupJid)) {
    await approve?.(groupJid, participant, "approve");
    logger.log(`[ingreso] solicitud aprobada en General: ${participant}`);
    await removeFromLobby?.(participant);
    return "general";
  }

  return null;
}

/**
 * Entradas y salidas de participantes (`group-participants.update`).
 * - En el Lobby: espera `delayMs`, saluda y arranca la ficha.
 * - En General: saca al miembro del Lobby.
 */
export async function onParticipantsUpdate(update, deps = {}) {
  const config = normalizeConfig(deps.config);
  const {
    welcome,
    startFicha,
    removeFromLobby,
    logger = console,
    sleepFn = sleep,
  } = deps;

  if (!config.enabled) return null;
  if (update?.action !== "add") return null;

  for (const participant of update.participants || []) {
    if (isLobby(config, update.id)) {
      await sleepFn(config.delayMs);
      // Un fallo saludando no debe impedir que arranque la ficha (y viceversa).
      for (const step of [welcome, startFicha]) {
        try {
          await step?.(update.id, participant);
        } catch (err) {
          logger.warn("[ingreso] no se pudo saludar/iniciar ficha:", err?.message || err);
        }
      }
      continue;
    }

    if (isGeneral(config, update.id)) {
      await removeFromLobby?.(participant);
    }
  }

  return null;
}

/** Texto cuando todavía no hay plantilla de bienvenida configurada. */
export function defaultWelcomeText({ participant, groupName } = {}) {
  const name = `@${String(participant || "").split("@")[0].split(":")[0]}`;
  const group = groupName || "el grupo";
  return [
    `👋 ¡Bienvenido/a ${name} a *${group}*!`,
    "",
    "Para entrar al clan, llena tu ficha ahora mismo.",
    "Te hago las preguntas por aquí; responde una por una.",
  ].join("\n");
}
