import { getDb } from "./connection.js";

export default class BaseStore {
  constructor(collectionName) {
    this.collectionName = collectionName;
    this._ready = false;
    this._readyPromise = null;
    this.state = null;
    this.collection = null;
  }

  async ready() {
    if (this._ready) return;
    if (this._readyPromise) return this._readyPromise;
    this._readyPromise = (async () => {
      const db = await getDb();
      this.collection = db.collection(this.collectionName);
      this.state = await this._load();
      this._ready = true;
    })();
    try {
      await this._readyPromise;
    } finally {
      this._readyPromise = null;
    }
  }

  async _load() {
    try {
      const doc = await this.collection.findOne({ _id: "state" });
      if (!doc) {
        const defaultState = this._defaultState();
        await this.collection.insertOne({ _id: "state", ...defaultState });
        return defaultState;
      }
      const { _id, ...data } = doc;
      return { ...this._defaultState(), ...data };
    } catch (err) {
      console.error(`[${this.collectionName}] No se pudo cargar estado:`, err);
      return this._defaultState();
    }
  }

  async save() {
    try {
      if (!this.collection || !this.state) return;
      const { _id, ...data } = this.state;
      await this.collection.updateOne(
        { _id: "state" },
        { $set: data },
        { upsert: true },
      );
    } catch (err) {
      console.error(`[${this.collectionName}] No se pudo guardar estado:`, err);
    }
  }

  _defaultState() {
    return {};
  }
}
