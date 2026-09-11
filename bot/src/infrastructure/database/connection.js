import { MongoClient } from "mongodb";
import { env } from "../../shared/config/env.js";

let client = null;
let db = null;
let connecting = null;

function databaseConfig() {
  const uri = env("MONGODB_URI").trim();
  const name = env("MONGODB_DB", "bot_whatsapp").trim();
  if (!uri) throw new Error("Falta MONGODB_URI. Configúrala en el .env.");
  if (!name) throw new Error("Falta MONGODB_DB.");
  return { uri, name };
}

export async function getDb() {
  if (db) return db;
  if (connecting) return connecting;
  const { uri, name } = databaseConfig();
  connecting = (async () => {
    client = new MongoClient(uri, {
      serverSelectionTimeoutMS: 10_000,
      tls: true,
      retryWrites: true,
      w: "majority",
    });
    await client.connect();
    db = client.db(name);
    return db;
  })();
  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

export async function closeDb() {
  connecting = null;
  if (client) await client.close();
  client = null;
  db = null;
}

export async function databaseHealth() {
  try {
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout en MongoDB")), 2500)
    );
    const ping = (async () => {
      const database = await getDb();
      await database.command({ ping: 1 });
      return { ok: true };
    })();
    return await Promise.race([ping, timeout]);
  } catch (error) {
    return { ok: false, error: error?.message || "MongoDB no disponible" };
  }
}
