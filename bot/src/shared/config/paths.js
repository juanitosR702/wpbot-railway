import { join } from "path";
import { tmpdir } from "os";

// Runtime files are disposable; persistent state belongs exclusively in MongoDB.
export const DATA = {
  stickers: join(tmpdir(), "bot-whatsapp", "stickers"),
};