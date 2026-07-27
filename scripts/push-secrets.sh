#!/usr/bin/env bash
#
# Reads .dev.vars and uploads every filled-in value to Cloudflare as a Worker
# secret. Blank entries are skipped, so optional settings can just be left empty.
#
# Values are piped straight into wrangler on stdin — they are never printed,
# never passed as an argument (arguments are visible in `ps`), and never written
# to your shell history.
#
#   Usage: npm run secrets:push

set -euo pipefail

cd "$(dirname "$0")/.."

ENV_FILE=".dev.vars"

RED=$'\033[0;31m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; BOLD=$'\033[1m'; OFF=$'\033[0m'

if [ ! -f "$ENV_FILE" ]; then
  echo "${RED}No .dev.vars file found.${OFF}"
  echo
  echo "Create it first:"
  echo "  ${BOLD}cp .dev.vars.example .dev.vars${OFF}"
  echo "then open .dev.vars and paste your values in."
  exit 1
fi

# Every secret the Worker understands.
REQUIRED=(GRAPH_TENANT_ID GRAPH_CLIENT_ID GRAPH_CLIENT_SECRET)
OPTIONAL=(ICS_TOKEN MANUAL_TRIGGER_TOKEN CF_ACCESS_CLIENT_ID CF_ACCESS_CLIENT_SECRET ALERT_WEBHOOK_URL)

# Pull one value out of .dev.vars without sourcing the file (sourcing would
# execute whatever is in there).
read_value() {
  local key="$1"
  sed -n "s/^[[:space:]]*${key}=//p" "$ENV_FILE" | head -n1 | sed 's/[[:space:]]*$//'
}

missing=()
for key in "${REQUIRED[@]}"; do
  if [ -z "$(read_value "$key")" ]; then
    missing+=("$key")
  fi
done

if [ ${#missing[@]} -gt 0 ]; then
  echo "${RED}These required values are still blank in .dev.vars:${OFF}"
  for key in "${missing[@]}"; do echo "  - $key"; done
  echo
  echo "See SETUP.md step 1 for where to find them."
  exit 1
fi

# Cheap sanity checks that catch the two most common paste mistakes.
manual_token="$(read_value MANUAL_TRIGGER_TOKEN)"
if [ -n "$manual_token" ] && [ ${#manual_token} -lt 32 ]; then
  echo "${RED}MANUAL_TRIGGER_TOKEN is only ${#manual_token} characters; it must be at least 32.${OFF}"
  echo "Generate a proper one with:  openssl rand -hex 32"
  exit 1
fi

access_id="$(read_value CF_ACCESS_CLIENT_ID)"
access_secret="$(read_value CF_ACCESS_CLIENT_SECRET)"
if { [ -n "$access_id" ] && [ -z "$access_secret" ]; } || { [ -z "$access_id" ] && [ -n "$access_secret" ]; }; then
  echo "${RED}CF_ACCESS_CLIENT_ID and CF_ACCESS_CLIENT_SECRET must both be set, or both be blank.${OFF}"
  exit 1
fi

echo "${BOLD}Uploading secrets to Cloudflare...${OFF}"
echo

pushed=0
skipped=0

for key in "${REQUIRED[@]}" "${OPTIONAL[@]}"; do
  value="$(read_value "$key")"

  if [ -z "$value" ]; then
    echo "  ${YELLOW}skip${OFF}  $key (blank)"
    skipped=$((skipped + 1))
    continue
  fi

  # stdin, so the value never appears in the process list.
  if printf '%s' "$value" | npx wrangler secret put "$key" >/dev/null 2>&1; then
    echo "  ${GREEN}ok${OFF}    $key"
    pushed=$((pushed + 1))
  else
    echo "  ${RED}FAIL${OFF}  $key"
    echo
    echo "${RED}Upload failed.${OFF} Most likely you are not logged in. Run:"
    echo "  ${BOLD}npx wrangler login${OFF}"
    exit 1
  fi
done

echo
echo "${GREEN}Done.${OFF} $pushed uploaded, $skipped left blank."
echo
echo "Next:  ${BOLD}npm run deploy${OFF}"
