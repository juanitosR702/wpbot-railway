import { randomBytes } from "node:crypto";
import * as baileys from "@whiskeysockets/baileys";

// Listas desplegables (menú de una sola selección) para Baileys v6.
//
// `sock.sendMessage` NO entiende `sections`: `generateWAMessageContent` lo manda
// a `prepareWAMessageMedia` y lanza "Invalid media type". El mensaje hay que
// construirlo a mano como `interactiveMessage` con un botón `single_select` y
// relayearlo.
//
// Dos detalles que WhatsApp exige para que el cliente PINTE el desplegable (si
// faltan, el servidor acepta el mensaje sin error pero el usuario no ve nada):
//   1. `messageContextInfo.messageSecret` (32 bytes aleatorios) en el mensaje.
//   2. `additionalNodes` en el relay: <biz><interactive type="native_flow"
//      v="1"><native_flow v="9" name="mixed"/></interactive></biz>.
//
// `rows`: [{ rowId, title, description?, header? }]
// El `rowId` es lo que llega de vuelta en
// `interactiveResponseMessage.nativeFlowResponseMessage.paramsJson` (campo `id`).

const MAX_ROW_TITLE = 24;
// Si relayMessage no responde en este tiempo, se considera fallo y el plugin
// manda el menú en texto para no dejar al usuario esperando.
const SEND_TIMEOUT_MS = 8000;

// Nodos que hacen que WhatsApp renderice los botones nativos.
const INTERACTIVE_NODES = [
  {
    tag: "biz",
    attrs: {},
    content: [
      {
        tag: "interactive",
        attrs: { type: "native_flow", v: "1" },
        content: [{ tag: "native_flow", attrs: { v: "9", name: "mixed" } }],
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

  // El encabezado solo se agrega si hay título: un header con título vacío es
  // rechazado/ignorado por el cliente.
  if (payload.title) {
    interactiveMessage.header = {
      title: String(payload.title),
      subtitle: "",
      hasMediaAttachment: false,
    };
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

  if (options.wrapped) {
    // Respaldo para clientes que exigen el envoltorio view-once.
    return generate(
      jid,
      {
        viewOnceMessage: {
          message: {
            messageContextInfo: {
              deviceListMetadata: {},
              deviceListMetadataVersion: 2,
              messageSecret: randomBytes(32),
            },
            interactiveMessage,
          },
        },
      },
      { userJid: options.userJid },
    );
  }

  // `messageSecret` es obligatorio para que WhatsApp muestre los botones
  // nativos; sin él el mensaje se acepta pero no se renderiza.
  return generate(
    jid,
    { messageContextInfo: { messageSecret: randomBytes(32) }, interactiveMessage },
    { userJid: options.userJid },
  );
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
          // Sin estos nodos WhatsApp no pinta el desplegable.
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
