#!/usr/bin/env bash
# Proves the lumberroom memory plugin for OpenClaw against real engines and a real OpenClaw
# installed from npm, in token mode and then AUTH_MODE=oauth. No model runs anywhere in it.
#
#   POSTGRES_PASSWORD=... ./scripts/openclaw-plugin-test.sh --node ~/.nvm/versions/node/v24.16.0/bin/node
#   ./scripts/openclaw-plugin-test.sh --engine-src ~/work/cbrspn-tech/lumberroom   default ../lumberroom
#   ./scripts/openclaw-plugin-test.sh --openclaw-version 2026.9.6
#   ./scripts/openclaw-plugin-test.sh --keep       keep the scratch databases and the work directory
#   ./scripts/openclaw-plugin-test.sh --capture    rewrite tools-snapshot.json and the transcript, then exit
#
# Two scratch engines, never 8787: token mode on 8794 against lumberroom_openclaw_plugin_test, OAuth
# on 8795 against lumberroom_openclaw_plugin_oauth_test. The gateway listens on 18979. Every
# OpenClaw command runs under env -i with a throwaway HOME, OPENCLAW_STATE_DIR and
# OPENCLAW_CONFIG_PATH, so the owner's ~/.openclaw and any model key in this shell never reach it.
#
# How hooks run without a model: POST /tools/invoke runs a tool through OpenClaw's own policy path
# with no agent turn (OC/src/gateway/tools-invoke-shared.ts:355-452). The test-only plugin in
# scripts/gate-probe exposes /lumberroom-gate/prompt-build and /lumberroom-gate/tool-call, which run
# the global hook runner's before_prompt_build and before_tool_call hooks with a context this
# script chooses. /tools/invoke never offers the file tools, so the guard goes through the probe.
#
# What this does not prove: that OpenClaw's embedded runner builds the same hook context the probe
# sends, that a file tool call the guard blocks leaves the file unwritten, and that a model calls
# memory_write.

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENGINE_SRC="${LUMBERROOM_ENGINE_SRC:-$REPO_DIR/../lumberroom}"
OPENCLAW_VERSION="${OPENCLAW_GATE_VERSION:-2026.9.6}"
NODE_BIN="${OPENCLAW_GATE_NODE:-$(command -v node || true)}"
TOKEN_PORT=8794
OAUTH_PORT=8795
GW_PORT=18979
KEEP=0
CAPTURE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --engine-src) ENGINE_SRC="$2"; shift 2 ;;
    --openclaw-version) OPENCLAW_VERSION="$2"; shift 2 ;;
    --node) NODE_BIN="$2"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    --capture) CAPTURE=1; shift ;;
    -h|--help) sed -n '2,25p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1. See --help." >&2; exit 1 ;;
  esac
done

[ -f "$ENGINE_SRC/scripts/lib/scratch-server.sh" ] || {
  echo "no lumberroom engine checkout at $ENGINE_SRC; pass --engine-src or set LUMBERROOM_ENGINE_SRC" >&2; exit 1; }
ENGINE_SRC="$(cd "$ENGINE_SRC" && pwd)"
for bin in docker curl openssl npm lsof; do
  command -v "$bin" >/dev/null 2>&1 || { echo "$bin is required" >&2; exit 1; }
done
[ -n "$NODE_BIN" ] && [ -x "$NODE_BIN" ] || { echo "no node at '$NODE_BIN'; pass --node" >&2; exit 1; }
# OpenClaw 2026.9.6 declares node >=24.16.0 <25 || >=26.1.0 (OC/package.json:2389-2391).
"$NODE_BIN" -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit((a===24&&b>=16)||(a===26&&b>=1)||a>26?0:1)' \
  || { echo "node $("$NODE_BIN" --version) is outside OpenClaw's range; run: nvm install 24" >&2; exit 1; }
PATH="$(cd "$(dirname "$NODE_BIN")" && pwd):$PATH"
export PATH
for port in "$TOKEN_PORT" "$OAUTH_PORT" "$GW_PORT"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN -t >/dev/null 2>&1; then
    echo "port $port is already in use; stop whatever holds it (a kept run's gateway or engine?)" >&2; exit 1
  fi
done

# The physical path, so it matches the paths OpenClaw writes into its logs.
WORK="$(cd "$(mktemp -d)" && pwd -P)"
NONCE="$(openssl rand -hex 4)"
GW_TOKEN="$(openssl rand -hex 24)"
GW_PID=""
LOGIN_PID=""
CLEANED=0
FAILED=0
say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
pass() { printf '  \033[32mPASS\033[0m  %s\n' "$*"; }
fail() { printf '  \033[31mFAIL\033[0m  %s\n' "$*"; FAILED=1; }
info() { printf '  \033[36mINFO\033[0m  %s\n' "$*"; }
die() { fail "$*"; printf '\nopenclaw-plugin-test FAILED\n'; exit 1; }
# node -e puts its first argument at argv[1]; the "jsq" filler keeps the scripts' argv[2] the first file.
jsq() { node -e "$1" -- jsq "${@:2}"; }

OC_BIN="$WORK/oc/node_modules/.bin/openclaw"
# OpenClaw's own isolated-rehearsal switches (OC/src/infra/update-rehearsal-paths.ts), minus the
# ones that would stop what the gate tests. NO_RESPAWN keeps $! the gateway's own pid.
OC_ENV=(OPENCLAW_NO_RESPAWN=1 OPENCLAW_DISABLE_BONJOUR=1 OPENCLAW_NO_AUTO_UPDATE=1
  OPENCLAW_SKIP_STARTUP_MODEL_PREWARM=1 OPENCLAW_SKIP_CHANNELS=1 OPENCLAW_SKIP_GMAIL_WATCHER=1
  OPENCLAW_SKIP_CANVAS_HOST=1 OPENCLAW_SKIP_BROWSER_CONTROL_SERVER=1)
# oc STATE ARGS...: one throwaway OpenClaw state directory and home per mode.
oc() {
  local st="$1"; shift
  env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" HOME="$st/home" OPENCLAW_STATE_DIR="$st" \
    OPENCLAW_CONFIG_PATH="$st/openclaw.json" "${OC_ENV[@]}" "$OC_BIN" "$@"
}

# seed_state STATE: a config whose only key is logging.file, written before the first OpenClaw
# command, since every command logs to /tmp/openclaw until the config names a file.
seed_state() {
  mkdir -p "$1/home"
  printf '{ "logging": { "file": "%s/openclaw.log" } }\n' "$1" >"$1/openclaw.json"
}

# Kills only a listener whose command line carries this run's work directory.
kill_strays() {
  local pid
  for pid in $(lsof -nP -iTCP:"$GW_PORT" -sTCP:LISTEN -t 2>/dev/null || true); do
    if ps -o command= -p "$pid" 2>/dev/null | grep -qF "$WORK"; then kill -9 "$pid" 2>/dev/null || true; fi
  done
}
stop_gateway() {
  if [ -n "$GW_PID" ]; then
    kill "$GW_PID" 2>/dev/null || true
    local i=0
    while kill -0 "$GW_PID" 2>/dev/null && [ "$i" -lt 20 ]; do sleep 0.5; i=$((i + 1)); done
    kill -9 "$GW_PID" 2>/dev/null || true
    wait "$GW_PID" 2>/dev/null || true
    GW_PID=""
  fi
  kill_strays
}
cleanup() {
  local status=$?
  [ "$CLEANED" = 1 ] && exit "$status"
  CLEANED=1
  [ -n "$LOGIN_PID" ] && kill "$LOGIN_PID" 2>/dev/null || true
  stop_gateway
  scratch_stop 2>/dev/null || true
  [ -n "${TOKEN_SCRATCH_NAME:-}" ] && docker rm -f "$TOKEN_SCRATCH_NAME" >/dev/null 2>&1 || true
  if [ "$KEEP" = 1 ]; then echo "kept $WORK"; else rm -rf "$WORK"; fi
  exit "$status"
}
trap cleanup EXIT INT TERM

psql_q() {
  docker compose -f "$ENGINE_SRC/docker-compose.yml" exec -T db \
    psql -U "${POSTGRES_USER:-lumberroom}" -d "$1" -tAc "$2"
}
wait_ready() {
  local i=0
  until curl -sf "$1/readyz" >/dev/null 2>&1; do i=$((i + 1)); [ "$i" -ge 90 ] && return 1; sleep 2; done
}
post() {  # post PATH BODY OUT -> HTTP status
  curl -sS -o "$3" -w '%{http_code}' -X POST "http://127.0.0.1:$GW_PORT$1" \
    -H "authorization: Bearer $GW_TOKEN" -H 'content-type: application/json' -d "$2"
}
invoke() { post /tools/invoke "$1" "$2"; }
probe() { post /lumberroom-gate/prompt-build "$1" "$2"; }
tool_call() { post /lumberroom-gate/tool-call "$1" "$2"; }
gw_call() {  # gw_call STATE METHOD PARAMS
  oc "$1" gateway call "$2" --params "$3" --json --port "$GW_PORT" --token "$GW_TOKEN"
}
start_gateway() {  # start_gateway STATE LOG
  env -i PATH="$PATH" TMPDIR="${TMPDIR:-/tmp}" HOME="$1/home" OPENCLAW_STATE_DIR="$1" \
    OPENCLAW_CONFIG_PATH="$1/openclaw.json" "${OC_ENV[@]}" \
    "$OC_BIN" gateway run --port "$GW_PORT" --bind loopback --auth token --token "$GW_TOKEN" >"$2" 2>&1 &
  GW_PID=$!
  local i=0
  until oc "$1" gateway health --port "$GW_PORT" --token "$GW_TOKEN" >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -ge 90 ] && return 1
    kill -0 "$GW_PID" 2>/dev/null || return 1
    sleep 1
  done
}
# gw_log_has STATE STDOUT PATTERN: the gateway writes to stdout and to logging.file. Plugin services
# start a few seconds after health answers, so this waits up to 30 seconds for the line.
gw_log_has() {
  local i=0
  until cat "$2" "$1/openclaw.log" 2>/dev/null | grep -q "$3"; do
    i=$((i + 1)); [ "$i" -ge 30 ] && return 1; sleep 1
  done
}
configure() {  # configure STATE WORKSPACE BASE_URL AUTH
  local token_ref=""
  [ "$4" = token ] && token_ref=',"token":{"source":"env","provider":"default","id":"LUMBERROOM_OPENCLAW_TOKEN"}'
  # heartbeat 0m, no provider and no channel keep the gateway from ever starting a model turn. The
  # log goes to logging.file because OpenClaw otherwise writes /tmp/openclaw whatever the state dir.
  oc "$1" config patch --stdin <<JSON
{
  "gateway": { "mode": "local", "port": $GW_PORT, "bind": "loopback", "auth": { "mode": "token", "token": "$GW_TOKEN" },
               "tailscale": { "mode": "off" }, "controlUi": { "enabled": false } },
  "discovery": { "mdns": { "mode": "off" } },
  "logging": { "file": "$1/openclaw.log" },
  "cron": { "enabled": false },
  "messages": { "queue": { "mode": "followup", "drop": "old" } },
  "agents": { "defaults": { "workspace": "$2", "heartbeat": { "every": "0m" } } },
  "plugins": {
    "slots": { "memory": "lumberroom" },
    "entries": {
      "lumberroom": { "enabled": true, "hooks": { "allowConversationAccess": true },
                      "config": { "baseUrl": "$3", "auth": "$4"$token_ref, "ownerIds": ["telegram:4242"], "dreaming": { "enabled": false } } },
      "lumberroom-gate-probe": { "enabled": true },
      "memory-core": { "enabled": false },
      "bonjour": { "enabled": false }
    }
  }
}
JSON
}
prompt_body() {  # prompt_body SESSION_KEY SESSION_ID CHANNEL SENDER WORKSPACE
  printf '{"prompt":"What is the OpenClaw gate nickname?","ctx":{"agentId":"main","sessionKey":"%s","sessionId":"%s","trigger":"user","channel":"%s","senderId":"%s","workspaceDir":"%s"},"activeToolNames":["memory_search","memory_write"]}' "$1" "$2" "$3" "$4" "$5"
}

say "1/19 build and pack the plugin and the probe"
( cd "$REPO_DIR" && npm ci --no-audit --no-fund --silent && npm run build --silent ) || die "build failed"
TGZ="$WORK/$(cd "$REPO_DIR" && npm pack --pack-destination "$WORK" --silent | tail -1)"
PROBE_TGZ="$WORK/$(cd "$REPO_DIR/scripts/gate-probe" && npm pack --pack-destination "$WORK" --silent | tail -1)"
tar -tzf "$TGZ" >"$WORK/tgz.txt"
for want in package/dist/index.js package/openclaw.plugin.json package/tools-snapshot.json package/LICENSE package/CHANGELOG.md; do
  grep -qx "$want" "$WORK/tgz.txt" || fail "the tarball lacks $want"
done
if grep -q '^package/\(test\|scripts\|src\)/' "$WORK/tgz.txt"; then fail "the tarball carries test, scripts or src"; else pass "tarball layout"; fi

say "2/19 OpenClaw $OPENCLAW_VERSION from npm into a throwaway prefix"
npm install --prefix "$WORK/oc" --no-audit --no-fund --silent "openclaw@$OPENCLAW_VERSION" || die "npm install openclaw failed"
seed_state "$WORK/st-version"
oc "$WORK/st-version" --version >"$WORK/version.out" 2>&1 || true
grep -q "$OPENCLAW_VERSION" "$WORK/version.out" && pass "openclaw $OPENCLAW_VERSION" \
  || die "openclaw --version: $(head -1 "$WORK/version.out")"

say "3/19 scratch engine in token mode"
TOKEN="$(openssl rand -hex 32)"
SCRATCH_DB=lumberroom_openclaw_plugin_test
SCRATCH_NAME="${LUMBERROOM_OPENCLAW_PLUGIN_TEST_SERVER:-lumberroom-openclaw-plugin-test-server}"
TOKEN_SCRATCH_NAME="$SCRATCH_NAME"
SCRATCH_PORT=$TOKEN_PORT
SCRATCH_KEEP=$KEEP
SCRATCH_TOKENS="[{\"client\":\"openclaw-plugin-test\",\"token\":\"$TOKEN\",\"read\":[{\"namespace\":\"*\",\"max\":\"private\"}],\"write\":[\"user:me\",\"global\",\"project:*\"],\"mayIngest\":true,\"mayDelete\":true}]"
export SCRATCH_DB SCRATCH_NAME SCRATCH_PORT SCRATCH_KEEP SCRATCH_TOKENS
# shellcheck source=/dev/null
. "$ENGINE_SRC/scripts/lib/scratch-server.sh"
scratch_start || die "the token-mode scratch engine did not start"
URL="$SCRATCH_URL"
pass "engine ready at $URL"

if [ "$CAPTURE" = 1 ]; then
  ( cd "$REPO_DIR" && node scripts/capture.mjs --url "$URL" --token "$TOKEN" \
      --snapshot tools-snapshot.json --transcript test/fixtures/engine_transcript.json )
  exit 0
fi

say "4/19 the checked-in snapshot matches the live engine"
( cd "$REPO_DIR" && node scripts/capture.mjs --url "$URL" --token "$TOKEN" \
    --snapshot "$WORK/snapshot.json" --transcript "$WORK/transcript.json" >/dev/null )
if jsq 'const f=require("fs");const k=p=>{const s=JSON.parse(f.readFileSync(p,"utf8"));return JSON.stringify([s.instructions,s.tools.map(t=>JSON.stringify(t)).sort()])};process.exit(k(process.argv[2])===k(process.argv[3])?0:1)' \
   "$REPO_DIR/tools-snapshot.json" "$WORK/snapshot.json"
then pass "snapshot matches"; else fail "snapshot drifted from the engine: rerun with --capture and review the diff"; fi

say "5/19 a throwaway OpenClaw with the plugin and the probe installed from npm pack"
ST="$WORK/st-token"; WS="$WORK/ws-token"; mkdir -p "$WS"; seed_state "$ST"
# Without --accept-capabilities and with no TTY the install stages, refuses and exits 1 (docs/l0.md question 1).
oc "$ST" plugins install "npm-pack:$TGZ" --force --accept-capabilities </dev/null >"$WORK/install.out" 2>&1 || die "plugin install: $(tail -5 "$WORK/install.out")"
oc "$ST" plugins install "npm-pack:$PROBE_TGZ" --force --accept-capabilities </dev/null >>"$WORK/install.out" 2>&1 || die "probe install: $(tail -5 "$WORK/install.out")"
printf 'LUMBERROOM_OPENCLAW_TOKEN=%s\n' "$TOKEN" >"$ST/.env"; chmod 600 "$ST/.env"
configure "$ST" "$WS" "$URL" token >"$WORK/config.out" 2>&1 || die "config: $(tail -5 "$WORK/config.out")"
oc "$ST" config validate --json >"$WORK/validate.json" 2>&1 && pass "config validates" || fail "config validate: $(head -c 600 "$WORK/validate.json")"

say "6/19 plugins inspect: lumberroom owns the memory slot and memory-core is not loaded"
oc "$ST" plugins inspect lumberroom --runtime --json >"$WORK/inspect.json" 2>"$WORK/inspect.err" \
  || fail "inspect lumberroom: $(tail -3 "$WORK/inspect.err")"
if out="$(jsq '
  const r=JSON.parse(require("fs").readFileSync(process.argv[2],"utf8"));
  const p=r.plugin, hooks=r.typedHooks.map(h=>h.name), tools=r.tools.flatMap(t=>t.names), bad=[];
  if(p.status!=="loaded") bad.push("status "+p.status);
  if(p.kind!=="memory") bad.push("kind "+p.kind);
  if(p.memorySlotSelected!==true) bad.push("memorySlotSelected "+p.memorySlotSelected);
  if(hooks.filter(h=>h==="before_prompt_build").length!==2) bad.push("before_prompt_build hooks: "+hooks.join(","));
  if(!hooks.includes("before_tool_call")) bad.push("no before_tool_call");
  if(!hooks.includes("session_end")) bad.push("no session_end");
  for(const t of ["memory_search","memory_write","registry_get","memory_forget"]) if(!tools.includes(t)) bad.push("no tool "+t);
  if(!r.policy||r.policy.allowConversationAccess!==true) bad.push("allowConversationAccess "+(r.policy&&r.policy.allowConversationAccess));
  const blocked=r.diagnostics.filter(d=>/blocked|conflict/.test(d.message)).map(d=>d.message);
  if(blocked.length) bad.push(blocked.join("; "));
  if(bad.length){console.log(bad.join(", "));process.exit(1)}' "$WORK/inspect.json")"
then pass "lumberroom loaded, kind memory, slot selected, two prompt hooks, the guard, session_end, four tools"; else fail "inspect lumberroom: $out"; fi
oc "$ST" plugins inspect memory-core --json >"$WORK/core.json" 2>/dev/null || true
if out="$(jsq 'const r=JSON.parse(require("fs").readFileSync(process.argv[2],"utf8"));const p=r.plugin;console.log(p.status+": "+(p.activationReason||p.error||""));process.exit(p.status==="disabled"?0:1)' "$WORK/core.json")"
then pass "memory-core $out"; else fail "memory-core: $out"; fi

say "7/19 openclaw lumberroom status reaches the engine"
oc "$ST" lumberroom status >"$WORK/status.out" 2>&1 && grep -q memory_write "$WORK/status.out" \
  && pass "status exits 0 and lists memory_write" || fail "status: $(tail -5 "$WORK/status.out")"

say "8/19 the gateway starts with no heartbeat, both plugins loaded, and its log in the work directory"
start_gateway "$ST" "$WORK/gateway-token.log" || die "the gateway did not start: $(tail -20 "$WORK/gateway-token.log")"
pass "gateway on $GW_PORT"
oc "$ST" gateway health --json --port "$GW_PORT" --token "$GW_TOKEN" >"$WORK/health.json" 2>/dev/null || true
if out="$(jsq '
  const r=JSON.parse(require("fs").readFileSync(process.argv[2],"utf8")), bad=[], loaded=(r.plugins&&r.plugins.loaded)||[];
  if(r.heartbeatSeconds!==0) bad.push("heartbeatSeconds "+r.heartbeatSeconds);
  for(const id of ["lumberroom","lumberroom-gate-probe"]) if(!loaded.includes(id)) bad.push(id+" not loaded");
  if(r.plugins&&r.plugins.errors&&r.plugins.errors.length) bad.push("errors "+JSON.stringify(r.plugins.errors));
  if(bad.length){console.log(bad.join(", "));process.exit(1)}' "$WORK/health.json")"
then pass "heartbeat off; lumberroom and the probe loaded with no plugin error"; else fail "gateway health: $out $(head -c 300 "$WORK/health.json")"; fi
[ -s "$ST/openclaw.log" ] && pass "the gateway logs to logging.file under the work directory" || fail "no log at $ST/openclaw.log"

say "9/19 tool profiles: which hide lumberroom's tools, and setup's tools.alsoAllow rule agrees"
# tools.effective answers only for a stored session; sessions.create starts no run (docs/l0.md question 5).
gw_call "$ST" sessions.create '{"key":"agent:main:main"}' >"$WORK/session.json" 2>&1 || fail "sessions.create: $(tail -3 "$WORK/session.json")"
# effective_tools PROFILE OUT: waits for the hot reload to report PROFILE, then lists lumberroom's tools.
effective_tools() {
  local i=0
  while :; do
    gw_call "$ST" tools.effective '{"sessionKey":"agent:main:main"}' >"$2" 2>/dev/null || true
    if jsq 'const r=JSON.parse(require("fs").readFileSync(process.argv[2],"utf8"));process.exit(r.profile===process.argv[3]?0:1)' "$2" "$1" 2>/dev/null; then break; fi
    i=$((i + 1)); [ "$i" -ge 30 ] && return 1; sleep 1
  done
  jsq 'const r=JSON.parse(require("fs").readFileSync(process.argv[2],"utf8"));console.log(r.groups.flatMap(g=>g.tools).filter(t=>t.pluginId==="lumberroom").map(t=>t.id).sort().join(","))' "$2"
}
ALL_TOOLS="memory_forget,memory_search,memory_write,registry_get"
for profile in full minimal coding messaging; do
  # alsoAllow goes first, so once tools.effective reports the new profile it has seen both writes.
  oc "$ST" config unset tools.alsoAllow >/dev/null 2>&1 || true
  oc "$ST" config set tools.profile "$profile" >"$WORK/profile.out" 2>&1 || { fail "set tools.profile $profile: $(tail -3 "$WORK/profile.out")"; continue; }
  bare="$(effective_tools "$profile" "$WORK/eff-$profile.json")" || { fail "tools.effective never reported profile $profile: $(head -c 300 "$WORK/eff-$profile.json")"; continue; }
  oc "$ST" config set tools.alsoAllow '["lumberroom"]' --strict-json >>"$WORK/profile.out" 2>&1
  allowed=""
  for _ in $(seq 1 15); do
    allowed="$(effective_tools "$profile" "$WORK/eff-$profile-also.json")" || true
    [ "$allowed" = "$ALL_TOOLS" ] && break
    sleep 1
  done
  [ "$allowed" = "$ALL_TOOLS" ] && pass "$profile + alsoAllow lumberroom: $allowed" || fail "$profile + alsoAllow lumberroom lists [$allowed]"
  hides=false; [ "$bare" != "$ALL_TOOLS" ] && hides=true
  rule="$(cd "$REPO_DIR" && node --input-type=module -e '
    const { planSetup } = await import("./dist/setup.js");
    const plan = planSetup({ tools: { profile: process.argv[1] } }, { deployment: "self", baseUrl: "http://127.0.0.1:8794", auth: "token", token: "t", dreamingReview: false, ownerIds: [] });
    console.log(plan.addToolsAlsoAllow);' "$profile")"
  if [ "$rule" = "$hides" ]; then pass "$profile lists [$bare]; setup adds tools.alsoAllow: $rule"
  else fail "$profile lists [$bare] but setup's addToolsAlsoAllow is $rule"; fi
done
oc "$ST" config unset tools.alsoAllow >/dev/null 2>&1 || true
oc "$ST" config unset tools.profile >/dev/null 2>&1 || true
effective_tools full "$WORK/eff-reset.json" >/dev/null || fail "tools.profile did not return to full"

say "10/19 a nonce written through /tools/invoke"
code="$(invoke "{\"tool\":\"memory_write\",\"sessionKey\":\"agent:main:main\",\"args\":{\"content\":\"The OpenClaw gate nickname is OCLARK-$NONCE.\",\"namespace\":\"user:me\"}}" "$WORK/write.json")"
[ "$code" = 200 ] && grep -q '"id' "$WORK/write.json" && pass "memory_write accepted" \
  || fail "memory_write: HTTP $code $(head -c 400 "$WORK/write.json")"

say "11/19 the engine restarts; the prompt hooks recall the nonce"
docker restart "$SCRATCH_NAME" >/dev/null && wait_ready "$URL" || die "the engine did not come back after a restart"
BODY="$(prompt_body agent:main:main "ocg-b-$NONCE" "" "" "$WS")"
code="$(probe "$BODY" "$WORK/recall.json")"
if out="$(jsq '
  const r=JSON.parse(require("fs").readFileSync(process.argv[2],"utf8")), n=process.argv[3], bad=[];
  const sys=(r.ordinary||{}).prependSystemContext||"", ctx=(r.authorized||{}).prependContext||"";
  if(!sys.includes("## lumberroom: what is already known")) bad.push("no digest");
  if(!ctx.includes("OCLARK-"+n)) bad.push("recall lacks the nonce");
  if(bad.length){console.log(bad.join(", ")+": "+JSON.stringify(r).slice(0,600));process.exit(1)}' "$WORK/recall.json" "$NONCE")"
then pass "digest in prependSystemContext, OCLARK-$NONCE in prependContext"; else fail "HTTP $code $out"; fi
probe "$BODY" "$WORK/recall2.json" >/dev/null
jsq 'const f=require("fs");const a=JSON.parse(f.readFileSync(process.argv[2])),b=JSON.parse(f.readFileSync(process.argv[3]));process.exit(a.ordinary&&b.ordinary&&a.ordinary.prependSystemContext===b.ordinary.prependSystemContext?0:1)' \
  "$WORK/recall.json" "$WORK/recall2.json" && pass "the digest bytes stay identical on the next turn" || fail "the digest changed within one session"

say "12/19 tool_calls: the write is the model's, recall is the hook's, each with its session"
ROWS="$(psql_q "$SCRATCH_DB" "SELECT tool || ':' || coalesce(unprompted::text, 'null') || ':' || coalesce(session_id, '') FROM tool_calls WHERE client = 'openclaw-plugin-test'")"
printf '%s\n' "$ROWS" | grep -q '^memory_write:true:' && pass "memory_write counted as the model's" \
  || fail "no unprompted memory_write in: $(printf '%s' "$ROWS" | tr '\n' ' ')"
for want in "memory_search:false:ocg-b-$NONCE" "context_bootstrap:false:ocg-b-$NONCE"; do
  printf '%s\n' "$ROWS" | grep -qx "$want" && pass "row $want" || fail "no row $want in: $(printf '%s' "$ROWS" | tr '\n' ' ')"
done

say "13/19 the owner gate in a group"
G="agent:main:telegram:group:-100$NONCE"
probe "$(prompt_body "$G" "ocg-s-$NONCE" telegram 9999 "$WS")" "$WORK/stranger.json" >/dev/null
jsq 'const r=JSON.parse(require("fs").readFileSync(process.argv[2],"utf8"));const o=r.ordinary||{},a=r.authorized||{};process.exit(o.prependSystemContext||a.prependContext?1:0)' "$WORK/stranger.json" \
  && pass "a stranger in the group gets no digest and no recall" || fail "the gate leaked: $(head -c 400 "$WORK/stranger.json")"
N="$(psql_q "$SCRATCH_DB" "SELECT count(*) FROM tool_calls WHERE session_id = 'ocg-s-$NONCE'")"
[ "$N" = 0 ] && pass "nothing reached the engine for the stranger" || fail "$N calls reached the engine for the stranger"
probe "$(prompt_body "$G" "ocg-o-$NONCE" telegram 4242 "$WS")" "$WORK/owner.json" >/dev/null
grep -q "OCLARK-$NONCE" "$WORK/owner.json" && pass "the listed owner gets recall in the group" || fail "owner recall: $(head -c 400 "$WORK/owner.json")"
code="$(invoke "{\"tool\":\"memory_search\",\"sessionKey\":\"$G\",\"args\":{\"query\":\"gate nickname\"}}" "$WORK/gtool.json")"
[ "$code" = 404 ] && pass "no lumberroom tool on a group turn with no author" || fail "group tool call: HTTP $code $(head -c 300 "$WORK/gtool.json")"

say "14/19 the guard refuses file-tool writes to the memory files"
mkdir -p "$WS/memory"
ln -s "$WS/memory" "$WS/notes-alias"
code="$(invoke "{\"tool\":\"write\",\"sessionKey\":\"agent:main:main\",\"args\":{\"path\":\"MEMORY.md\",\"content\":\"x\"}}" "$WORK/invoke-write.json")"
info "/tools/invoke write answers HTTP $code, so the guard runs through the probe's before_tool_call route"
guard_body() { printf '{"toolName":"%s","params":{"path":"%s","content":"GUARDLARK-%s"},"ctx":{"agentId":"main","sessionKey":"agent:main:main"}}' "$1" "$2" "$NONCE"; }
for p in MEMORY.md USER.md memory/2026-09-25.md notes-alias/2026-09-26.md ./memory/../USER.md; do
  code="$(tool_call "$(guard_body write "$p")" "$WORK/guard.json")"
  if [ "$code" = 200 ] && jsq 'const r=JSON.parse(require("fs").readFileSync(process.argv[2],"utf8")).result;process.exit(r&&r.block===true&&/read-only while lumberroom owns memory/.test(r.blockReason)&&/memory_write/.test(r.blockReason)?0:1)' "$WORK/guard.json"
  then pass "write $p blocked with the memory_write reason"
  else fail "write $p: HTTP $code $(head -c 300 "$WORK/guard.json")"; fi
done
code="$(tool_call "$(guard_body edit memory.md)" "$WORK/guard-edit.json")"
[ "$code" = 200 ] && grep -q '"block":true' "$WORK/guard-edit.json" && pass "edit memory.md (lower case) blocked" \
  || fail "edit memory.md: HTTP $code $(head -c 300 "$WORK/guard-edit.json")"
code="$(tool_call "$(guard_body write notes.md)" "$WORK/control.json")"
[ "$code" = 200 ] && ! grep -q '"block":true' "$WORK/control.json" && pass "write notes.md not blocked" \
  || fail "control write: HTTP $code $(head -c 300 "$WORK/control.json")"

say "15/19 import fills the proposal queue, never the store, and a rerun adds nothing"
printf '# Notes\n\n- IMPORTLARK-%s one\n- IMPORTLARK-%s two\n' "$NONCE" "$NONCE" >"$WS/MEMORY.md"
printf 'The owner is IMPORTLARK-%s three.\n' "$NONCE" >"$WS/USER.md"
printf 'IMPORTLARK-%s four happened on the 24th.\n' "$NONCE" >"$WS/memory/2026-09-24.md"
oc "$ST" lumberroom import --workspace "$WS" >"$WORK/import.out" 2>&1 || fail "import: $(tail -5 "$WORK/import.out")"
oc "$ST" lumberroom import --workspace "$WS" >>"$WORK/import.out" 2>&1 || fail "the second import failed: $(tail -5 "$WORK/import.out")"
P="$(psql_q "$SCRATCH_DB" "SELECT count(*) FROM ingest_proposal WHERE content LIKE '%IMPORTLARK-$NONCE%' AND speaker = 'main_model'")"
M="$(psql_q "$SCRATCH_DB" "SELECT count(*) FROM memory WHERE content LIKE '%IMPORTLARK-$NONCE%'")"
[ "$P" = 4 ] && pass "four proposals, speaker main_model" || fail "expected 4 proposals, found $P"
[ "$M" = 0 ] && pass "no live memory holds an imported entry" || fail "$M imported entries reached the live store"

say "16/19 memory-core stays out while one sidecar switch holds, and an open switch is reported"
# Spec 8.5: slot ownership alone does not keep memory-core out. dreaming.enabled false on our entry
# and enabled false on memory-core's each refuse the dreaming sidecar (spec O33).
stop_gateway
core_loaded() { jsq 'const r=JSON.parse(require("fs").readFileSync(process.argv[2],"utf8"));process.exit(r.plugin.status==="loaded"?0:1)' "$1"; }
oc "$ST" config set plugins.entries.lumberroom.config.dreaming.enabled true --strict-json >"$WORK/flip.out" 2>&1 \
  || die "reopen dreaming: $(tail -3 "$WORK/flip.out")"
oc "$ST" plugins inspect memory-core --json >"$WORK/core-flip.json" 2>/dev/null || true
if core_loaded "$WORK/core-flip.json"; then fail "memory-core loaded with dreaming on and its own entry disabled"
else pass "dreaming on, memory-core disabled: memory-core stays out"; fi
if oc "$ST" lumberroom status >"$WORK/status-flip.out" 2>&1; then fail "status exited 0 with dreaming on"
elif grep -qF 'plugins.entries.lumberroom.config.dreaming.enabled' "$WORK/status-flip.out"; then pass "status exits 1 and names the dreaming switch"
else fail "status did not name the dreaming switch: $(tail -3 "$WORK/status-flip.out")"; fi
: >"$ST/openclaw.log"
start_gateway "$ST" "$WORK/gateway-flip.log" || die "the gateway did not start with dreaming on: $(tail -20 "$WORK/gateway-flip.log")"
gw_log_has "$ST" "$WORK/gateway-flip.log" 'can load beside lumberroom' && pass "the gateway log names the open switch" \
  || fail "no sidecar error in the gateway log"
code="$(invoke "{\"tool\":\"memory_search\",\"sessionKey\":\"agent:main:main\",\"args\":{\"query\":\"gate nickname\"}}" "$WORK/flip-search.json")"
[ "$code" = 200 ] && grep -q "OCLARK-$NONCE" "$WORK/flip-search.json" && pass "memory_search still answers from lumberroom" \
  || fail "memory_search with dreaming on: HTTP $code $(head -c 300 "$WORK/flip-search.json")"
stop_gateway
oc "$ST" config set plugins.entries.memory-core.enabled true --strict-json >>"$WORK/flip.out" 2>&1 \
  || die "reopen memory-core: $(tail -3 "$WORK/flip.out")"
if oc "$ST" lumberroom status >"$WORK/status-open.out" 2>&1; then fail "status exited 0 with both switches open"
elif grep -qF 'plugins.entries.memory-core.enabled' "$WORK/status-open.out"; then pass "status exits 1 and names the memory-core switch"
else fail "status did not name the memory-core switch: $(tail -3 "$WORK/status-open.out")"; fi
# Both switches open is the hazard spec 8.5 describes. The gate records who owns memory_search then
# and asserts only that the owner was told.
oc "$ST" plugins inspect memory-core --json >"$WORK/core-open.json" 2>/dev/null || true
if core_loaded "$WORK/core-open.json"; then info "both switches open: memory-core loads as a sidecar, as spec O32 predicts"
else info "both switches open: memory-core did not load; spec O32 predicted it would"; fi
: >"$ST/openclaw.log"
start_gateway "$ST" "$WORK/gateway-open.log" || die "the gateway did not start with both switches open: $(tail -20 "$WORK/gateway-open.log")"
gw_log_has "$ST" "$WORK/gateway-open.log" 'can load beside lumberroom' && pass "the gateway log reports both switches open" \
  || fail "no sidecar error in the gateway log with both switches open"
code="$(invoke "{\"tool\":\"memory_search\",\"sessionKey\":\"agent:main:main\",\"args\":{\"query\":\"gate nickname\"}}" "$WORK/open-search.json")"
if grep -q "OCLARK-$NONCE" "$WORK/open-search.json"; then info "both switches open: memory_search answered from lumberroom"
else info "both switches open: memory_search did not answer from lumberroom (HTTP $code)"; fi
if cat "$WORK/gateway-open.log" "$ST/openclaw.log" 2>/dev/null | grep -q 'plugin tool name conflict'; then info "the gateway logged a tool name conflict"; fi
stop_gateway
scratch_stop
TOKEN_SCRATCH_NAME=""

say "17/19 scratch engine in AUTH_MODE=oauth with 75-second access tokens"
PASSWORD="$(openssl rand -hex 20)"
SCRATCH_DB=lumberroom_openclaw_plugin_oauth_test
SCRATCH_NAME="${LUMBERROOM_OPENCLAW_PLUGIN_OAUTH_SERVER:-lumberroom-openclaw-plugin-oauth-server}"
SCRATCH_PORT=$OAUTH_PORT
SCRATCH_TOKENS='[]'
export SCRATCH_DB SCRATCH_NAME SCRATCH_PORT SCRATCH_TOKENS
# From lumberroom-hermes scripts/hermes-plugin-test.sh scratch_start_oauth, which comes from the
# engine's scripts/oauth-flow-test.sh. The 75-second access token lets step 19 reach expiry in minutes.
scratch_start_oauth() {
  SCRATCH_REPO_DIR="${SCRATCH_REPO_DIR:-$ENGINE_SRC}"
  SCRATCH_NETWORK="${LUMBERROOM_DOCKER_NETWORK:-lumberroom_default}"
  SCRATCH_PG_USER="${POSTGRES_USER:-lumberroom}"
  scratch_require || return 1
  scratch_compose up -d db >/dev/null
  scratch_compose exec -T -e PGOPTIONS="-c client_min_messages=warning" db \
    psql -U "$SCRATCH_PG_USER" -d postgres -c "DROP DATABASE IF EXISTS $SCRATCH_DB" >/dev/null
  scratch_compose exec -T db psql -U "$SCRATCH_PG_USER" -d postgres -c "CREATE DATABASE $SCRATCH_DB" >/dev/null
  local hash
  hash="$(printf '%s\n' "$PASSWORD" | docker run --rm -i lumberroom-server:0.4.0 lumberroom-server hash-password)" || return 1
  docker rm -f "$SCRATCH_NAME" >/dev/null 2>&1 || true
  docker run -d --name "$SCRATCH_NAME" --network "$SCRATCH_NETWORK" \
    -p "127.0.0.1:${SCRATCH_PORT}:${SCRATCH_PORT}" \
    -e PORT="$SCRATCH_PORT" -e HOST=0.0.0.0 -e TENANT_ID=scratch \
    -e DATABASE_URL="postgres://${SCRATCH_PG_USER}:${POSTGRES_PASSWORD}@db:5432/${SCRATCH_DB}" \
    -e PUBLIC_URL="http://127.0.0.1:${SCRATCH_PORT}" \
    -e AUTH_MODE=oauth -e OWNER_PASSWORD_HASH="$hash" -e OAUTH_COOKIE_SECRET="$(openssl rand -hex 32)" \
    -e OAUTH_ACCESS_TTL_SECS=75 \
    -e EMBED_PROVIDER=hash -e EMBED_DIM=768 -e KEK_PROVIDER=none \
    lumberroom-server:0.4.0 >/dev/null
  SCRATCH_URL="http://127.0.0.1:${SCRATCH_PORT}"
  wait_ready "$SCRATCH_URL"
}
scratch_start_oauth || die "the OAuth scratch engine did not start"
URL="$SCRATCH_URL"
STO="$WORK/st-oauth"; WSO="$WORK/ws-oauth"; mkdir -p "$WSO"; seed_state "$STO"
oc "$STO" plugins install "npm-pack:$TGZ" --force --accept-capabilities </dev/null >"$WORK/install-o.out" 2>&1 || die "plugin install (oauth): $(tail -5 "$WORK/install-o.out")"
oc "$STO" plugins install "npm-pack:$PROBE_TGZ" --force --accept-capabilities </dev/null >>"$WORK/install-o.out" 2>&1 || die "probe install (oauth)"
configure "$STO" "$WSO" "$URL" oauth >"$WORK/config-o.out" 2>&1 || die "config (oauth): $(tail -5 "$WORK/config-o.out")"
pass "engine ready at $URL; OpenClaw configured for OAuth"

say "18/19 sign-in through the CLI's paste path; write and recall over OAuth"
mkfifo "$WORK/paste"
oc "$STO" lumberroom login --no-browser <"$WORK/paste" >"$WORK/login.out" 2>&1 &
LOGIN_PID=$!
exec 7>"$WORK/paste"
AUTH_URL=""
for _ in $(seq 1 60); do
  AUTH_URL="$(grep -o "http://127.0.0.1:${OAUTH_PORT}/oauth/authorize?[^[:space:]]*" "$WORK/login.out" | head -1 || true)"
  [ -n "$AUTH_URL" ] && break
  sleep 1
done
[ -n "$AUTH_URL" ] || die "login printed no authorize URL: $(cat "$WORK/login.out")"
param() { node -e 'console.log(new URL(process.argv[1]).searchParams.get(process.argv[2]) ?? "")' "$AUTH_URL" "$1"; }
FORM=()
for k in client_id redirect_uri code_challenge code_challenge_method response_type state resource scope; do
  v="$(param "$k")"; [ -n "$v" ] && FORM+=(--data-urlencode "$k=$v")
done
curl -sS -o "$WORK/login.html" -D "$WORK/login.h" -X POST "$URL/oauth/login" "${FORM[@]}" --data-urlencode "password=$PASSWORD"
COOKIE="$(sed -n 's/^[Ss]et-[Cc]ookie: \(lumberroom_owner=[^;]*\).*/\1/p' "$WORK/login.h" | head -1)"
CSRF="$(grep -o 'name="csrf" value="[^"]*"' "$WORK/login.html" | sed 's/.*value="//; s/"$//' || true)"
if [ -z "$CSRF" ]; then
  curl -sS -o "$WORK/consent.html" -H "Cookie: $COOKIE" "$AUTH_URL"
  CSRF="$(grep -o 'name="csrf" value="[^"]*"' "$WORK/consent.html" | sed 's/.*value="//; s/"$//' || true)"
fi
[ -n "$CSRF" ] || die "no consent screen after the owner login"
curl -sS -o /dev/null -D "$WORK/consent.h" -X POST "$URL/oauth/consent" -H "Cookie: $COOKIE" \
  "${FORM[@]}" --data-urlencode "csrf=$CSRF" --data-urlencode "profile=full" --data-urlencode "action=allow"
LOCATION="$(sed -n 's/^[Ll]ocation: \(.*\)\r$/\1/p' "$WORK/consent.h" | head -1)"
[ -n "$LOCATION" ] || die "consent returned no redirect"
printf '%s\n' "$LOCATION" >&7
exec 7>&-
if wait "$LOGIN_PID"; then pass "openclaw lumberroom login stored a token pair"; else fail "login: $(tail -5 "$WORK/login.out")"; fi
LOGIN_PID=""
[ "$(node -e 'console.log((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))' "$STO/lumberroom/oauth.json")" = 600 ] \
  && pass "oauth.json is 0600" || fail "oauth.json mode is not 0600"
oc "$STO" lumberroom status >"$WORK/ostatus.out" 2>&1 && grep -q memory_write "$WORK/ostatus.out" \
  && pass "status over OAuth lists memory_write" || fail "status over OAuth: $(tail -5 "$WORK/ostatus.out")"
start_gateway "$STO" "$WORK/gateway-oauth.log" || die "the gateway did not start (oauth): $(tail -20 "$WORK/gateway-oauth.log")"
code="$(invoke "{\"tool\":\"memory_write\",\"sessionKey\":\"agent:main:main\",\"args\":{\"content\":\"The OpenClaw gate nickname is OCLARK-$NONCE.\",\"namespace\":\"user:me\"}}" "$WORK/owrite.json")"
[ "$code" = 200 ] && grep -q '"id' "$WORK/owrite.json" && pass "OAuth write accepted" || fail "OAuth write: HTTP $code $(head -c 400 "$WORK/owrite.json")"
probe "$(prompt_body agent:main:main "ocg-ob-$NONCE" "" "" "$WSO")" "$WORK/orecall.json" >/dev/null
grep -q "OCLARK-$NONCE" "$WORK/orecall.json" && pass "OAuth recall carries the nonce" || fail "OAuth recall: $(head -c 600 "$WORK/orecall.json")"

say "19/19 the gateway and a CLI process past the access token's expiry refresh once, and nobody is logged out"
# The step waits until the stored access token has expired, so both processes need a refresh, then
# proves one happened: without that check a run in which nothing refreshes passes the no-replay
# assertion for free.
TOKEN_FILE="$STO/lumberroom/oauth.json"
field() { node -e 'const d=JSON.parse(require("fs").readFileSync(process.argv[1],"utf8"));console.log(process.argv[2]==="expiresAt"?(d.expiresAt||0):d.tokens[process.argv[2]])' "$TOKEN_FILE" "$1"; }
ACCESS_BEFORE="$(field access_token)"
WAIT_S="$(node -e 'console.log(Math.max(0, Math.ceil((Number(process.argv[1]) - Date.now()) / 1000)) + 3)' "$(field expiresAt)")"
say "   waiting ${WAIT_S}s for the access token to expire"
sleep "$WAIT_S"
# Each subshell inherits set -e, so a failing command would exit before writing its rc file.
( rc=0; code="$(probe "$(prompt_body agent:main:main "ocg-r1-$NONCE" "" "" "$WSO")" "$WORK/r1.json")" || rc=$?; \
  [ "$rc" = 0 ] && [ "$code" = 200 ] && grep -q "OCLARK-$NONCE" "$WORK/r1.json" || rc=1; echo "$rc" >"$WORK/r1.rc" ) &
R1_PID=$!
( rc=0; oc "$STO" lumberroom status >"$WORK/r2.out" 2>&1 || rc=$?; echo "$rc" >"$WORK/r2.rc" ) &
R2_PID=$!
# A bare wait would also wait on the gateway, which never exits on its own.
wait "$R1_PID" "$R2_PID" || true
[ "$(cat "$WORK/r1.rc")" = 0 ] && [ "$(cat "$WORK/r2.rc")" = 0 ] \
  && pass "the gateway recalled and the CLI reached the engine after the refresh" \
  || fail "a process failed across the refresh: $(head -c 400 "$WORK/r1.json") $(tail -3 "$WORK/r2.out")"
[ "$(field access_token)" != "$ACCESS_BEFORE" ] && pass "a refresh stored a new access token" \
  || fail "no refresh happened: the stored access token did not change"
REPLAYS="$(docker logs "$SCRATCH_NAME" 2>&1 | grep -c 'refresh token replayed' || true)"
[ "$REPLAYS" = 0 ] && pass "no refresh token was replayed" || fail "the engine saw $REPLAYS refresh replays and revoked the family"
stop_gateway
if cat /tmp/openclaw/*.log 2>/dev/null | grep -qF "$WORK"; then fail "an OpenClaw command from this run logged to /tmp/openclaw"
else pass "nothing from this run logged to /tmp/openclaw"; fi

printf '\n'
if [ "$FAILED" -eq 0 ]; then printf 'openclaw-plugin-test PASSED\n'; else printf 'openclaw-plugin-test FAILED\n'; exit 1; fi
