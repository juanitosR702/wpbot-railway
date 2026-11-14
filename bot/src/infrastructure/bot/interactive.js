import * as baileys from "@whiskeysockets/baileys";

// Listas desplegables (menú de una sola selección) para Baileys v6.
//
// `sock.sendMessage` NO entiende `sections`: `generateWAMessageContent` lo manda
// a `prepareWAMessageMedia` y lanza "Invalid media type". El mensaje hay que
// construirlo a mano como `interactiveMessage` con un botón `single_select` y
// relayearlo.
//
// IMPORTANTE: el `relayMessage` tiene que llevar el nodo binario
// `<biz><interactive type="native_flow" v="1"><native_flow v="9" name="mixed"/></interactive></biz>`.
// Sin `additionalNodes` WhatsApp acepta el mensaje (no da error) pero el cliente
// NO pinta el botón ni el desplegable: llega vacío/ignorado. Ese era el motivo
// de que la lista "no apareciera".
//
// `rows`: [{ rowId, title, description?, header? }]
// El `rowId` es lo que llega de vuelta en
// `interactiveResponseMessage.nativeFlowResponseMessage.paramsJson` (campo `id`).

const MAX_ROW_TITLE = 24;
// Si relayMessage no responde en este tiempo, se considera fallo y el plugin
// manda el menú en texto para no dejar al usuario esperando.
const SEND_TIMEOUT_MS = 8000;

const SEL = { type: "native_flow", v: "1" };
const FLOW = { v: "9", name: "mixed" };

// Nodos que hacen que WhatsApp renderice los botones nativos.
const INTERACTIVE_NODES = [
  {
    tag: "biz",
    attrs: {},
    content: [
      {
        tag: "interactive",
        attrs: { ...SEL },
        content: [{ tag: "native_flow", attrs: { ...FLOW } }],
      },
    ],
  },
];

function trimTitle(value, max = MAX_ROW_TITLE) {
  const text = String(value || "").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function toSection(section) {
  return {
    title: trimTitle(section.title || "Opciones", 24),
    highlight_label: "",
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
    body: { text: String(payload.text || "").trim() || " " },
    nativeFlowMessage: {
      buttons: [
        {
          name: "single_select",
          buttonParamsJson: JSON.stringify({
            title: trimTitle(payload.buttonText || "Ver opciones", 24),
            sections: listSections,
          }),
        },
      ],
      messageParamsJson: "",
    },
  };

  if (payload.title) {
    interactiveMessage.header = {
      title: String(payload.title),
      subtitle: "",
      hasMediaAttachment: false,
    };
  } else {
    interactiveMessage.header = { title: "", hasMediaAttachment: false };
  }

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

  // Se prefiere el `interactiveMessage` directo. El wrapper view-once queda como
  // respaldo para clientes/versiones que exigen ese formato.
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
        sock.relayMessage(jid, message.message, {
          messageId: message.key.id,
          // Sin esto WhatsApp no pinta el desplegable.
          additionalNodes: INTERACTIVE_NODES,
        }),
        options.timeoutMs || SEND_TIMEOUT_MS,
      );
      console.log(`[interactive] lista enviada${wrapped ? " (viewOnce)" : ""}: ${message.key.id}`);
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
