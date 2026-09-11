import BaseStore from "../database/baseStore.js";

export class ModerationStore extends BaseStore {
  constructor() {
    super("moderation");
  }

  _defaultState() {
    return { blacklist: {}, warnings: {}, muted: {}, logs: [] };
  }

  group(jid) {
    for (const key of ["blacklist", "warnings", "muted"]) {
      if (!this.state[key][jid]) this.state[key][jid] = {};
    }
    return {
      blacklist: this.state.blacklist[jid],
      warnings: this.state.warnings[jid],
      muted: this.state.muted[jid],
    };
  }

  log(entry) {
    this.state.logs.push({ at: new Date().toISOString(), ...entry });
    this.state.logs = this.state.logs.slice(-500);
    this.save();
  }
}
