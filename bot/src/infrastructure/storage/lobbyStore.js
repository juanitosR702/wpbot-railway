import BaseStore from "../database/baseStore.js";

// Estado del flujo lobby -> general:
//   lobbyJid/generalJid  grupos enlazados (se configuran con `!lobby aqui ...`)
//   welcomeDelayMs       espera antes de saludar (el recién llegado todavía no
//                        ve el grupo, por eso el mensaje se perdía)
//   generalCode          código de invitación vigente del grupo general
//   greeted[jid]         a quién ya se saludó (evita duplicados del evento)
//   submitted[jid]       quién ya envió su ficha (habilita la entrada a general)
//
// Un documento por colección (`_id: "state"`), igual que el resto de stores.
const DEFAULTS = {
  enabled: true,
  lobbyJid: "",
  generalJid: "",
  welcomeDelayMs: 5000,
  generalCode: "",
  generalCodeAt: 0,
};

export class LobbyStore extends BaseStore {
  constructor() {
    super("lobby");
  }

  _defaultState() {
    return { ...DEFAULTS, greeted: {}, submitted: {} };
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
}

let instance = null;

export function getLobbyStore() {
  if (!instance) instance = new LobbyStore();
  return instance;
}
