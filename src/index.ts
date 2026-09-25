import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { configSchema } from "./config.js";

export default definePluginEntry({
  id: "lumberroom",
  name: "lumberroom",
  description: "Durable memory shared with every agent you use, from lumberroom.cloud or a self-hosted engine.",
  kind: "memory",
  configSchema,
  register() {
    throw new Error("W");
  },
});
