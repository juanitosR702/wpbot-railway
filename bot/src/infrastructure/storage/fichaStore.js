import BaseStore from "../database/baseStore.js";

// Configuración de fichas:
//   destination -> grupo donde se publican las fichas (global)
//   forms[jid]  -> encabezado, campos y pie de la ficha de ese grupo
//
// Un documento por colección (`_id: "state"`), igual que el resto de stores.
export class FichaStore extends BaseStore {
  constructor() {
    super("ficha_settings");
  }

  _defaultState() {
    return { destination: "", forms: {} };
  }

  form(jid) {
    return this.state.forms?.[jid] || null;
  }

  setForm(jid, form, by = null) {
    if (!this.state.forms) this.state.forms = {};
    this.state.forms[jid] = {
      header: form.header || "",
      footer: form.footer || "",
      fields: form.fields || [],
      updatedAt: Date.now(),
      updatedBy: by,
    };
    return this.state.forms[jid];
  }

  clearForm(jid) {
    if (!this.state.forms) return;
    delete this.state.forms[jid];
  }

  destination() {
    return this.state.destination || "";
  }

  setDestination(jid) {
    this.state.destination = jid || "";
  }
}

let instance = null;

export function getFichaStore() {
  if (!instance) instance = new FichaStore();
  return instance;
}
