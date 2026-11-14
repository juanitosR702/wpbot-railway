import * as baileys from "@whiskeysockets/baileys";

// Listas desplegables (menú de una sola selección) para Baileys v6.
//
// `sock.sendMessage` NO entiende `sections`: `generateWAMessageContent` lo manda
// a `prepareWAMessageMedia` y lanza "Invalid media type". El mensaje hay que
// construirlo a mano como `interactiveMessage` con un botón `single_select` y
// relayearlo. Esto es lo que hace este módulo.
//
// `rows`: [{ rowId, title, description?, header? }]
// El `rowId` es lo que llega de vuelta en
// `interactiveResponseMessage.nativeFlowResponseMessage.paramsJson` (campo `id`).

const MAX_ROW_TITLE = 24;

function trimTitle(value, max = MAX_ROW_TITLE) {
  const text = String(value || "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toSection(section) {
  return {
    title: trimTitle(section.title || "Opciones", 24),
    rows: (section.rows || []).map((row) => ({
      header: row.header || "",
      title: trimTitle(row.title || row.rowId || ""),
      description: row.description || "",
      id: String(row.rowId ?? row.id ?? ""),
    })),
  };
}

/** Arma el proto del mensaje interactivo (sin enviarlo). */
export function buildListMessage(jid, { text, footer, buttonText, title, rows, sections }, options = {}) {
  const listSections = sections?.length
    ? sections.map(toSection)
    : [{ title: title || "Opciones", rows: rows || [] }].map(toSection);

  const interactiveMessage = {
    body: { text: String(text || "") },
    header: { title: "", hasMediaAttachment: false },
    nativeFlowMessage: {
      buttons: [
        {
          name: "single_select",
          buttonParamsJson: JSON.stringify({
            title: trimTitle(buttonText || "Ver opciones", 24),
            sections: listSections,
          }),
        },
      ],
    },
  };

  if (footer) interactiveMessage.footer = { text: String(footer) };

  const generate = baileys.generateWAMessageFromContent;
  if (typeof generate !== "function") {
    throw new Error("generateWAMessageFromContent no disponible en esta versión de Baileys");
  }

  return generate(
    jid,
    {
      // El wrapper view-once es el que usan los clientes no oficiales para que
      // WhatsApp acepte el interactiveMessage sin rechazarlo.
      viewOnceMessage: {
        message: {
          messageContextInfo: {
            deviceListMetadata: {},
            deviceListMetadataVersion: 2,
          },
          interactiveMessage,
        },
      },
    },
    { userJid: options.userJid },
  );
}

/**
 * Envía la lista. Lanza si WhatsApp rechaza el mensaje para que el plugin pueda
 * caer al menú numerado en texto.
 */
export async function sendListMessage(sock, jid, payload, options = {}) {
  if (!sock?.relayMessage) throw new Error("relayMessage no disponible");
  const message = buildListMessage(jid, payload, {
    userJid: options.userJid || sock.user?.id,
  });
  await sock.relayMessage(jid, message.message, { messageId: message.key.id });
  return message;
}

/** Id elegido en una respuesta de lista interactiva (o de botón). */
export function extractSelectionId(message) {
  const nativeFlow = message?.interactiveResponseMessage?.nativeFlowResponseMessage;
  if (nativeFlow?.paramsJson) {
    try {
      const params = JSON.parse(nativeFlow.paramsJson);
      if (params?.id) return String(params.id);
      if (params?.selectedId) return String(params.selectedId);
    } catch {
      // paramsJson roto: se ignora y se prueban las otras formas.
    }
  }
  return null;
}
