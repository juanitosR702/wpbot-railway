import BaseStore from "../database/baseStore.js";

// Configuración por grupo: si el bot está encendido y qué módulos están
// desactivados. Se guarda en Mongo (1 documento) y se lee en memoria, así que
// el router puede consultarla en cada mensaje sin coste.
export class GroupSettingsStore extends BaseStore {
  constructor() {
    super("group_settings");
  }

  _defaultState() {
    return { groups: {} };
  }

  group(jid) {
    if (!this.state.groups[jid]) {
      this.state.groups[jid] = { botEnabled: true, disabledModules: [] };
    }
    // Compatibilidad con documentos viejos o incompletos.
    if (typeof this.state.groups[jid].botEnabled !== "boolean") {
      this.state.groups[jid].botEnabled = true;
    }
    if (!Array.isArray(this.state.groups[jid].disabledModules)) {
      this.state.groups[jid].disabledModules = [];
    }
    return this.state.groups[jid];
  }
}

// Singleton: el gate del router, el comando `!bot` y la bienvenida deben ver
// exactamente el mismo estado en memoria.
let instance = null;

export function getGroupSettingsStore() {
  if (!instance) instance = new GroupSettingsStore();
  return instance;
}
