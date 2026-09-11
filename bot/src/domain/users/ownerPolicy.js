import { sameParticipant, participantIds, findParticipant } from "../../shared/utils/jid.js";

/**
 * Políticas de permisos del bot. Núcleo puro del dominio: no conoce
 * infraestructura ni `env`. Las fuentes de datos se inyectan vía `providers`.
 *
 * providers = {
 *   creatorJids: () => string[],
 *   botNumberJids: () => string[],
 *   extraProtectedJids: () => string[],
 * }
 */
export function createOwnerPolicy(providers = {}) {
  const {
    creatorJids = () => [],
    botNumberJids = () => [],
    extraProtectedJids = () => [],
  } = providers;

  async function isBotAdmin(getGroupMetadata, botJid, botLid, cachedMeta) {
    const metadata = cachedMeta || await getGroupMetadata();
    const botPhone = botJid?.split("@")[0]?.split(":")[0];
    let bot = metadata.participants.find((p) => p.id?.split("@")[0]?.split(":")[0] === botPhone);
    if (!bot) bot = metadata.participants.find((p) => p.jid?.split("@")[0] === botPhone);
    if (!bot && botLid) bot = metadata.participants.find((p) => p.lid === botLid || p.id === botLid);
    return bot?.admin === "admin" || bot?.admin === "superadmin";
  }

  function isCreatorJid(jid, metadata = null) {
    const creatorIds = creatorJids();
    if (creatorIds.some((creatorJid) => sameParticipant(creatorJid, jid))) return true;
    const participant = findParticipant(metadata, [jid]);
    return Boolean(
      participant &&
        participantIds(participant).some((participantId) =>
          creatorIds.some((creatorJid) => sameParticipant(participantId, creatorJid)),
        ),
    );
  }

  function protectedJids(ctx, metadata = null) {
    const ids = [...creatorJids(), ...botNumberJids(), ...extraProtectedJids(), ctx?.botJid, ctx?.botLid].filter(Boolean);
    const bot = findParticipant(metadata, [ctx?.botJid, ctx?.botLid]);
    if (bot) ids.push(...participantIds(bot));
    return ids;
  }

  function isProtectedJid(jid, ctx = {}, metadata = null) {
    if (isCreatorJid(jid, metadata)) return true;
    return protectedJids(ctx, metadata).some((protectedJid) => sameParticipant(protectedJid, jid));
  }

  return { isBotAdmin, isCreatorJid, protectedJids, isProtectedJid };
}
