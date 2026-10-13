import { getDb } from "../database/connection.js";
import { env } from "../../shared/config/env.js";
import { jidFromNumber, normalizeJid } from "../../shared/utils/jid.js";

const DEFAULT_CREATOR_NUMBERS = ["573126068076"];
const DEFAULT_BOT_NUMBERS = ["573026525974"];

let _ready = false;
let _state = { numbers: [], jids: [] };
let _collection = null;

export async function initOwnerStorage() {
  if (_ready) return;
  const db = await getDb();
  _collection = db.collection("owner");
  const doc = await _collection.findOne({ _id: "protected" });
  if (doc) {
    const { _id, ...data } = doc;
    _state = {
      numbers: Array.isArray(data.numbers) ? data.numbers : [],
      jids: Array.isArray(data.jids) ? data.jids : [],
    };
  } else {
    _state = { numbers: [], jids: [] };
    await _collection.insertOne({ _id: "protected", ..._state });
  }
  _ready = true;
}

async function _save() {
  if (!_collection) return;
  await _collection.updateOne(
    { _id: "protected" },
    { $set: _state },
    { upsert: true },
  );
}

export function creatorNumbers() {
  const configured = env("CREATOR_NUMBERS", "")
    .split(",")
    .map((item) => item.replace(/\D/g, ""))
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_CREATOR_NUMBERS;
}

export function botNumbers() {
  const configured = env("BOT_NUMBERS", "")
    .split(",")
    .map((item) => item.replace(/\D/g, ""))
    .filter(Boolean);
  return configured.length ? configured : DEFAULT_BOT_NUMBERS;
}

export function creatorJids() {
  return creatorNumbers().map(jidFromNumber).filter(Boolean);
}

export function botNumberJids() {
  return botNumbers().map(jidFromNumber).filter(Boolean);
}

// LID del bot (en grupos nuevos WhatsApp identifica por @lid, que es un
// número DISTINTO al teléfono). Se configura con BOT_LIDS=58601255227546
// (se aceptan varios separados por coma, con o sin @lid).
export function botLids() {
  const configured = env("BOT_LIDS", "")
    .split(",")
    .map((item) => {
      const text = String(item || "").trim();
      if (text.includes("@lid")) return text.split("@")[0].split(":")[0].replace(/\D/g, "");
      return text.replace(/\D/g, "");
    })
    .filter(Boolean);
  return configured;
}

export function botLidJids() {
  return botLids()
    .map((lid) => (lid ? `${lid}@lid` : null))
    .filter(Boolean);
}

export function extraProtectedEntries() {
  return {
    numbers: _state.numbers.map((item) => String(item).replace(/\D/g, "")).filter(Boolean),
    jids: _state.jids.map(normalizeJid).filter(Boolean),
  };
}

export function extraProtectedJids() {
  const entries = extraProtectedEntries();
  return [...entries.jids, ...entries.numbers.map(jidFromNumber).filter(Boolean)];
}

export function addProtectedTarget(target) {
  const number = String(target || "").replace(/\D/g, "");
  const jid = String(target || "").includes("@") ? normalizeJid(target) : "";
  if (number && !_state.numbers.includes(number)) _state.numbers.push(number);
  if (jid && !_state.jids.includes(jid)) _state.jids.push(jid);
  _save();
  return { number, jid };
}

export function removeProtectedTarget(target) {
  const number = String(target || "").replace(/\D/g, "");
  const jid = String(target || "").includes("@") ? normalizeJid(target) : "";
  _state.numbers = _state.numbers.filter((item) => item !== number);
  _state.jids = _state.jids.filter((item) => item !== jid);
  _save();
  return { number, jid };
}

export function createOwnerRepository() {
  return {
    creatorNumbers,
    botNumbers,
    creatorJids,
    botNumberJids,
    botLids,
    botLidJids,
    extraProtectedEntries,
    extraProtectedJids,
    addProtectedTarget,
    removeProtectedTarget,
  };
}
