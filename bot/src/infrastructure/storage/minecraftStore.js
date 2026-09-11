import BaseStore from "../database/baseStore.js";
import { cleanJid } from "../../shared/utils/jid.js";

export class MinecraftStore extends BaseStore {
  constructor() {
    super("minecraft");
  }

  _defaultState() {
    return { groups: {} };
  }

  getServer(jid) {
    const key = cleanJid(jid);
    return this.state.groups[key] || null;
  }

  setServer(jid, data) {
    const key = cleanJid(jid);
    this.state.groups[key] = {
      ...data,
      setAt: new Date().toISOString(),
    };
    this.save();
  }
}
