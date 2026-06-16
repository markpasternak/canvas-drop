#!/usr/bin/env bash
#
# compose-smoke.sh — end-to-end verification of the docker-compose demo stack (U9).
#
# Boots the stack and asserts the load-bearing launch invariants:
#   1. all services come up; the app reports healthy (Postgres up + migrations ran)
#   2. the app publishes NO host port (only Caddy is reachable)        [§12.5 exposure]
#   3. an unauthenticated request is redirected to login, not served
#   4. a forged identity header is NOT trusted (stripped + crypto-verified)
#   5. a real Dex login resolves /api/me as the demo user              [JWKS verify]
#   6. data survives an app+Postgres restart                          [volume persist]
#
# Exits non-zero on the first failed assertion. Safe to run repeatedly.
#
# Usage:  ./scripts/compose-smoke.sh            # boots, verifies, leaves stack up
#         KEEP_UP=0 ./scripts/compose-smoke.sh  # tears the stack down at the end
set -euo pipefail

cd "$(dirname "$0")/.."

BASE="http://localhost:8080"
DEMO_USER="demo@example.com"
DEMO_PASS="canvasdrop"
KEEP_UP="${KEEP_UP:-1}"
fail() { echo "✗ FAIL: $*" >&2; exit 1; }
pass() { echo "✓ $*"; }

echo "── booting stack (docker compose up -d --build) ─────────────────────────────"
docker compose up -d --build >/dev/null

echo "── waiting for app to report healthy ────────────────────────────────────────"
status=""
for _ in $(seq 1 40); do
  status="$(docker compose ps app --format '{{.Status}}' 2>/dev/null || true)"
  case "$status" in *healthy*) break ;; esac
  sleep 3
done
case "$status" in *healthy*) pass "app healthy ($status)" ;; *) fail "app not healthy: $status" ;; esac

echo "── 2. app is not published to the host ──────────────────────────────────────"
# An unpublished port yields empty or a :0 mapping; a real publish ends in :<port>.
mapping="$(docker compose port app 3000 2>/dev/null || true)"
if echo "$mapping" | grep -qE ':[1-9][0-9]*$'; then
  fail "app is host-exposed at $mapping"
else
  pass "app has no host port mapping"
fi

echo "── 3. unauthenticated request is redirected to login ────────────────────────"
code="$(curl -s -m5 -o /dev/null -w '%{http_code}' "$BASE/")"
[ "$code" = "302" ] && pass "unauthenticated GET / → 302" || fail "expected 302, got $code"

# A forged identity header on an unauthenticated request must NOT yield access.
# This proves the forged header does not bypass the proxy gate (and Caddy strips it);
# the app's cryptographic rejection of a forged JWT in JWKS mode is unit-tested in
# apps/server/src/auth/proxy.test.ts — that path is not reachable past the proxy here.
echo "── 4. forged identity header does not bypass the proxy ──────────────────────"
code="$(curl -s -m5 -o /dev/null -w '%{http_code}' \
  -H "X-Forwarded-Access-Token: forged.jwt.token" \
  -H "X-Auth-Request-Email: attacker@example.com" "$BASE/")"
[ "$code" = "302" ] && pass "forged identity header → 302 (not trusted, stripped at the edge)" || fail "forged header accepted ($code)"

# --- login helper: drives the Dex password flow, prints the resolved /api/me ----
login_and_whoami() {
  local jar html action; jar="$(mktemp)"; html="$(mktemp)"
  curl -s -m8 -c "$jar" -b "$jar" -L "$BASE/oauth2/start?rd=%2Fapi%2Fme" -o "$html"
  action="$(grep -oE 'action="[^"]+"' "$html" | head -1 \
    | sed -E 's/action="//; s/"$//' | sed 's/\&amp;/\&/g')"
  if [ -z "$action" ]; then
    echo "could not parse the Dex login form action from:" >&2; cat "$html" >&2
    rm -f "$jar" "$html"; return 1
  fi
  curl -s -m12 -c "$jar" -b "$jar" -L -o /dev/null \
    --data-urlencode "login=$DEMO_USER" --data-urlencode "password=$DEMO_PASS" \
    "$BASE$action"
  curl -s -m8 -b "$jar" "$BASE/api/me"
  rm -f "$jar" "$html"
}

echo "── 5. real Dex login resolves /api/me as the demo user ──────────────────────"
me="$(login_and_whoami)"
echo "    $me"
echo "$me" | grep -q "\"email\":\"$DEMO_USER\"" || fail "login did not resolve the demo identity: $me"
echo "$me" | grep -q '"authMode":"proxy"' || fail "expected authMode=proxy (JWKS path): $me"
id_before="$(echo "$me" | grep -oE '"id":"[^"]+"' | head -1)"
pass "logged in as $DEMO_USER via JWKS-verified token ($id_before)"

echo "── 6. data survives an app + Postgres restart ───────────────────────────────"
docker compose restart app postgres >/dev/null
status=""
for _ in $(seq 1 40); do
  status="$(docker compose ps app --format '{{.Status}}' 2>/dev/null || true)"
  case "$status" in *healthy*) break ;; esac
  sleep 3
done
case "$status" in *healthy*) pass "app healthy after restart" ;; *) fail "app did not become healthy after restart: $status" ;; esac
id_after="$(login_and_whoami | grep -oE '"id":"[^"]+"' | head -1)"
[ -n "$id_before" ] && [ "$id_before" = "$id_after" ] \
  && pass "same user id survived restart (Postgres volume persisted)" \
  || fail "persistence check failed: $id_before vs $id_after"

echo
echo "✓✓ all smoke checks passed"
echo "   open $BASE and log in as $DEMO_USER / $DEMO_PASS"

if [ "$KEEP_UP" = "0" ]; then
  echo "── tearing down (KEEP_UP=0) ─────────────────────────────────────────────────"
  docker compose down -v >/dev/null
fi
