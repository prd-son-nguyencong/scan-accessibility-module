#!/usr/bin/env bash
# Blind scan of one site worktree with assertions that the scan stayed inside the worktree.
# usage: HOST_REPO=<host repo> eval/blind-scan.sh <site> <worktree> <port> <sitemap.xml> <out-dir>
# exit: 0 all assertions passed | 3 project root / scan crash assertion failed | 4 host-repo isolation assertion failed
#       ada-scan exit 1 (violations) or 2 (incomplete) is printed as NOTE, not a failure.
set -u
[ $# -eq 5 ] || { echo "usage: $0 <site> <worktree> <port> <sitemap.xml> <out-dir>" >&2; exit 64; }
SITE=$1; WT=$(cd "$2" && pwd) || exit 64; PORT=$3; SITEMAP=$4; OUT=$5
# HOST_REPO: the repository that must stay untouched (the one your site worktree was cut from). Set it explicitly.
HOST=${HOST_REPO:?set HOST_REPO to the host repository that must not change}
ADA=$(cd "$(dirname "$0")/.." && pwd)/bin/ada-scan.js
mkdir -p "$OUT"; OUT=$(cd "$OUT" && pwd)
[ -f "$SITEMAP" ] || { echo "sitemap not found: $SITEMAP" >&2; exit 64; }

hoststate() { { git -C "$HOST" status --porcelain; git -C "$HOST" diff | shasum; } 2>&1 | shasum; }
BEFORE=$(hoststate)

# any port in the sitemap (127.0.0.1 or localhost) becomes the port this run serves
sed -E "s#(https?://(127\.0\.0\.1|localhost)):[0-9]+#http://127.0.0.1:$PORT#g" "$SITEMAP" > "$OUT/sitemap.local.xml"

SRV=
cleanup() { [ -n "$SRV" ] && kill "$SRV" 2>/dev/null; }
trap cleanup EXIT
cd "$WT" || exit 64
node node_modules/vite/bin/vite.js dev --port "$PORT" --host 127.0.0.1 --strictPort > "$OUT/vite.log" 2>&1 &
SRV=$!
for _ in $(seq 1 60); do curl -sf "http://127.0.0.1:$PORT/" >/dev/null && break; sleep 1; done
curl -sf "http://127.0.0.1:$PORT/" >/dev/null || { echo "FAIL: dev server did not start (see $OUT/vite.log)"; exit 3; }

echo "site=$SITE project root=$WT" > "$OUT/scan.log"
ADA_SCAN_ROOT="$WT" nice -n 10 node "$ADA" --url "http://127.0.0.1:$PORT" --sitemap "$OUT/sitemap.local.xml" --out-dir "$OUT" >> "$OUT/scan.log" 2>&1
RC=$?
cleanup; SRV=

FAIL=0
case $RC in
  0) ;;
  1|2) echo "NOTE: ada-scan exit $RC ($([ $RC = 1 ] && echo 'violations found' || echo 'incomplete scan')); assertions still run" ;;
  *) echo "FAIL: ada-scan crashed with exit $RC (see $OUT/scan.log)"; exit 3 ;;
esac

# A1: the run (log past our own header line, or the report) names the worktree as project root
if { tail -n +2 "$OUT/scan.log"; cat "$OUT"/*.json 2>/dev/null; } | grep -qF "$WT"; then echo "PASS A1: output names $WT"
else echo "FAIL A1: neither the scan log nor the report names the worktree $WT as project root"; FAIL=3; fi

# A2: nothing in the output points into the host repo src
if grep -rqF "$HOST/src" "$OUT" --include='*.json' --include='*.log' --include='*.md' --include='*.html'; then
  echo "FAIL A2: output points into $HOST/src:"; grep -rlF "$HOST/src" "$OUT" | head -5; FAIL=4
else echo "PASS A2: no pointer into $HOST/src"; fi

# A3: host repo git state unchanged
if [ "$(hoststate)" = "$BEFORE" ]; then echo "PASS A3: host git status unchanged"
else echo "FAIL A3: $HOST git status changed during the run"; FAIL=4; fi

exit $FAIL
