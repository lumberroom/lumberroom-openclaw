# Changelog

## [Unreleased]

## [1.1.0] - 2026-10-21

### Added

- The digest follows the session's first request. The plugin sends that request to `context_bootstrap` as `query` when it has 12 characters or more after trimming and is no slash command. The Codex app-server harness sends the request alone as `currentUserMessage`, and the plugin reads that. On the acpx harness the prompt carries OpenClaw's inbound chat context ahead of the request, and the plugin strips the marked context blocks, the active goal line and the message-tool delivery hint before it measures or sends anything. A Telegram reply-quote block stays in. A room event (`messages.groupChat.unmentionedInbound: "room_event"`) sends no query. An engine with decision 0034 ([lumberroom/lumberroom](https://github.com/lumberroom/lumberroom) [PR #159](https://github.com/lumberroom/lumberroom/pull/159)) adds up to four related facts by default and orders the profile by relevance. When the first turn carries no request (a bare `/new` or `/reset`, a greeting, a slash command), the plugin serves a digest without `query` and refetches it once on the first turn that has one; that turn changes the system prompt once and costs one call. Every later turn reuses the digest's bytes. Heartbeat turns and turns with no session key send no query. Any `tool_error` on a call that carried `query` gets one retry without it in the same turn, within `digestTimeoutMs`; an older engine ignores `query`. `digestQuery: false` turns it off.

## [1.0.3] - 2026-10-13

### Changed

- `lr-review` follows the engine's larger `review_queue` read: up to 50 items per source. On a queue past 50 it works one source at a time, narrows `source` and pages with `offset` inside it, and reads every page of a source before it splits the work across workers. Merged text drops the `----- data` marker lines, which the engine refuses with `content_carries_fence`.

## [1.0.2] - 2026-10-06

### Changed

- `lr-review` works undated facts: it fills a start date the fact's own text names, through `review_queue` source `undated` and the `fill_date` verdict. Needs a server with the `undated` source.

## [1.0.1] - 2026-10-06

### Added

- Ships the `lr-review` skill for working the dreaming review queue.

## [1.0.0] - 2026-09-26

The first release, for OpenClaw 2026.9.6 and later on Node 24.16 or 26.1 and later.

### Added

- lumberroom takes OpenClaw's memory slot as a plugin of kind `memory`, against lumberroom.cloud or
  a self-hosted engine.
- Recall on every eligible turn. The `context_bootstrap` digest enters the system prompt once per
  session and stays byte-identical across its turns. `memory_search` hits for the user's message
  go ahead of that message for the model only.
- The engine's own tools under their own names: `memory_search`, `memory_write`, `registry_get` and
  `memory_forget` by default, with the descriptions and schemas the engine serves. `tools` in the
  config picks from the rest. `dreamingReview` adds `review_queue` and `review_decide` on
  lumberroom.cloud.
- An owner gate for shared chats. Group, channel and thread turns reach memory only when the sender
  is listed in `ownerIds`, and so does a turn from a room on the main or global session when
  `session.groupScope` or `session.scope` routes rooms there. The Control UI, the TUI and the CLI
  keep their digest and recall there. A refused turn gets no digest, no
  recall, no tools and no engine call.
- A write guard. `write`, `edit` and `apply_patch` against `MEMORY.md`, `USER.md` or `memory/` in
  the workspace are blocked with a reason that points the model at `memory_write`. The guard reads
  `@`, `~/` and `file://` targets the way OpenClaw's tools do and ignores letter case on macOS and
  Windows. It stays on when the config is invalid.
- Two sign-in modes. `token` reads a static bearer or an `lr_` API token from
  `$OPENCLAW_STATE_DIR/.env`. `oauth` signs in through a browser or a pasted redirect URL, and
  refreshes under a file lock, so a gateway and a CLI process sharing one token file never replay a
  refresh token.
- `openclaw lumberroom setup`, `login`, `logout`, `status` and `import`. Setup takes the memory
  slot, grants conversation access, turns off both switches that would load `memory-core` as a
  dreaming sidecar, and adds `tools.alsoAllow` where the tool profile would hide the plugin's
  tools. `status` names every problem it finds. `import` sends existing `MEMORY.md`, `USER.md` and
  `memory/*.md` entries to the engine's review queue, never straight into the store.
- The gateway logs an error at start when either dreaming-sidecar switch is open.
- A bundled snapshot of the engine's tool listing, so the plugin offers its tools before the first
  live `tools/list` answers, and a cache of the last live listing under the state directory.
- Setup turns off OpenClaw's `session-memory` hook, which writes `memory/*.md` through `fs` where
  the write guard cannot see it; `status` names it when it is on.
- With owners listed, setup sets the message queue to `followup`, so a non-owner's message cannot
  steer into an owner's running turn, and its overflow to `drop: "old"`, so dropped messages never
  fold into one turn; `status` names any `steer` or `collect` mode and a `summarize` drop.
