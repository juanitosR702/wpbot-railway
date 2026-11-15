import BaseStore from "../database/baseStore.js";

// Estado del flujo lobby -> general:
//   lobbyJid/generalJid  grupos enlazados (se configuran con `!lobby aqui ...`)
//   welcomeDelayMs       espera antes de saludar (el recién llegado todavía no
//                        ve el grupo, por eso el mensaje se perdía)
//   generalCode          código de invitación vigente del grupo general
//   greeted[jid]         a quién ya se saludó (evita duplicados del evento)
//   submitted[jid]       quién ya envió su ficha (habilita la entrada a general)
//   minAge               edad mínima para pasar al general (0 = sin filtro)
//   countries[]          países aceptados ([] = sin filtro)
//   initials[]           iniciales del nombre aceptadas ([] = sin filtro)
//   excuse               excusa propia cuando no cumple ("" = las de por defecto)
//
// Un documento por colección (`_id: "state"`), igual que el resto de stores.
const DEFAULTS = {
  enabled: true,
  lobbyJid: "",
  generalJid: "",
  welcomeDelayMs: 5000,
  generalCode: "",
  generalCodeAt: 0,
  minAge: 0,
  countries: [],
  initials: [],
  excuse: "",
};

export class LobbyStore extends BaseStore {
  constructor() {
    super("lobby");
  }

  _defaultState() {
    return {
      ...DEFAULTS,
      countries: [...DEFAULTS.countries],
      initials: [...DEFAULTS.initials],
      greeted: {},
      submitted: {},
    };
  }

  config() {
    const state = this.state || {};
    const delay = Number(state.welcomeDelayMs);
    return {
      enabled: state.enabled !== false,
      lobbyJid: state.lobbyJid || "",
      generalJid: state.generalJid || "",
      welcomeDelayMs: Number.isFinite(delay) ? Math.max(0, Math.min(120000, delay)) : DEFAULTS.welcomeDelayMs,
      generalCode: state.generalCode || "",
      generalCodeAt: Number(state.generalCodeAt) || 0,
      minAge: Number(state.minAge) || 0,
      countries: Array.isArray(state.countries) ? [...state.countries] : [],
      initials: Array.isArray(state.initials) ? [...state.initials] : [],
      excuse: state.excuse || "",
      greeted: state.greeted || {},
      submitted: state.submitted || {},
    };
  }

  setEnabled(value) {
    this.state.enabled = Boolean(value);
  }

  setLobby(jid) {
    this.state.lobbyJid = jid || "";
  }

  setGeneral(jid) {
    this.state.generalJid = jid || "";
  }

  setWelcomeDelay(ms) {
    const value = Number(ms);
    this.state.welcomeDelayMs = Number.isFinite(value) ? Math.max(0, Math.min(120000, value)) : DEFAULTS.welcomeDelayMs;
  }

  markGreeted(jid) {
    if (!this.state.greeted) this.state.greeted = {};
    this.state.greeted[jid] = Date.now();
  }

  wasGreeted(jid) {
    return Boolean(this.state.greeted?.[jid]);
  }

  markSubmitted(jid) {
    if (!this.state.submitted) this.state.submitted = {};
    this.state.submitted[jid] = Date.now();
  }

  wasSubmitted(jid) {
    return Boolean(this.state.submitted?.[jid]);
  }

  setGeneralCode(code, at = Date.now()) {
    this.state.generalCode = code || "";
    this.state.generalCodeAt = at;
  }

  // Filtros de admisión: edad mínima, países y primeras letras del nombre.
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
}

let instance = null;

export function getLobbyStore() {
  if (!instance) instance = new LobbyStore();
  return instance;
}
