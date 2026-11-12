import BaseStore from "../database/baseStore.js";

export class GroupAdminStore extends BaseStore {
  constructor() {
    super("group_admin");
  }

  _defaultState() {
    return { groups: {} };
  }

  group(jid) {
    if (!this.state.groups[jid]) {
      this.state.groups[jid] = {
        muted: false,
        antilink: false,
        welcome: false,
        welcomeText: "Bienvenido @user",
        byeText: "Adios @user",
        warnings: {},
      };
    }
    return this.state.groups[jid];
  }
}
