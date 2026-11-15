import BaseStore from "../database/baseStore.js";

// Ingreso automático al clan:
//   lobby     -> grupo donde entran los nuevos (se aprueban solos)
//   general   -> grupo definitivo; al aprobar ahí se saca al miembro del Lobby
//   delayMs   -> espera antes del saludo + ficha (para que la persona vea el grupo)
//   enabled   -> interruptor general
//   minAge    -> edad mínima para pasar al general (0 = sin filtro)
//   countries -> países aceptados ([] = sin filtro)
//   initials  -> iniciales de nombre aceptadas ([] = sin filtro)
//   excuse    -> texto propio en vez de las excusas por defecto
//
// Los JID se guardan sin sufijo (`cleanJid`) para compararlos con `ctx.phone`.
export class IngresoStore extends BaseStore {
  constructor() {
    super("ingreso_settings");
  }

  _defaultState() {
    return {
      lobby: "",
      general: "",
      delayMs: 15000,
      enabled: false,
      minAge: 0,
      countries: [],
      initials: [],
      excuse: "",
    };
  }

  config() {
    return {
      lobby: this.state.lobby || "",
      general: this.state.general || "",
      delayMs: Number(this.state.delayMs) || 15000,
      enabled: Boolean(this.state.enabled),
      minAge: Number(this.state.minAge) || 0,
      countries: Array.isArray(this.state.countries) ? [...this.state.countries] : [],
      initials: Array.isArray(this.state.initials) ? [...this.state.initials] : [],
      excuse: this.state.excuse || "",
    };
  }

  setLobby(jid) {
    this.state.lobby = jid || "";
  }

  setGeneral(jid) {
    this.state.general = jid || "";
  }

  setDelay(ms) {
    this.state.delayMs = Math.max(0, Number(ms) || 0);
  }

  setEnabled(value) {
    this.state.enabled = Boolean(value);
  }

  setMinAge(years) {
    const age = Math.trunc(Number(years) || 0);
    this.state.minAge = age > 0 ? Math.min(age, 99) : 0;
  }

  setCountries(list) {
    this.state.countries = (list || []).map((item) => String(item).trim()).filter(Boolean);
  }

  setInitials(list) {
    this.state.initials = (list || [])
      .map((item) => String(item).trim().toUpperCase())
      .filter(Boolean);
  }

  setExcuse(text) {
    this.state.excuse = String(text || "").trim();
  }

  reset() {
    this.state = this._defaultState();
  }
}

let instance = null;

export function getIngresoStore() {
  if (!instance) instance = new IngresoStore();
  return instance;
}
