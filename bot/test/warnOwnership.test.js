import { test } from "node:test";
import assert from "node:assert";
import { Router } from "../src/interfaces/bot/router.js";
import { groupAdminPlugin } from "../src/interfaces/commands/groupAdmin/index.js";
import { moderationPlugin } from "../src/interfaces/commands/moderation/index.js";

test("!warn/!warnings: un solo dueño (group_admin), moderation ya no los registra", () => {
  const router = new Router({ prefix: "!" });
  router.registerPlugin(groupAdminPlugin, {});
  router.registerPlugin(moderationPlugin, {});

  const owned = router.getCommands().filter(
    (c) => c.command === "warn" || c.command === "warnings",
  );

  assert.ok(owned.length > 0);
  assert.ok(owned.some((c) => c.command === "warn"));
  assert.ok(owned.some((c) => c.command === "warnings"));
  assert.ok(owned.every((c) => c.plugin === "group_admin"));
});
