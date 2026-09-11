import { test, mock } from "node:test";
import assert from "node:assert";

const PHONE = "120363123456789";
const GROUP_JID = `${PHONE}@g.us`;
const ADMIN = "573123456789@s.whatsapp.net";
const BOT = "57420105691274@s.whatsapp.net";

const fakeCollection = {
  findOne: async () => null,
  insertOne: async () => {},
  updateOne: async () => {},
};
const fakeDb = { collection: () => fakeCollection };

mock.module(new URL("../src/infrastructure/database/connection.js", import.meta.url), {
  exports: { getDb: async () => fakeDb, closeDb: async () => {} },
});

const { Router } = await import("../src/interfaces/bot/router.js");
const { groupAdminPlugin } = await import("../src/interfaces/commands/groupAdmin/index.js");
const { antiNsfwPlugin } = await import("../src/interfaces/commands/antiNsfw/index.js");
const { AntiNsfwStore } = await import("../src/infrastructure/storage/antiNsfwStore.js");

const metadata = {
  id: GROUP_JID,
  subject: "Test",
  participants: [
    { id: ADMIN, admin: "admin" },
    { id: BOT, admin: "admin" },
  ],
};

const services = {
  botJid: BOT,
  getGroupMetadata: async () => metadata,
  updateGroupSetting: async () => {},
  updateParticipants: async () => {},
  sendMessage: async () => {},
  deleteMessage: async () => {},
  downloadMedia: async () => Buffer.alloc(0),
  inviteCode: async () => "CODE",
  revokeInvite: async () => {},
  leaveGroup: async () => {},
  shutdown: async () => {},
  restart: async () => {},
};

function openMessage() {
  return {
    key: {
      remoteJid: GROUP_JID,
      participant: ADMIN,
      fromMe: false,
      id: "t-" + Math.random().toString(36).slice(2),
    },
    pushName: "Admin",
    message: { conversation: "!open" },
  };
}

test("!open: lo registra solo anti_nsfw (group_admin ya no lo reclama)", () => {
  const router = new Router({ prefix: "!" });
  router.registerPlugin(groupAdminPlugin, {});
  router.registerPlugin(antiNsfwPlugin, {});

  const owned = router.getCommands().filter((c) => c.command === "open");
  assert.strictEqual(owned.length, 1);
  assert.strictEqual(owned[0].plugin, "anti_nsfw");
});

test("!open: un grupo cerrado por NSFW se reabre y resetea contadores", async () => {
  const router = new Router({ prefix: "!" });
  router.registerPlugin(groupAdminPlugin, {});
  router.registerPlugin(antiNsfwPlugin, {});

  const store = AntiNsfwStore._instances[AntiNsfwStore._instances.length - 1];
  store._ready = true;
  store.state = { groups: {}, logs: [] };
  store.collection = fakeCollection;

  const group = store.group(PHONE);
  group.closed = true;
  group.consecutiveNsfw = 9;
  group.consecutiveErrors = 2;
  group.consecutiveMedia = 4;

  const reply = await router.route(openMessage(), services);

  assert.strictEqual(typeof reply, "string");
  const after = store.group(PHONE);
  assert.strictEqual(after.closed, false);
  assert.strictEqual(after.consecutiveNsfw, 0);
  assert.strictEqual(after.consecutiveErrors, 0);
  assert.strictEqual(after.consecutiveMedia, 0);
});
