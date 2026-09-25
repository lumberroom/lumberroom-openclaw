# Changelog

## [Unreleased]

The first release, 1.0.0, for OpenClaw 2026.9.6 and later on Node 24.16 or 26.1 and later.

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
  is listed in `ownerIds`. A refused turn gets no digest, no recall, no tools and no engine call.
- A write guard. `write`, `edit` and `apply_patch` against `MEMORY.md`, `USER.md` or `memory/` in
  the workspace are blocked with a reason that points the model at `memory_write`. The guard stays
  on when the config is invalid.
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
