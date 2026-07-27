#!/usr/bin/env bash
#
# Checks everything you were supposed to fill in, and tells you what is still
# missing. Safe to run as many times as you like — it only reads.
#
#   Usage: npm run doctor

set -uo pipefail

cd "$(dirname "$0")/.."

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; BOLD=$'\033[1m'; OFF=$'\033[0m'

problems=0
warnings=0

ok()   { echo "  ${GREEN}✓${OFF} $1"; }
bad()  { echo "  ${RED}✗${OFF} $1"; problems=$((problems + 1)); }
warn() { echo "  ${YELLOW}!${OFF} $1"; warnings=$((warnings + 1)); }

read_value() {
  sed -n "s/^[[:space:]]*$1=//p" .dev.vars 2>/dev/null | head -n1 | sed 's/[[:space:]]*$//'
}

echo
echo "${BOLD}wrangler.toml${OFF}  (public settings)"

if grep -q "PASTE_YOUR_KV_NAMESPACE_ID_HERE" wrangler.toml; then
  bad "KV namespace id not filled in  — SETUP.md step 4"
else
  ok "KV namespace id set"
fi

if grep -q "PASTE_YOUR_PREVIEW_KV_NAMESPACE_ID_HERE" wrangler.toml; then
  bad "KV preview id not filled in    — SETUP.md step 4"
else
  ok "KV preview id set"
fi

if grep -q "PASTE_YOUR_EMAIL_HERE" wrangler.toml; then
  bad "TARGET_UPN not filled in       — put your Microsoft 365 email there"
else
  ok "TARGET_UPN set"
fi

tz=$(sed -n 's/^DISPLAY_TIMEZONE = "\(.*\)"/\1/p' wrangler.toml | head -n1)
if [ -z "$tz" ]; then
  bad "DISPLAY_TIMEZONE missing"
elif node -e "new Intl.DateTimeFormat('en',{timeZone:'$tz'})" >/dev/null 2>&1; then
  ok "DISPLAY_TIMEZONE is a real timezone ($tz)"
else
  bad "DISPLAY_TIMEZONE \"$tz\" is not a valid IANA timezone (try Europe/Oslo)"
fi

ics=$(sed -n 's/^ICS_URL = "\(.*\)"/\1/p' wrangler.toml | head -n1)
if [ -z "$ics" ]; then
  bad "ICS_URL missing"
elif [[ "$ics" == *"?token="* || "$ics" == *"apikey="* ]]; then
  bad "ICS_URL contains a token! Remove the ?token=... part — it belongs in .dev.vars as ICS_TOKEN"
elif [[ "$ics" != https://* ]]; then
  bad "ICS_URL must start with https://"
else
  ok "ICS_URL set, no token leaked into it"
fi

echo
echo "${BOLD}.dev.vars${OFF}  (secrets — never committed)"

if [ ! -f .dev.vars ]; then
  bad "File does not exist. Run:  cp .dev.vars.example .dev.vars"
else
  for key in GRAPH_TENANT_ID GRAPH_CLIENT_ID GRAPH_CLIENT_SECRET; do
    if [ -z "$(read_value "$key")" ]; then
      bad "$key is blank            — SETUP.md step 1"
    else
      ok "$key set"
    fi
  done

  if [ -z "$(read_value ICS_TOKEN)" ]; then
    warn "ICS_TOKEN is blank — fine if your feed URL has no ?token=, otherwise fill it in"
  else
    ok "ICS_TOKEN set"
  fi

  manual="$(read_value MANUAL_TRIGGER_TOKEN)"
  if [ -z "$manual" ]; then
    warn "MANUAL_TRIGGER_TOKEN blank — /recent and /sync will be switched off (that is the safe default)"
  elif [ ${#manual} -lt 32 ]; then
    bad "MANUAL_TRIGGER_TOKEN is too short (${#manual} chars, needs 32+). Use: openssl rand -hex 32"
  else
    ok "MANUAL_TRIGGER_TOKEN set and long enough"
  fi

  aid="$(read_value CF_ACCESS_CLIENT_ID)"
  asec="$(read_value CF_ACCESS_CLIENT_SECRET)"
  if { [ -n "$aid" ] && [ -z "$asec" ]; } || { [ -z "$aid" ] && [ -n "$asec" ]; }; then
    bad "CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET — set both or neither"
  fi
fi

echo
echo "${BOLD}safety${OFF}"

if git check-ignore -q .dev.vars 2>/dev/null; then
  ok ".dev.vars is gitignored, your secrets will not be committed"
else
  bad ".dev.vars is NOT gitignored — do not commit until this is fixed"
fi

if [ -f .dev.vars ] && git ls-files --error-unmatch .dev.vars >/dev/null 2>&1; then
  bad ".dev.vars is already tracked by git! Run: git rm --cached .dev.vars"
fi

echo
if [ $problems -eq 0 ]; then
  echo "${GREEN}${BOLD}All set.${OFF} $warnings warning(s)."
  echo
  echo "Next:  ${BOLD}npm run secrets:push${OFF}  then  ${BOLD}npm run deploy${OFF}"
else
  echo "${RED}${BOLD}$problems thing(s) still to fix.${OFF} $warnings warning(s)."
  echo "Each line above says which SETUP.md step covers it."
  exit 1
fi
