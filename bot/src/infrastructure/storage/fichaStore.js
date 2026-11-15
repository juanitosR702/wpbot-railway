import BaseStore from "../database/baseStore.js";

// Configuración de fichas:
//   destination -> grupo de respaldo si no hay rutas configuradas (global)
//   routes[]    -> grupos de destino con condiciones (edad, país, …)
//   forms[jid]  -> encabezado, campos y pie de la ficha de ese grupo
//
// Un documento por colección (`_id: "state"`), igual que el resto de stores.
export class FichaStore extends BaseStore {
  constructor() {
    super("ficha_settings");
  }

  _defaultState() {
    return { destination: "", routes: [], forms: {} };
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

  routes() {
    return Array.isArray(this.state.routes) ? this.state.routes : [];
  }

  /**
   * Añade o reemplaza la ruta del mismo grupo, o la que tenga el mismo nombre.
   * Un grupo de destino tiene una sola ruta: volver a ejecutar `!rutas aqui`
   * la actualiza en vez de duplicarla.
   */
  addRoute(route) {
    if (!Array.isArray(this.state.routes)) this.state.routes = [];
    const key = String(route?.name || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    const index = this.state.routes.findIndex((item) => {
      const itemKey = String(item?.name || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
      return itemKey === key || (route.jid && item?.jid === route.jid);
    });
    const entry = {
      id: route.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: route.name || "",
      jid: route.jid || "",
      scope: route.scope || "",
      invite: route.invite || "",
      conditions: route.conditions || [],
      enabled: route.enabled !== false,
      updatedAt: Date.now(),
      updatedBy: route.updatedBy || null,
    };
    if (index >= 0) this.state.routes[index] = entry;
    else this.state.routes.push(entry);
    return entry;
  }

  removeRoute(name) {
    if (!Array.isArray(this.state.routes)) return false;
    const key = String(name || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
    const before = this.state.routes.length;
    this.state.routes = this.state.routes.filter((item) => {
      const itemKey = String(item?.name || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();
      const itemJid = String(item?.jid || "");
      return itemKey !== key && itemJid !== String(name || "");
    });
    return this.state.routes.length < before;
  }

  clearRoutes() {
    this.state.routes = [];
  }
}

let instance = null;

export function getFichaStore() {
  if (!instance) instance = new FichaStore();
  return instance;
}
