# @lumberroom/openclaw

lumberroom as OpenClaw's memory. Recall lands on every eligible turn, and writes go through the
engine's own tools under their own names. Works against lumberroom.cloud or a self-hosted engine,
same code either way.

## What it does

- **Recall on every eligible turn.** A `context_bootstrap` digest enters the cacheable system
  prompt once per session, byte-identical on every turn of that session. `memory_search` hits for
  the user's message go ahead of that message, for the model only; they never land in the
  transcript.
- **The engine's own tools, under their own names.** `memory_search`, `memory_write`,
  `registry_get`, and `memory_forget` when the credential carries `mayDelete`, with the
  descriptions and schemas the engine itself serves from `tools/list`.
- **One durable store.** The plugin takes OpenClaw's `plugins.slots.memory` and turns off the two
  switches that would load `memory-core` beside it as a dreaming sidecar. `MEMORY.md`, `USER.md`
  and `memory/**` in the workspace become read-only: a `before_tool_call` guard blocks `write`,
  `edit` and `apply_patch` against them. `openclaw lumberroom import` sends what is already in
  those files to the engine's review queue, never straight into the store.

The plugin writes no fact on its own. A fact enters memory only when the model calls
`memory_write`.

## Install

From npm, once the package is published there:

```
openclaw plugins install @lumberroom/openclaw
```

From a GitHub release, which works today. OpenClaw's `npm-pack:` source reads a local file, so
download the tarball first:

```
curl -LO https://github.com/lumberroom/lumberroom-openclaw/releases/download/v1.0.0/lumberroom-openclaw-1.0.0.tgz
openclaw plugins install npm-pack:./lumberroom-openclaw-1.0.0.tgz --force --accept-capabilities
```

A `git:` install does not work: the repository carries no built `dist/`, and OpenClaw does not run
the build.

The plugin declares tools, conversation-access hooks, a CLI command and a background service, so
OpenClaw asks for a capability review before it loads. A non-interactive install passes
`--accept-capabilities` instead of answering the prompt.

```
openclaw lumberroom setup
```

Setup writes the config and takes the memory slot; it restarts the gateway for you. If it did
not, run `openclaw gateway restart` before the plugin is live.

## Setting up

`openclaw lumberroom setup` asks:

1. **Deployment.** Press Enter for lumberroom.cloud, or name a self-hosted engine's URL.
2. **Sign-in.** Hosted offers a browser sign-in first and a pasted `lr_...` API token second.
   Self-hosted asks for `oauth` or `token` directly. A self-hosted engine running
   `AUTH_MODE=token` only accepts `token`; one running OAuth accepts either.
3. **Validation**, before anything is saved. Token mode reads the token with echo off and checks
   it against `GET /admin/whoami`. OAuth mode runs the sign-in into a staging copy and then
   `tools/list`. A failure here prints the reason and saves nothing; the gateway's current sign-in
   stays in place until you confirm.
4. **Dreaming review**, hosted only, default no: whether OpenClaw may list and act on
   lumberroom.cloud's dreaming queue (`review_queue`, `review_decide`).
5. **Owners**, optional: a comma-separated list of `channel:senderId` entries for shared chats.
6. A diff of what will change, then a confirmation before it writes anything. Setup also turns off
   OpenClaw's `session-memory` hook, which writes `memory/*.md` directly, and with owners listed
   sets the message queue to `followup` and its overflow to `drop: "old"` (see The owner gate).
   With `hooks.internal.enabled` on and no entries, OpenClaw loads every hook it finds; listing
   `session-memory` turns that into a list of named hooks, and the diff says so before you confirm.
7. If `MEMORY.md`, `USER.md` or `memory/*.md` already hold entries, an offer to run `import`.

Sign-in for OAuth opens a browser to a loopback callback on `oauthCallbackPort` (default 47632).
A headless host can paste the full redirect URL back at the prompt instead; `--no-browser` on
`openclaw lumberroom login` skips the browser attempt entirely.

Other commands, each under `openclaw lumberroom`:

| command | does |
|---|---|
| `login [--no-browser]` | Runs the OAuth sign-in on its own. Refuses in token mode. |
| `logout` | Deletes the stored OAuth tokens. Does not revoke them on the server. |
| `status [--json]` | Reachability, sign-in, slot ownership, conversation access, both dreaming-sidecar switches, the `session-memory` hook (by OpenClaw's own selection rule), the queue mode and drop policy when owners are listed, the live tool list and server info, and the credential's `may_ingest` / `may_delete` grants. Exits 1 and names every problem it found. |
| `import [--dry-run] [--workspace <dir>]` | See Import below. |

## Configuration

The block lives at `plugins.entries.lumberroom.config`. A value outside its bounds, an unknown
key, or a semantic error (a malformed `baseUrl`, an unlisted tool, an `ownerIds` entry on
`webchat`) leaves the plugin **inert**: no tools, no recall, one warning naming the reason. The
write guard on `MEMORY.md`, `USER.md` and `memory/**` stays registered either way, so a config
typo never reopens the local store.

| key | default | meaning |
|---|---|---|
| `baseUrl` | `https://mcp.lumberroom.cloud` | Engine origin. `http` or `https` only, no query string, fragment or userinfo. |
| `auth` | `oauth` | `oauth` or `token`. |
| `token` | none | Required when `auth` is `token`: a self-hosted `AUTH_TOKENS` bearer or a hosted `lr_` API token. Setup stores it as `LUMBERROOM_OPENCLAW_TOKEN` in `$OPENCLAW_STATE_DIR/.env`. |
| `project` | `auto` | `auto` takes the first entry of the turn's active project keys; `none` sends no project; anything else is sent as given. |
| `recall` | `true` | Master switch for both prompt hooks. |
| `digest` | `true` | Send the per-session digest. |
| `digestMaxChars` | `6000` | Digest cap, 0 to 50000. Matches the engine's `BOOTSTRAP_MAX_CHARS` default. Design target. |
| `recallLimit` | `4` | `memory_search` result limit, 1 to 20. Design target. |
| `recallMaxChars` | `1200` | Per-turn hits block cap, 0 to 20000. Design target. |
| `reviewInterval` | `10` | Eligible turns between write nudges, 0 to 1000; 0 turns the nudge off. Design target. |
| `tools` | `["memory_search","memory_write","registry_get","memory_forget"]` | Allowlist. Every entry must be a name the engine declares other than `review_queue` and `review_decide`, which only `dreamingReview` controls. The credential's own grant filters further. |
| `ownerIds` | `[]` | Shared-chat owners as `channel:senderId`, for example `telegram:123456789`. An empty list refuses every group, channel and thread. An entry on the `webchat` channel is refused: that transport hands the caller the session key and no verified sender. |
| `triggers` | `["user","cron"]` | Turn triggers that reach memory: `user`, `cron`, `heartbeat`. `cron` counts as the owner by default. |
| `dreamingReview` | `false` | Exposes `review_queue` and `review_decide` to the model. Only takes effect against lumberroom.cloud, and only when the live `tools/list` offers them. |
| `digestTimeoutMs` | `4000` | Bound on the digest fetch, 500 to 14000. Design target. |
| `recallTimeoutMs` | `3000` | Bound on the per-turn search, 500 to 14000. Design target. |
| `toolTimeoutMs` | `20000` | Bound on a model tool call, 1000 to 120000. Design target. |
| `connectTimeoutMs` | `3000` | TCP and TLS connect bound, 500 to 30000. Design target. |
| `oauthCallbackPort` | `47632` | Fixed loopback port for sign-in, 1024 to 65535. Fixed because a DCR client registers one exact redirect URI. |
| `dreaming` | `{enabled: false}` | Read by OpenClaw's own memory host, not by this plugin's logic beyond the sidecar check. Setup writes it; leave it alone. |

## The owner gate

The digest is the owner's entire readable store, so only the owner's turns reach it. The gate
runs in the tool factory and in both prompt hooks, in this order:

1. An incognito session is refused. Nothing about it should persist.
2. A subagent session is refused. The plugin cannot see which turn spawned it.
3. A trigger outside `triggers` is refused.
4. A **shared session** (a group, channel or thread) is refused unless `ownerIds` is non-empty,
   the turn carries a sender id, and `channel:senderId` is in that list. When `session.groupScope`
   is `main` (globally or on a binding) or `session.scope` is `global`, rooms land on the main or
   global session, so a turn there that may have come from a room is held to the same rule.
5. Everything else (direct chats, the main session, cron, ACP, local CLI, TUI, the Control UI) is
   allowed.

A refused turn gets no digest, no recall, no tools, and makes no request to the engine at all.

Consequences worth knowing:

- OpenClaw's default queue mode steers a message that arrives mid-run into the running turn,
  whoever sent it, and that turn keeps its tools. With owners listed, setup sets
  `messages.queue.mode` (and any `steer` or `collect` entry under `byChannel`) to `followup` so
  each message gets its own gated turn; `status` flags anything else. A `/queue steer` typed in
  the chat still overrides it for that session.
- When the queue overflows, OpenClaw's default drop policy, `summarize`, folds the dropped messages
  into one synthetic turn, whoever sent them. With owners listed, setup sets `messages.queue.drop`
  to `old`; `status` flags `summarize`.
- With `groupScope` `main` or `scope` `global`, the plugin reads the room from the turn. A turn
  whose chat id differs from both the channel and the sender counts as a room, and so does a turn
  with a sender and no chat. A Telegram DM, whose chat id is the sender's id, does not. A Slack or
  Discord DM has its own channel id and counts as a room, so list yourself in `ownerIds`. The
  Control UI, the TUI and the CLI speak on OpenClaw's internal `webchat` channel and never count.
- Whoever OpenClaw's own DM policy admits to a direct chat reaches the owner's memory. This plugin
  does not add a second access check on top of OpenClaw's.
- A per-turn recall block never enters the transcript, so a later message in a shared chat cannot
  replay it. Anything the model quotes from it in its reply is visible to the room, same as any
  other reply.
- `cron` counts as the owner by default. Drop it from `triggers` if a cron job's output reaching a
  chat is not wanted.
- The gateway's HTTP chat surfaces (OpenAI-compatible, OpenResponses) run on the internal
  `webchat` channel, where no sender id exists and `ownerIds` cannot name one; those surfaces need
  the gateway operator's own credential, which OpenClaw already treats as the owner.

## Failure behavior

There is no local write buffer. A buffer would be a second durable store, and a replayed write
would skip the engine's own duplicate check.

| condition | digest and recall | a tool call |
|---|---|---|
| engine unreachable (DNS, refused connection) | nothing this turn; an outage line once, then a breaker opens after 3 consecutive failures (design target) for 60 seconds (design target) | "lumberroom unreachable at `<host>`: `<reason>`." plus a tail naming what was not stored |
| a proxy answers 502 or 503 | as above | as above, since neither proves the request reached the engine |
| any other 5xx, or the connection drops after the request sent | as above | "The call may have taken effect; search before retrying." |
| the engine answers with a tool error | that part is skipped this turn | the engine's own error text, verbatim |
| token mode, 401 | nothing | "lumberroom refused the configured token (401). Check `plugins.entries.lumberroom.config.token` and its grant." |
| OAuth, not signed in or the refresh was refused | a login line once per session | "lumberroom is not signed in. Run: `openclaw lumberroom login`" |
| OAuth, access token near expiry with a live refresh token | one refresh runs under a cross-process lock; the call proceeds once it lands | same |
| OAuth, the refresh answered 5xx | the engine may have spent the refresh token, so it is dropped; calls use the access token until it expires, then the login line | "lumberroom is not signed in" after expiry |
| config invalid | an inert line once per session | no lumberroom tool is offered at all |
| the owner gate refuses the turn | nothing | no lumberroom tool is offered at all |

Every recall failure fails open: the model's turn continues without memory rather than stalling
on it. The write guard on `MEMORY.md`, `USER.md` and `memory/**` is the one hook that fails
closed, matching OpenClaw's own default for `before_tool_call`.

## Import

`openclaw lumberroom import [--dry-run] [--workspace <dir>]` reads `MEMORY.md` into `global`,
`USER.md` into `user:me`, and every top-level `memory/*.md` into `global`, then posts each entry
to the engine's proposal queue, never straight into the store. The import speaker is
`main_model`, which the engine never auto-approves, so every imported entry waits in
`lumberroom ingest review` (or the queue in the lumberroom.cloud console) regardless of how many
times import runs. A rerun reinforces existing proposals instead of duplicating them.

A 403 means the credential lacks `mayIngest`: add `"mayIngest": true` to the `AUTH_TOKENS` grant,
or consent with the `full` profile on lumberroom.cloud, and exit code 2 marks that case.
`--dry-run` prints each entry and its target namespace and posts nothing; the source files are
never modified either way.

## What v1 does not do

- No automatic capture of any kind. A fact enters memory only when the model calls `memory_write`.
- No local write queue or retry. A write either reaches the engine or it does not.
- No token revocation on `logout`; it only deletes the local file.
- No memory `runtime`, so OpenClaw keeps injecting `MEMORY.md` and `USER.md` as bootstrap context.
  The write guard makes them read-only; it does not stop the read.
- No guard on `exec`. A shell command run through `exec` can still write the memory files; only
  `write`, `edit` and `apply_patch` are blocked.
- No non-interactive `setup`. Scripted installs write config directly with `openclaw config set`.

## Using lumberroom without this plugin

An OpenClaw host that should not carry a lumberroom-specific plugin can still reach the same
engine as a plain MCP server:

```json5
{
  mcp: {
    servers: {
      lumberroom: {
        url: "https://mcp.lumberroom.cloud/mcp",
        transport: "streamable-http",
        auth: "oauth",
      },
    },
  },
}
```

```
openclaw mcp login lumberroom
```

Recall in that path is not forced onto every turn; the model calls `context_bootstrap` and
`memory_search` on its own, the way it calls any MCP tool. Point the model at
`client/AGENTS.md.snippet` in the [engine repository](https://github.com/the-cybersapien/lumberroom)
for the read and write instructions this plugin otherwise builds in.

## License

Apache-2.0. See `LICENSE`.
