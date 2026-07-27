#!/usr/bin/env bash
#
# Prints the Entra links you need for the app registration, filled in with your
# own tenant and client ids so there is nothing to hunt for in the portal.
#
#   npm run consent -- <TENANT-ID> <CLIENT-ID>
#
# With no arguments it reads them from .dev.vars if that file exists.

set -euo pipefail

cd "$(dirname "$0")/.."

BOLD=$'\033[1m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; RED=$'\033[0;31m'; OFF=$'\033[0m'

read_value() {
  sed -n "s/^[[:space:]]*$1=//p" .dev.vars 2>/dev/null | head -n1 | sed 's/[[:space:]]*$//'
}

TENANT="${1:-$(read_value GRAPH_TENANT_ID)}"
CLIENT="${2:-$(read_value GRAPH_CLIENT_ID)}"

if [ -z "$TENANT" ] || [ -z "$CLIENT" ]; then
  echo "${RED}Need a tenant id and a client id.${OFF}"
  echo
  echo "  ${BOLD}npm run consent -- <TENANT-ID> <CLIENT-ID>${OFF}"
  echo
  echo "Both are on your app's Overview page in https://entra.microsoft.com"
  echo "  Tenant id  = \"Directory (tenant) ID\""
  echo "  Client id  = \"Application (client) ID\""
  exit 1
fi

echo
echo "${BOLD}1. Declare the permission${OFF} (must happen before consent means anything)"
echo
echo "   ${GREEN}https://entra.microsoft.com/#view/Microsoft_AAD_RegisteredApps/ApplicationMenuBlade/~/CallAnAPI/appId/${CLIENT}${OFF}"
echo
echo "   That should land you straight on the app's API permissions page."
echo "   Add a permission -> Microsoft Graph -> ${BOLD}Application permissions${OFF}"
echo "   -> Calendars.ReadWrite -> Add."
echo
echo "   ${YELLOW}Application${OFF} permissions, not ${YELLOW}Delegated${OFF}. Delegated looks like it"
echo "   worked and then fails at runtime, because there is no signed-in user"
echo "   in a cron job for it to act on behalf of."
echo
echo "${BOLD}2. Grant admin consent${OFF}"
echo
echo "   ${GREEN}https://login.microsoftonline.com/${TENANT}/adminconsent?client_id=${CLIENT}${OFF}"
echo
echo "   Open that, sign in as a tenant admin, review, Accept."
echo "   Send it to your admin if you are not one — it works for them too."
echo
echo "   ${YELLOW}Note:${OFF} the app has no redirect URI registered, so after you accept you"
echo "   may land on a blank or error page. That is expected and harmless — the"
echo "   consent is already recorded at that point. Confirm on the permissions"
echo "   page from step 1: Calendars.ReadWrite should show a green tick."
echo
