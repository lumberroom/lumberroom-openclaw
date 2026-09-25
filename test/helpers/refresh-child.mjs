// One OpenClaw process's view of the token file, for test/unit/fence-process.test.ts.
//   node test/helpers/refresh-child.mjs <engine base URL> <state dir>
// Prints "ready" once the handle exists, then "ok <sha256 prefix of the bearer>" or the error's name.
// It runs the built dist/, so `npm run build` has to come first.
import { createHash } from "node:crypto";
import { createOAuthAuth } from "../../dist/auth/oauth.js";
import { resolveConfig } from "../../dist/config.js";

const [baseUrl, stateDir] = process.argv.slice(2);
const auth = createOAuthAuth(resolveConfig({ baseUrl }), { stateDir });
process.stdout.write("ready\n");
try {
  const bearer = await auth.authorize(AbortSignal.timeout(20_000));
  await auth.settle(3000);
  process.stdout.write(`ok ${createHash("sha256").update(bearer).digest("hex").slice(0, 16)}\n`);
} catch (e) {
  process.stdout.write(`${e instanceof Error ? e.name : "Error"}\n`);
}
