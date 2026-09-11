import BaseStore from "../database/baseStore.js";
import { cleanJid } from "../../shared/utils/jid.js";

export class EconomyStore extends BaseStore {
  constructor() {
    super("economy");
  }

  _defaultState() {
    return { groups: {}, transactions: [] };
  }

  async _load() {
    try {
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
    } catch (err) {
      console.error("[economy] No se pudo cargar estado, usando estado limpio:", err);
      return this._defaultState();
    }
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
        balance: 0,
        bank: 0,
        inventory: {},
        cooldowns: {},
        createdAt: new Date().toISOString(),
      };
    }
    if (group.users[key].bank === undefined) group.users[key].bank = 0;
    return group.users[key];
  }

  addBalance(groupId, jid, amount, reason, meta = {}) {
    const user = this.user(groupId, jid);
    user.balance = Math.max(0, Number(user.balance || 0) + amount);
    this.log({ type: "balance", jid, amount, reason, ...meta });
    this.save();
    return user.balance;
  }

  addBank(groupId, jid, amount, reason, meta = {}) {
    const user = this.user(groupId, jid);
    user.bank = Math.max(0, (user.bank || 0) + amount);
    this.log({ type: "bank", jid, amount, reason, ...meta });
    this.save();
    return user.bank;
  }

  transferToBank(groupId, jid, amount) {
    const user = this.user(groupId, jid);
    if (amount <= 0) return { ok: false, reason: "Monto invalido." };
    if (user.balance < amount) return { ok: false, reason: "No tienes esa cantidad en tu cartera." };
    user.balance -= amount;
    user.bank += amount;
    this.log({ type: "deposit", jid, amount });
    this.save();
    return { ok: true, wallet: user.balance, bank: user.bank };
  }

  transferFromBank(groupId, jid, amount) {
    const user = this.user(groupId, jid);
    if (amount <= 0) return { ok: false, reason: "Monto invalido." };
    if (user.bank < amount) return { ok: false, reason: "No tienes esa cantidad en el banco." };
    user.bank -= amount;
    user.balance += amount;
    this.log({ type: "withdraw", jid, amount });
    this.save();
    return { ok: true, wallet: user.balance, bank: user.bank };
  }

  transfer(groupId, from, to, amount) {
    const sender = this.user(groupId, from);
    const receiver = this.user(groupId, to);
    if (amount <= 0) return { ok: false, reason: "Monto invalido." };
    if (sender.balance < amount) return { ok: false, reason: "Fondos insuficientes." };
    sender.balance -= amount;
    receiver.balance += amount;
    this.log({ type: "transfer", from, to, amount });
    this.save();
    return { ok: true, fromBalance: sender.balance, toBalance: receiver.balance };
  }

  addItem(groupId, jid, itemId, quantity = 1) {
    const user = this.user(groupId, jid);
    user.inventory[itemId] = (user.inventory[itemId] || 0) + quantity;
    this.save();
    return user.inventory[itemId];
  }

  log(entry) {
    this.state.transactions.push({ at: new Date().toISOString(), ...entry });
    this.state.transactions = this.state.transactions.slice(-1000);
  }
}
