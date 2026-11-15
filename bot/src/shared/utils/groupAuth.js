import { findParticipant, isAdminParticipant } from "./jid.js";
import { MSG } from "../messages.js";

/**
 * Autorización para comandos de configuración de grupo.
 * El creador siempre manda; si no, hace falta ser admin del grupo.
 * Devuelve `{ ok, metadata, sender, botIsAdmin, isCreator }` o `{ ok:false, reason }`.
 */
export async function getGroupAdminAuth(ctx, ownerPolicy) {
  if (!ctx.isGroup) return { ok: false, reason: MSG.SOLO_GRUPOS };

  let metadata = null;
  try {
    metadata = (await ctx.getGroupMetadata?.()) || null;
  } catch {
    metadata = null;
  }

  const senderIds = [
    ctx.sender,
    ctx.raw?.key?.participant,
    ctx.raw?.key?.participantPn,
    ctx.raw?.key?.participantLid,
    ctx.raw?.participant,
    ctx.raw?.participantPn,
    ctx.raw?.participantLid,
  ].filter(Boolean);

  const sender = findParticipant(metadata, senderIds);
  const isCreator = senderIds.some((id) => ownerPolicy?.isCreatorJid?.(id, metadata));

  if (!isAdminParticipant(sender) && !isCreator) {
    return { ok: false, reason: MSG.SOLO_ADMIN };
  }

  let botIsAdmin = false;
  try {
    botIsAdmin = Boolean(await ownerPolicy?.isBotAdmin?.(ctx.getGroupMetadata, ctx.botJid, ctx.botLid));
  } catch {
    botIsAdmin = false;
  }

  return { ok: true, metadata, sender, botIsAdmin, isCreator };
}
