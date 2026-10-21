#!/bin/sh
# run-all.sh — the ONE command for the Claude leg of the Pult Ф0 spike.
#
#   cd tools/pult/spike/claude && ./run-all.sh
#
# Prerequisite (you, in your own terminal, once):  claude  ->  /login
# This script never logs in, never reads a credential file, and never touches an API key.
#
# Options:
#   --minutes 2,5,9      idle intervals for S1 (default). Overnight: --only s1 --minutes 20,40,60
#   --skip-s1            skip the warm-TTL check entirely (saves ~16 min and 6 turns)
#   --only b1,s5         run only these checks (b1 b2 b3 b4 b5 b6 s1 s3 s5 s7); results.json of
#                        the others is left exactly as it was — the row is merged, not reseeded
#   --offline-only       run only the checks that need no login
#
# Network: the profile is PICKED, not assumed. lib.mjs TCP-probes 127.0.0.1:10808; open -> proxy,
# closed -> direct with NO proxy variables. PULT_PROXY=off|required|auto overrides it. Before any
# model turn this script checks that api.anthropic.com actually answers ON THAT PROFILE and aborts
# if it does not — run 1 burned three minutes per check against a proxy that was down.
#
# Egress: reachability is not enough — the run also refuses to start when the traffic leaves from
# a country on the guard list (exit 5). If you are in an unsupported region, run with
# PULT_PROXY=required so a dead proxy fails CLOSED instead of quietly falling back to direct:
#   PULT_PROXY=required ./run-all.sh
# Emergency bypass of the egress check only: PULT_EGRESS=skip (logged loudly, nothing else).
#
# Exit codes: 1 not logged in · 2 bad argument · 3 proxy required but down · 4 API unreachable ·
#             5 egress blocked · 6 account/region refusal ("disabled Claude subscription access")
#
# Everything lands in ./logs/*.jsonl and ./results.json.

set -u

HERE=$(cd "$(dirname "$0")" && pwd)
LOGS="$HERE/logs"
NODE=${PULT_NODE:-$(command -v node || echo /opt/homebrew/bin/node)}
CLAUDE=${PULT_CLAUDE_BIN:-$(command -v claude || echo /opt/homebrew/bin/claude)}

S1_MINUTES="2,5,9"
SKIP_S1=0
OFFLINE_ONLY=0
ONLY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --minutes) S1_MINUTES="$2"; shift 2 ;;
    --skip-s1) SKIP_S1=1; shift ;;
    --only) ONLY="$2"; shift 2 ;;
    --offline-only) OFFLINE_ONLY=1; shift ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

# wanted <id> -> 0 when the check must run
wanted() {
  [ -z "$ONLY" ] && return 0
  for w in $(printf '%s' "$ONLY" | tr ',' ' '); do
    [ "$w" = "$1" ] && return 0
  done
  return 1
}

if [ -n "$ONLY" ]; then
  for w in $(printf '%s' "$ONLY" | tr ',' ' '); do
    case "$w" in
      b1|b2|b3|b4|b5|b6|s1|s3|s5|s7) ;;
      *) echo "unknown check id in --only: $w (valid: b1,b2,b3,b4,b5,b6,s1,s3,s5,s7)" >&2; exit 2 ;;
    esac
  done
fi

mkdir -p "$LOGS"

echo "== Pult Ф0 · Claude leg =="
echo "node:   $NODE ($("$NODE" --version 2>/dev/null))"
echo "claude: $CLAUDE ($("$CLAUDE" --version 2>/dev/null))"
[ -n "$ONLY" ] && echo "only:   $ONLY"
echo

# --- make sure every check of this leg has a row, even if it never runs -------
# Skipped under --only: seeding must never touch the rows of checks we are not running.
if [ -z "$ONLY" ]; then
  "$NODE" "$HERE/seed-results.mjs"
  echo
fi

# --- offline checks: these run regardless of login ---------------------------
if [ -z "$ONLY" ]; then
  echo "-- offline: flag acceptance, MCP stub, socket handshake, not-logged-in shape"
  "$NODE" "$HERE/offline/probe-flags.mjs"      > "$LOGS/offline-probe-flags.out"      2>&1; echo "   probe-flags      exit=$?"
  PULT_LOG_DIR="$LOGS" "$NODE" "$HERE/offline/test-mcp-stub.mjs"    > "$LOGS/offline-test-mcp-stub.out"    2>&1; echo "   test-mcp-stub    exit=$?"
  "$NODE" "$HERE/offline/probe-notloggedin.mjs" > "$LOGS/offline-probe-notloggedin.out" 2>&1; echo "   probe-notlogged  exit=$?"
  echo
fi

[ "$OFFLINE_ONLY" -eq 1 ] && { echo "--offline-only: stopping here."; exit 0; }

# --- login gate ---------------------------------------------------------------
# Scrubbed env: this process may have been started from the Claude desktop app, whose
# ANTHROPIC_* / CLAUDE_CODE_* variables would otherwise reconfigure the child.
AUTH=$(env -i HOME="$HOME" USER="$USER" PATH="$PATH" LANG="${LANG:-en_US.UTF-8}" TERM=dumb \
       "$CLAUDE" auth status --json 2>&1)
LOGGED_IN=$(printf '%s' "$AUTH" | "$NODE" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(String(JSON.parse(s).loggedIn))}catch(e){process.stdout.write("parse-error")}})')

if [ "$LOGGED_IN" != "true" ]; then
  cat <<EOF

ABORT: the terminal \`claude\` CLI is not logged in.

  claude auth status --json  ->  loggedIn: $LOGGED_IN

Fix it yourself, in your own terminal (this script will never do it for you):

  1. run:  claude
  2. type: /login
  3. finish the browser flow
  4. re-run: $0

The offline checks above already ran and their results are in $HERE/results.json.
Every check that needs a model turn is recorded there as 'blocked'.
EOF
  exit 1
fi

# --- network preflight ---------------------------------------------------------
# Ask lib.mjs which profile it picked, then prove api.anthropic.com answers ON THAT PROFILE.
# ANY http status counts as reachable (404 from the bare root is normal); 000 means no answer.
PROFILE=$("$NODE" -e "import('file://$HERE/lib.mjs').then(m=>process.stdout.write(m.NETWORK.mode+' '+(m.NETWORK_ENV.HTTPS_PROXY||'-')+' '+m.NETWORK.port_open))" 2>/dev/null)
PF_RC=$?
if [ $PF_RC -ne 0 ] || [ -z "$PROFILE" ]; then
  echo "ABORT: не удалось выбрать сетевой профиль (lib.mjs вышел с кодом $PF_RC)." >&2
  echo "Скорее всего PULT_PROXY=required, а прокси не отвечает. Ничего не потрачено." >&2
  exit 3
fi
NET_MODE=$(printf '%s' "$PROFILE" | cut -d' ' -f1)
NET_PROXY=$(printf '%s' "$PROFILE" | cut -d' ' -f2)
NET_PORT_OPEN=$(printf '%s' "$PROFILE" | cut -d' ' -f3)

if [ "$NET_MODE" = "proxy" ]; then
  API_CODE=$(curl -m 8 -s -o /dev/null -w '%{http_code}' -x "$NET_PROXY" https://api.anthropic.com/ 2>/dev/null)
else
  API_CODE=$(curl -m 8 -s -o /dev/null -w '%{http_code}' https://api.anthropic.com/ 2>/dev/null)
fi

echo "-- сеть: профиль $NET_MODE (порт 10808 открыт: $NET_PORT_OPEN, HTTPS_PROXY=$NET_PROXY), api.anthropic.com -> HTTP $API_CODE"

# --- egress guard ---------------------------------------------------------------
# Reachability is not enough: we also need to know WHICH COUNTRY the traffic leaves from,
# measured on the same profile the child will use. cdn-cgi/trace answers that in one line.
EGRESS=$("$NODE" -e "import('file://$HERE/lib.mjs').then(async m=>{const e=await m.egressCheck();process.stdout.write((e.loc||'unknown')+' '+e.ms+' '+e.blocked+' '+e.skipped+' '+m.BLOCKED_COUNTRIES.join(','))})" 2>/dev/null)
EG_LOC=$(printf '%s' "$EGRESS" | cut -d' ' -f1)
EG_MS=$(printf '%s' "$EGRESS" | cut -d' ' -f2)
EG_BLOCKED=$(printf '%s' "$EGRESS" | cut -d' ' -f3)
EG_SKIPPED=$(printf '%s' "$EGRESS" | cut -d' ' -f4)
EG_LIST=$(printf '%s' "$EGRESS" | cut -d' ' -f5)

if [ "$EG_SKIPPED" = "true" ]; then
  echo "-- выход: !!! ПРОВЕРКА ОТКЛЮЧЕНА (PULT_EGRESS=skip) — маршрут ходов не проверен !!!"
elif [ -z "$EGRESS" ]; then
  echo "-- выход: не удалось измерить (lib.mjs не ответил)"
  EG_BLOCKED=true; EG_LOC=unknown
else
  echo "-- выход: loc=$EG_LOC (${EG_MS} ms, профиль $NET_MODE), список-страж: $EG_LIST"
fi

if [ "$EG_BLOCKED" = "true" ]; then
  cat <<EOF

ABORT: выход в сеть: $EG_LOC — ходы не запускались.

  профиль:      $NET_MODE
  список-страж: $EG_LIST  (консервативный список харнесса, НЕ официальный список Anthropic)

Anthropic не обслуживает этот регион: ход из него вернёт 403
"Your organization has disabled Claude subscription access for Claude Code".
Подними VPN (ожидаемый выход — Финляндия) и запусти снова.

Аварийный обход (ходы пойдут по непроверенному маршруту): PULT_EGRESS=skip ./run-all.sh
EOF
  exit 5
fi

if [ -z "$API_CODE" ] || [ "$API_CODE" = "000" ]; then
  cat <<EOF

ABORT: api.anthropic.com недоступен по выбранному профилю.

  профиль:      $NET_MODE
  HTTPS_PROXY:  $NET_PROXY
  порт 10808:   открыт=$NET_PORT_OPEN
  curl:         HTTP $API_CODE (нет ответа)

Что делать:
  * профиль proxy — подними прокси на 127.0.0.1:10808 или запусти с PULT_PROXY=off;
  * профиль direct — проверь VPN/интернет.

Ни один ход не сделан, квота не потрачена. Именно так прогон 1 сжёг по ~3 минуты на проверку:
прокси лежал, а профиль был прошит в lib.mjs намертво.
EOF
  exit 4
fi

echo
echo "-- logged in; running the model checks (tiny haiku turns)"
echo

# Exit codes that must stop the WHOLE run, not just the current check:
#   5 — egress guard (traffic leaves from a blocked country)
#   6 — the account/region refusal "disabled Claude subscription access"
# Retrying either one in a loop just bangs on the same wall.
run() {
  name=$1; shift
  printf '   %-22s ' "$name"
  "$NODE" "$HERE/$name" "$@" > "$LOGS/${name%.mjs}.out" 2>&1
  rc=$?
  echo "exit=$rc"
  if [ $rc -eq 6 ]; then
    cat <<EOF

=== СТОП: доступ аккаунта к Claude Code отклонён ===
  "Your organization has disabled Claude subscription access for Claude Code"
  Подробности: $LOGS/${name%.mjs}.out

Это не поломка проверки и не повод повторять прогон в цикле.
  1. проверь VPN (ожидаемый выход — Финляндия);
  2. убедись, что порт 127.0.0.1:10808 открыт (иначе профиль уйдёт в direct);
  3. сделай ОДИН ручной ход: claude -p "ok"
и только после этого запускай ./run-all.sh снова.
EOF
    exit 6
  fi
  if [ $rc -eq 5 ]; then
    echo
    echo "=== СТОП: выход в сеть заблокирован (см. $LOGS/${name%.mjs}.out). Ходы не запускались."
    exit 5
  fi
}

wanted b1 && run b1-stream.mjs
wanted b2 && run b2-s6-permission.mjs
wanted b3 && run b3-resume.mjs
wanted b4 && run b4-subagent.mjs
wanted b5 && run b5-schema.mjs
wanted b6 && run b6-limits.mjs
wanted s3 && run s3-workflow.mjs
wanted s5 && run s5-deadport.mjs
wanted s7 && run s7-startup-cost.mjs
if wanted s1 && [ "$SKIP_S1" -eq 0 ]; then run s1-warm-ttl.mjs --minutes "$S1_MINUTES"; fi

echo
echo "== done =="
echo "logs:    $LOGS/*.jsonl"
echo "results: $HERE/results.json"
"$NODE" -e '
const fs=require("fs");const p=process.argv[1];
try{const d=JSON.parse(fs.readFileSync(p,"utf8"));
for(const c of d.checks||[])console.log((c.verdict||"?").padEnd(22),c.id);}catch(e){console.log("(no results.json yet)")}
' "$HERE/results.json"
