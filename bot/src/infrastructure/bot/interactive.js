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
// Si relayMessage no responde en este tiempo, se considera fallo y el plugin
// manda el menú en texto para no dejar al usuario esperando.
const SEND_TIMEOUT_MS = 8000;

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

function buildInteractive(payload) {
  const listSections = payload.sections?.length
    ? payload.sections.map(toSection)
    : [{ title: payload.title || "Opciones", rows: payload.rows || [] }].map(toSection);

  const interactiveMessage = {
    body: { text: String(payload.text || "") },
    header: { title: "", hasMediaAttachment: false },
    nativeFlowMessage: {
      messageVersion: 1,
      buttons: [
        {
          name: "single_select",
          buttonParamsJson: JSON.stringify({
            title: trimTitle(payload.buttonText || "Ver opciones", 24),
            sections: listSections,
          }),
        },
      ],
    },
  };

  if (payload.footer) interactiveMessage.footer = { text: String(payload.footer) };

  return interactiveMessage;
}

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`relayMessage sin respuesta (${ms} ms)`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Arma el proto del mensaje interactivo (sin enviarlo). */
export function buildListMessage(jid, payload, options = {}) {
  const generate = baileys.generateWAMessageFromContent;
  if (typeof generate !== "function") {
    throw new Error("generateWAMessageFromContent no disponible en esta versión de Baileys");
  }

  const interactiveMessage = buildInteractive(payload);

  // Se prefiere el `interactiveMessage` directo (es el que renderiza como
  // "Ver opciones" en WhatsApp). El wrapper view-once queda como respaldo para
  // versiones que exigen ese formato.
  if (options.wrapped) {
    return generate(
      jid,
      {
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

  return generate(jid, { interactiveMessage }, { userJid: options.userJid });
}

/**
 * Envía la lista. Lanza si WhatsApp rechaza el mensaje o no responde en
 * `SEND_TIMEOUT_MS`, para que el plugin caiga al menú numerado en texto.
 */
export async function sendListMessage(sock, jid, payload, options = {}) {
  if (!sock?.relayMessage) throw new Error("relayMessage no disponible");

  let lastError = null;
  for (const wrapped of [false, true]) {
    try {
      const message = buildListMessage(jid, payload, {
        userJid: options.userJid || sock.user?.id,
        wrapped,
      });
      await withTimeout(
        sock.relayMessage(jid, message.message, { messageId: message.key.id }),
        options.timeoutMs || SEND_TIMEOUT_MS,
      );
      return message;
    } catch (err) {
      lastError = err;
      console.warn(`[interactive] envío${wrapped ? " (viewOnce)" : ""} falló:`, err?.message || err);
    }
  }

  throw lastError || new Error("no se pudo enviar la lista interactiva");
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
