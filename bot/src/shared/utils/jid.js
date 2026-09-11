export function cleanJid(jid) {
  if (!jid) return "";
  return String(jid).split(":")[0].split("@")[0];
}

export function normalizeJid(jid = "") {
  return String(jid).replace(/:\d+(?=@)/, "").toLowerCase();
}

export function jidUser(jid = "") {
  return normalizeJid(jid).split("@")[0];
}

export function jidFromNumber(value) {
  const number = String(value || "").replace(/\D/g, "");
  return number ? `${number}@s.whatsapp.net` : null;
}

export function sameParticipant(a = "", b = "") {
  const normalizedA = normalizeJid(a);
  const normalizedB = normalizeJid(b);
  if (normalizedA === normalizedB) return true;
  const userA = jidUser(a);
  const userB = jidUser(b);
  return Boolean(userA && userB && userA === userB);
}

export function participantIds(participant = {}) {
  return [
    participant.id,
    participant.jid,
    participant.lid,
    participant.phoneNumber,
    jidFromNumber(participant.phoneNumber),
  ].filter(Boolean);
}

export function isAdminParticipant(participant) {
  return (
    participant?.admin === "admin" ||
    participant?.admin === "superadmin" ||
    participant?.isAdmin === true ||
    participant?.isSuperAdmin === true
  );
}

export function findParticipant(metadata, ids) {
  const candidates = ids.filter(Boolean);
  return metadata?.participants?.find((participant) =>
    participantIds(participant).some((participantId) =>
      candidates.some((jid) => sameParticipant(participantId, jid)),
    ),
  );
}

// Resolve any JID (bare number, LID, or phone) to a full phone JID for mentions.
// Falls back to "<number>@s.whatsapp.net" when metadata lookup fails.
export function resolvePhoneJid(jid, metadata) {
  if (!jid) return null;
  if (metadata) {
    const participant = findParticipant(metadata, [jid]);
    if (participant?.id) return participant.id;
  }
  const raw = String(jid);
  if (raw.includes("@") && !raw.includes("@lid")) return raw;
  const number = raw.split("@")[0].split(":")[0].replace(/\D/g, "");
  return number ? `${number}@s.whatsapp.net` : null;
}
