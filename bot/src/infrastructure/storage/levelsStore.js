import BaseStore from "../database/baseStore.js";
import { cleanJid } from "../../shared/utils/jid.js";

export class LevelsStore extends BaseStore {
  constructor() {
    super("levels");
  }

  _defaultState() {
    return { groups: {}, events: [] };
  }

  async _load() {
    const state = await super._load();
    if (state.users && Object.keys(state.users).length > 0) {
      state.groups = { ...(state.groups || {}), legacy: { users: state.users } };
      delete state.users;
      try {
        await this.collection.updateOne(
          { _id: "state" },
          { $set: { groups: state.groups }, $unset: { users: "" } },
        );
      } catch {}
    }
    if (!state.groups) state.groups = {};
    return state;
  }

  _group(groupId) {
    if (!this.state.groups[groupId]) {
      this.state.groups[groupId] = { users: {} };
    }
    return this.state.groups[groupId];
  }

  user(groupId, jid) {
    const key = cleanJid(jid);
    const group = this._group(groupId);
    if (!group.users[key]) {
      group.users[key] = {
        aura: 0,
        level: 1,
        messages: 0,
        lastAuraAt: 0,
        createdAt: new Date().toISOString(),
      };
    }
    return group.users[key];
  }

  updateProfile(groupId, jid, profile = {}) {
    const user = this.user(groupId, jid);
    const name = String(profile.name || "").trim();
    if (name && !name.includes("@")) user.name = name.slice(0, 80);
    user.updatedAt = new Date().toISOString();
    return user;
  }

  rankedUsers(groupId) {
    const group = this.state.groups[groupId];
    if (!group) return [];
    return Object.entries(group.users)
      .map(([jid, user]) => ({ jid, ...user }))
      .sort((a, b) => b.level - a.level || (b.aura || 0) - (a.aura || 0) || b.messages - a.messages);
  }

  log(entry) {
    this.state.events.push({ at: new Date().toISOString(), ...entry });
    this.state.events = this.state.events.slice(-1000);
  }
}
