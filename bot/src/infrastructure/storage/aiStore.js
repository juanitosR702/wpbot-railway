import BaseStore from "../database/baseStore.js";

export class AiStore extends BaseStore {
  constructor(options = {}) {
    super("ai");
    this.maxHistoryMessages = options.maxHistoryMessages || 8;
    this.maxStoredMessages = options.maxStoredMessages || 1200;
    this.messageRetentionMs = options.messageRetentionMs || 48 * 60 * 60 * 1000;
  }

  _defaultState() {
    return { chats: {}, logs: [] };
  }

  chat(jid) {
    if (!this.state.chats[jid]) {
      this.state.chats[jid] = {
        enabled: true,
        history: [],
        messages: [],
        updatedAt: null,
      };
    }
    if (!Array.isArray(this.state.chats[jid].messages)) this.state.chats[jid].messages = [];
    return this.state.chats[jid];
  }

  reset(jid) {
    const chat = this.chat(jid);
    chat.history = [];
    chat.updatedAt = new Date().toISOString();
    this.save();
  }

  append(jid, role, content) {
    const chat = this.chat(jid);
    chat.history.push({ role, content, at: new Date().toISOString() });
    chat.history = chat.history.slice(-this.maxHistoryMessages);
    chat.updatedAt = new Date().toISOString();
    this.save();
  }

  messages(jid) {
    return this.chat(jid).history.map((item) => ({
      role: item.role,
      content: item.content,
    }));
  }

  recordMessage(jid, message) {
    const text = String(message.text || "").trim();
    if (!text) return;

    const chat = this.chat(jid);
    chat.messages.push({
      at: message.at || new Date().toISOString(),
      sender: message.sender,
      name: message.name,
      jid: message.jid || null,
      text: text.slice(0, 1000),
    });
    this.pruneMessages(jid);
    this.save();
  }

  recentMessages(jid, sinceMs) {
    const cutoff = Date.now() - sinceMs;
    return this.chat(jid).messages.filter((message) => Date.parse(message.at) >= cutoff);
  }

  pruneMessages(jid) {
    const chat = this.chat(jid);
    const cutoff = Date.now() - this.messageRetentionMs;
    chat.messages = chat.messages
      .filter((message) => Date.parse(message.at) >= cutoff)
      .slice(-this.maxStoredMessages);
  }

  log(entry) {
    this.state.logs.push({ at: new Date().toISOString(), ...entry });
    this.state.logs = this.state.logs.slice(-500);
    this.save();
  }
}
