import { cleanJid } from "../../shared/utils/jid.js";

// A handler may consume a message without producing a WhatsApp reply. This
// stops later plugins from acting on content moderation already removed.
export const HALT = Object.freeze({ __routerHalt: true });

export class Router {
  constructor(options = {}) {
    this._handlers = [];
    this._plugins = [];
    this.prefix = options.prefix || "!";
    this._commands = [];
  }

  register(handler, meta = {}) {
    this._handlers.push({ handler, meta });
    if (Array.isArray(meta.commands)) {
      const category = meta.category || meta.plugin || "General";
      for (const command of meta.commands) {
        this._commands.push({
          command: String(command).replace(/^[!/]+/, ""),
          category,
          plugin: meta.plugin || "core",
        });
      }
    }
  }

  registerPlugin(plugin, options = {}) {    if (!plugin?.name || typeof plugin.register !== "function") {
      throw new Error("[router] Plugin invalido: debe exponer name y register(api)");
    }

    const api = {
      register: (handler, meta = {}) =>
        this.register(handler, { ...meta, plugin: plugin.name }),
      getCommands: () => this.getCommands(),
      prefix: this.prefix,
    };

    plugin.register(api, options);
    this._plugins.push({ name: plugin.name, version: plugin.version || "0.0.0" });
    console.log(`[router] Plugin registrado: ${plugin.name}`);
  }

  // Filtro opcional por grupo. Se llama una vez por mensaje y devuelve:
  //   null                       -> sin restricciones
  //   { disabled: true }         -> el bot está apagado en ese grupo
  //   { allows(plugin) }         -> qué plugins pueden responder
  // Se inyecta desde `bootstrap.js` para no acoplar el router a Mongo.
  setGroupGate(gate) {
    this._groupGate = typeof gate === "function" ? gate : null;
  }

  async route(msg, services = {}) {
    if (!msg.message) return null;

    const rawJid = msg.key.remoteJid || "";
    const phone = cleanJid(rawJid);
    const sender = cleanJid(msg.key.participant || rawJid);

    const fullJid = (jid) => (jid && !jid.includes("@") ? `${jid}@s.whatsapp.net` : jid);
    const text = this._extractText(msg.message);
    if (msg.key?.fromMe && !text.trim().startsWith(this.prefix)) return null;

    const input = this._parseInput(text);
    const name = msg.pushName || sender;
    const isGroup = rawJid.endsWith("@g.us");
    const mediaType = this._extractMediaType(msg.message);
    // Respuestas a listas/botones de WhatsApp (menús desplegables).
    const selection = this._extractSelection(msg.message);

    if (!text && !mediaType && !selection) {
      // Diagnóstico: si WhatsApp manda una respuesta interactiva con otra forma
      // (nombre de campo distinto), queda constancia en logs en vez de perderse.
      const inner = this._unwrapMessage(msg.message) || {};
      const keys = Object.keys(inner);
      if (keys.some((key) => /interactive|listResponse|buttonsResponse|templateButton/i.test(key))) {
        console.warn("[router] respuesta interactiva no reconocida:", keys.join(","), JSON.stringify(inner).slice(0, 400));
      }
      return null;
    }

    const context = {
      phone,
      sender,
      text,
      selection,
      commandBody: input.body,
      prefix: this.prefix,
      isCommand: input.isCommand,
      command: input.command,
      args: input.args,
      name,
      isGroup,
      mediaType,
      raw: msg,
      services,
      sendMessage: async (content) => services.sendMessage?.(rawJid, content),
      // Lista desplegable; si el transporte no la soporta (Cloud API), el
      // plugin que la use debe caer a texto.
      sendList: async (payload) => {
        if (!services.sendList) throw new Error("sendList no disponible");
        return services.sendList(rawJid, payload);
      },
      reply: async (content) => services.sendMessage?.(rawJid, content),
      deleteMessage: async (key) => services.deleteMessage?.(rawJid, key),
      downloadMedia: async (message = msg) => services.downloadMedia?.(message),
      getGroupMetadata: async () => services.getGroupMetadata?.(rawJid),
      updateGroupSetting: async (setting) => services.updateGroupSetting?.(rawJid, setting),
      updateParticipants: async (participants, action) => services.updateParticipants?.(rawJid, participants.map(fullJid), action),
      inviteCode: async () => services.inviteCode?.(rawJid),
      revokeInvite: async () => services.revokeInvite?.(rawJid),
      leaveGroup: async () => services.leaveGroup?.(rawJid),
      shutdown: async () => services.shutdown?.(),
      restart: async () => services.restart?.(),
      botJid: services.botJid,
      botLid: services.botLid,
    };

    if (context.isCommand) {
      const phoneNum = msg.key?.participantPn ? cleanJid(msg.key.participantPn) : context.sender;
      let groupInfo = "";
      if (context.isGroup) {
        try {
          const meta = await context.getGroupMetadata();
          groupInfo = ` en grupo "${meta?.subject || "?"}" (${context.phone})`;
        } catch {
          groupInfo = ` en grupo (${context.phone})`;
        }
      }
      console.log(`[cmd] ${context.command} (${context.args.length} args) — ${phoneNum} (${context.sender})${groupInfo}`);
    }

    let gate = null;
    if (this._groupGate) {
      try {
        gate = await this._groupGate(context);
      } catch (err) {
        console.error("[router] Error en el filtro de grupo:", err);
        gate = null;
      }
    }
    if (gate?.disabled) return null;

    for (const { handler, meta } of this._handlers) {
      if (gate && typeof gate.allows === "function" && !gate.allows(meta?.plugin)) continue;
      try {
        const reply = await handler(context);
        if (reply?.__routerHalt === true) return null;
        if (reply) return reply;
      } catch (err) {
        const source = meta?.plugin || "handler";
        console.error(`[router] Error en ${source}:`, err);
      }
    }

    return null;
  }

  getCommands() {
    const seen = new Set();
    return this._commands.filter((item) => {
      const key = `${item.category}:${item.command}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  _parseInput(text) {
    const raw = text.trim();
    if (!raw.startsWith(this.prefix)) {
      return { isCommand: false, command: null, args: [], body: "" };
    }

    const rest = raw.slice(this.prefix.length).trim();
    const parts = rest.split(/\s+/).filter(Boolean);
    // `body` conserva los espacios y saltos de línea originales después del
    // comando. `args` los normaliza, pero algunos comandos (setwelcome,
    // setbye) necesitan el texto tal cual lo escribió el usuario.
    const body = parts.length ? rest.slice(parts[0].length).replace(/^\s+/, "") : "";

    return {
      isCommand: true,
      command: parts[0]?.toLowerCase() || null,
      args: parts.slice(1),
      body,
    };
  }

  _unwrapMessage(message) {
    if (!message) return message;
    let content = message;
    for (let i = 0; i < 5; i++) {
      const inner = content?.ephemeralMessage?.message
        || content?.viewOnceMessage?.message
        || content?.viewOnceMessageV2?.message
        || content?.viewOnceMessageV2Extension?.message
        || content?.documentWithCaptionMessage?.message
        || content?.editedMessage?.message
        || null;
      if (!inner) break;
      content = inner;
    }
    return content;
  }

  _extractText(message) {
    const m = this._unwrapMessage(message);
    return (
      m.conversation ||
      m.extendedTextMessage?.text ||
      m.imageMessage?.caption ||
      m.videoMessage?.caption ||
      m.documentMessage?.caption ||
      ""
    );
  }

  _extractMediaType(message) {
    const m = this._unwrapMessage(message);
    if (m.imageMessage) return "image";
    if (m.stickerMessage) return "sticker";
    if (m.videoMessage) return m.videoMessage.gifPlayback ? "gif" : "video";
    if (m.documentMessage?.mimetype?.startsWith("image/")) return "image";
    if (m.documentMessage?.mimetype?.startsWith("video/")) return "video";
    return null;
  }

  // Id de la fila elegida en una lista interactiva o en un botón. Los plugins
  // que usan menús desplegables lo leen desde `ctx.selection`; el texto normal
  // (`ctx.text`) queda vacío para no confundirlo con lo que escribió el usuario.
  //
  // Se cubren las dos formas: `listResponseMessage` (listas clásicas) y
  // `interactiveResponseMessage` (botón `single_select` / native flow, que trae
  // el id dentro de `paramsJson`).
  _extractSelection(message) {
    const m = this._unwrapMessage(message);

    const direct =
      m?.listResponseMessage?.singleSelectReply?.selectedRowId ||
      m?.buttonsResponseMessage?.selectedButtonId ||
      m?.templateButtonReplyMessage?.selectedId;
    if (direct) return String(direct);

    const paramsJson = m?.interactiveResponseMessage?.nativeFlowResponseMessage?.paramsJson;
    if (paramsJson) {
      try {
        const params = JSON.parse(paramsJson);
        const id = params?.id ?? params?.selectedId;
        if (id) return String(id);
      } catch {
        // paramsJson inválido: se ignora.
      }
    }

    return null;
  }
}
