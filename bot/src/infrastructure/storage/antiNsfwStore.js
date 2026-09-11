import BaseStore from "../database/baseStore.js";

export class AntiNsfwStore extends BaseStore {
  static _instances = [];

  constructor() {
    super("anti_nsfw");
    AntiNsfwStore._instances.push(this);
  }

  static resetAllVolatile() {
    for (const inst of AntiNsfwStore._instances) {
      for (const g of Object.values(inst.state?.groups || {})) {
        g.closed = false;
        g.consecutiveNsfw = 0;
        g.consecutiveErrors = 0;
        g.consecutiveMedia = 0;
        g.lastMediaAt = 0;
      }
    }
  }

  _defaultState() {
    return { groups: {}, logs: [] };
  }

  async _load() {
    const state = await super._load();
    for (const g of Object.values(state.groups)) {
      g.closed = false;
      g.consecutiveNsfw = 0;
      g.consecutiveErrors = 0;
      g.consecutiveMedia = 0;
      g.lastMediaAt = 0;
    }
    return state;
  }

  async save() {
    const copy = JSON.parse(JSON.stringify(this.state));
    for (const g of Object.values(copy.groups)) {
      delete g.closed;
      delete g.consecutiveNsfw;
      delete g.consecutiveErrors;
      delete g.consecutiveMedia;
      delete g.lastMediaAt;
    }
    try {
      if (!this.collection) return;
      await this.collection.updateOne(
        { _id: "state" },
        { $set: copy },
        { upsert: true },
      );
    } catch (err) {
      console.error("[anti_nsfw] No se pudo guardar estado:", err);
    }
  }

  group(jid) {
    if (!this.state.groups[jid]) {
      this.state.groups[jid] = {
        enabled: false,
        mode: "warn",
        infractions: {},
        protectOwner: true,
        mediaBlocklist: [],
        consecutiveNsfw: 0,
        consecutiveErrors: 0,
        closed: false,
        consecutiveMedia: 0,
        lastMediaAt: 0,
        kickThreshold: 3,
      };
    }
    if (!this.state.groups[jid].mediaBlocklist) {
      this.state.groups[jid].mediaBlocklist = [];
    }
    if (this.state.groups[jid].consecutiveNsfw === undefined) {
      this.state.groups[jid].consecutiveNsfw = 0;
    }
    if (this.state.groups[jid].consecutiveErrors === undefined) {
      this.state.groups[jid].consecutiveErrors = 0;
    }
    if (this.state.groups[jid].closed === undefined) {
      this.state.groups[jid].closed = false;
    }
    if (this.state.groups[jid].consecutiveMedia === undefined) {
      this.state.groups[jid].consecutiveMedia = 0;
    }
    if (this.state.groups[jid].lastMediaAt === undefined) {
      this.state.groups[jid].lastMediaAt = 0;
    }
    if (this.state.groups[jid].kickThreshold === undefined) {
      this.state.groups[jid].kickThreshold = 3;
    }
    return this.state.groups[jid];
  }

  addInfraction(groupJid, userJid) {
    const group = this.group(groupJid);
    group.infractions[userJid] = (group.infractions[userJid] || 0) + 1;
    this.save();
    return group.infractions[userJid];
  }

  incrementConsecutiveNsfw(groupJid) {
    const group = this.group(groupJid);
    group.consecutiveNsfw = (group.consecutiveNsfw || 0) + 1;
    this.save();
    return group.consecutiveNsfw;
  }

  resetConsecutiveNsfw(groupJid) {
    const group = this.group(groupJid);
    group.consecutiveNsfw = 0;
    this.save();
  }

  incrementConsecutiveErrors(groupJid) {
    const group = this.group(groupJid);
    group.consecutiveErrors = (group.consecutiveErrors || 0) + 1;
    this.save();
    return group.consecutiveErrors;
  }

  resetConsecutiveErrors(groupJid) {
    const group = this.group(groupJid);
    group.consecutiveErrors = 0;
    this.save();
  }

  incrementConsecutiveMedia(groupJid, now) {
    const g = this.group(groupJid);
    if (now - (g.lastMediaAt || 0) > 30000) g.consecutiveMedia = 0;
    g.consecutiveMedia = (g.consecutiveMedia || 0) + 1;
    g.lastMediaAt = now;
    this.save();
    return g.consecutiveMedia;
  }

  resetConsecutiveMedia(groupJid) {
    const g = this.group(groupJid);
    g.consecutiveMedia = 0;
    this.save();
  }

  setKickThreshold(groupJid, n) {
    const g = this.group(groupJid);
    g.kickThreshold = n;
    this.save();
  }

  log(entry) {
    this.state.logs.push({ at: new Date().toISOString(), ...entry });
    this.state.logs = this.state.logs.slice(-500);
    this.save();
  }
}
