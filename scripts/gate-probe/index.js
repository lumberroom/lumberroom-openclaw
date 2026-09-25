// Test only. Runs the global hook runner's hooks with a context the gate chooses, inside the real
// gateway, so the gate needs no model turn (ruling 10). The plugin's openclaw peer links to the host
// package, so getGlobalHookRunner() returns the gateway's own runner (docs/l0.md question 3).
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { getGlobalHookRunner } from "openclaw/plugin-sdk/plugin-runtime";

async function readJson(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function send(res, status, body) {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
  return true;
}

function route(api, path, run) {
  api.registerHttpRoute({
    path,
    auth: "gateway",
    match: "exact",
    async handler(req, res) {
      const runner = getGlobalHookRunner();
      if (!runner) return send(res, 503, { error: "no global hook runner in this module instance" });
      try {
        return send(res, 200, await run(runner, await readJson(req)));
      } catch (err) {
        return send(res, 500, { error: String(err && err.stack ? err.stack : err) });
      }
    },
  });
}

export default definePluginEntry({
  id: "lumberroom-gate-probe",
  name: "lumberroom gate probe",
  description: "Test only.",
  register(api) {
    route(api, "/lumberroom-gate/prompt-build", async (runner, body) => {
      const event = { prompt: body.prompt ?? "", messages: [] };
      const ctx = body.ctx ?? {};
      const ordinary = await runner.runBeforePromptBuild(event, ctx);
      const authorized = await runner.runAuthorizedPromptBuild(event, ctx, {
        toolAuthorityFingerprint: "lumberroom-gate",
        activeToolNames: body.activeToolNames ?? ["memory_search", "memory_write"],
        assertHostActive: () => {},
      });
      return { ordinary: ordinary ?? null, authorized: authorized ?? null };
    });
    // /tools/invoke never offers write, edit or read (docs/l0.md question 4), so the gate drives the
    // before_tool_call guard here with a synthetic call instead.
    route(api, "/lumberroom-gate/tool-call", async (runner, body) => {
      const toolName = body.toolName ?? "write";
      const result = await runner.runBeforeToolCall({ toolName, params: body.params ?? {} }, { ...(body.ctx ?? {}), toolName });
      return { result: result ?? null };
    });
  },
});
