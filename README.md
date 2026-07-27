# Airdate

Mirrors an iCalendar (ICS) feed of upcoming TV episodes into a dedicated Microsoft 365
(Exchange Online) calendar via the Microsoft Graph API, running as a Cloudflare Worker
on a cron you control.

## Why

Exchange Online can subscribe to an ICS URL natively, but Microsoft refreshes
subscribed calendars on its own schedule — commonly 3 to 24+ hours, with no way to
force a refresh. That latency makes the calendar untrustworthy for schedule changes
and delays.

Airdate replaces the subscription with an active push: a scheduled Worker polls the
feed and reconciles it against a dedicated Exchange calendar, hourly by default.

## How it works

```
Cloudflare Worker (cron, hourly)
  │
  ├─ 1. Fetch ICS            public feed, or private feed behind
  │                          Cloudflare Access with a service token
  ├─ 2. Parse ICS         →  NormalizedEvent[]
  ├─ 3. Load state           Workers KV, one blob
  ├─ 4. Diff                 creates / updates / deletes / prunes
  ├─ 5. Acquire token        client credentials, cached in KV
  ├─ 6. Apply via $batch     20 sub-requests per batch
  └─ 7. Write state back
```

No inbound HTTP is required. An authenticated debug endpoint is available if you
opt into it — see [HTTP endpoints](#http-endpoints).

### The delete rule

ICS feeds cover a rolling window. Episodes leave the feed **because they have aired**,
not because they were cancelled. Airdate therefore only deletes a calendar entry when
the event it tracked is *still in the future*.

Without that guard every run would delete everything that had already aired and the
calendar would keep no history at all. Events that have aired are kept on the calendar
forever; they are simply dropped from sync state after `STATE_RETENTION_DAYS`.

An empty or failed feed fetch aborts the run and mutates nothing, for the same reason:
an empty feed is far more likely to be an expired token than a genuine "nothing is
airing".

## Setup

👉 **[SETUP.md](SETUP.md) is the step-by-step checklist.** Follow that. It walks
through every value you need to collect and where each one goes, and
`npm run doctor` will tell you what is still missing at any point.

```bash
npm install
npx wrangler login
cp .dev.vars.example .dev.vars   # paste your secrets in here
npm run doctor                   # tells you what's left to fill in
npm run secrets:push             # uploads them to Cloudflare
npm run deploy
```

The rest of this section is the same process in condensed form, for reference.

### 1. Entra ID app registration

1. Entra admin center → App registrations → New registration. Single tenant, no
   redirect URI (client credentials flow).
2. Certificates & secrets → New client secret. **Record the value immediately.**
3. API permissions → Microsoft Graph → **Application** permissions →
   `Calendars.ReadWrite` → **Grant admin consent**.
4. Record the **Tenant ID**, **Client ID** and **Client secret**.

### 2. Restrict the app to a single mailbox

Application permissions grant access to *every mailbox in the tenant* by default.
This step is not optional if you care about blast radius.

```powershell
Connect-ExchangeOnline

New-DistributionGroup -Name "sg-tvcal-sync" -Type Security -Members <your-upn>

New-ApplicationAccessPolicy `
  -AppId <client-id> `
  -PolicyScopeGroupId sg-tvcal-sync@<domain> `
  -AccessRight RestrictAccessTo `
  -Description "Airdate calendar sync worker"

Test-ApplicationAccessPolicy -Identity <your-upn> -AppId <client-id>
```

Propagation can take up to an hour, and `Test-ApplicationAccessPolicy` reports
`Granted` before Graph actually honours it. Expect `403`s during that window —
Airdate logs those distinctly, as a configuration fault rather than a transient one.

### 3. ICS source

**TVmaze (primary).** Log in and take the personal iCal feed URL from the dashboard:
`https://api.tvmaze.com/ical/followed?token=<token>`. Put the base URL in `ICS_URL`
and the token in the `ICS_TOKEN` secret — never in `wrangler.toml`.

**Sonarr (alternative).** Settings → Calendar → iCal Feed. The URL embeds the Sonarr
API key, which grants full control of the instance, so it must not be exposed publicly.
Front it with a Cloudflare Tunnel and an Access application using a service token, then
set `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET`.

### 4. Cloudflare

```bash
npm install

npx wrangler kv namespace create TV_SYNC_STATE
npx wrangler kv namespace create TV_SYNC_STATE --preview
```

Paste the returned ids into `wrangler.toml`, then set the secrets:

```bash
wrangler secret put GRAPH_TENANT_ID
wrangler secret put GRAPH_CLIENT_ID
wrangler secret put GRAPH_CLIENT_SECRET
wrangler secret put ICS_TOKEN            # if your feed uses one

wrangler deploy
```

## Configuration

### Vars (`wrangler.toml`, plaintext — nothing sensitive)

| Var | Default | Purpose |
|---|---|---|
| `ICS_URL` | — | Feed base URL, **https only** |
| `TARGET_UPN` | — | Mailbox to write to |
| `CALENDAR_NAME` | `TV` | Calendar to find or create |
| `EVENT_CATEGORY` | `TV` | Category applied to every event |
| `DEFAULT_DURATION_MINUTES` | `30` | Used when a VEVENT has no DTEND or DURATION |
| `DISPLAY_TIMEZONE` | `UTC` | IANA zone events are written in |
| `STATE_RETENTION_DAYS` | `30` | How long aired events stay in sync state |
| `RECENT_LIMIT` | `100` | Entries kept in the recent-additions log |
| `FEED_ID` | `default` | Scopes this feed's KV state |
| `DEBUG` | `false` | Enables debug-level logging |

### Secrets (`wrangler secret put`)

| Secret | Required | Purpose |
|---|---|---|
| `GRAPH_TENANT_ID` | yes | Entra tenant id |
| `GRAPH_CLIENT_ID` | yes | App registration client id |
| `GRAPH_CLIENT_SECRET` | yes | App registration client secret |
| `ICS_TOKEN` | if feed uses one | Appended to `ICS_URL` as `?token=` |
| `CF_ACCESS_CLIENT_ID` | tunnelled source only | Access service token id |
| `CF_ACCESS_CLIENT_SECRET` | tunnelled source only | Access service token secret |
| `MANUAL_TRIGGER_TOKEN` | no | Enables the HTTP endpoints; min 32 chars |
| `ALERT_WEBHOOK_URL` | no | POSTed to when a run reports errors |

Configuration is validated at the start of every run and **every** problem is reported
at once. A run with invalid configuration does nothing rather than doing something
partial.

## Recent-additions log

Every successfully created episode is appended to an inspectable KV log — what was
added and when — capped at `RECENT_LIMIT` (default 100), newest first.

It lives in its own KV key (`recent-additions`), separate from `sync-state`, so it has
its own write budget and survives a state reset.

```bash
wrangler kv key get --binding TV_SYNC_STATE recent-additions --remote | jq
```

Or over HTTP, if you have set `MANUAL_TRIGGER_TOKEN`:

```bash
curl -H "Authorization: Bearer $MANUAL_TRIGGER_TOKEN" \
  https://airdate.<subdomain>.workers.dev/recent | jq
```

```json
{
  "count": 2,
  "entries": [
    {
      "uid": "tvmaze-episode-2634518",
      "summary": "Severance - S02E05 - Trojan's Horse",
      "start": "2026-07-30T21:00:00.000Z",
      "addedAt": "2026-07-27T12:00:00.000Z",
      "eventId": "AAMkAD...",
      "feedId": "default"
    }
  ]
}
```

## HTTP endpoints

**Disabled entirely unless `MANUAL_TRIGGER_TOKEN` is set** — without it the Worker
answers `404` to everything, so the surface is not even detectable. All endpoints
require `Authorization: Bearer <MANUAL_TRIGGER_TOKEN>`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/recent` | The recent-additions log. `?limit=N` supported |
| `GET` | `/status` | Feed id, calendar, tracked event count, last sync |
| `POST` | `/sync` | Trigger a sync now. Rate-limited to once per minute |

## Security posture

- **Secrets never reach logs.** Every log line is serialized then scrubbed of all
  known secret values before emission, so a Graph error body that echoes a credential
  cannot leak. The feed URL is only ever logged as origin + path — never the query
  string, where the token lives.
- **Plaintext feed URLs are rejected** at config load; a token over `http` is a token
  on the wire.
- **Token comparison is timing-safe.** Both sides are SHA-256 digested before
  comparison, so neither length nor first-differing-byte is observable.
- **Calendar bodies are sent as `contentType: "text"`**, never HTML. Feed content is
  attacker-influenceable in the general case; as text, a synopsis cannot inject markup
  into the calendar item as Outlook renders it.
- **The Graph token cache is bound to a fingerprint of the client secret**, so rotating
  the secret invalidates the cached token automatically.
- **Responses carry no CORS headers**, `nosniff`, `no-store` and `DENY` framing, and
  never echo configuration detail to an unauthenticated caller.
- **The mailbox is scoped by ApplicationAccessPolicy** (setup step 2) — without it the
  app registration can read and write every calendar in the tenant.
- **Writes go to a dedicated calendar**, never the default one, so a bad run can be
  undone by deleting one calendar.
- **A leaked `MANUAL_TRIGGER_TOKEN`** grants: reading the recent log, reading status,
  and triggering a sync at most once per minute. It cannot read secrets or write
  arbitrary calendar data.

## Development

```bash
npm test           # 125 tests, in real workerd via Miniflare
npm run typecheck  # regenerates runtime types, then tsc --noEmit
npm run dev        # wrangler dev
```

Tests run in the Workers runtime rather than Node, so `crypto.subtle`, KV and `Intl`
behave exactly as they will in production. The parser is verified against captured
TVmaze and Sonarr fixtures covering folded lines, escape sequences, all-day events,
`DURATION`, and `TZID` wall times on both sides of a DST transition.

The reconciliation engine is a pure function of feed + state + clock, so every delete
rule is tested exhaustively without a Graph account.

## Design notes

**ICS parsing is hand-rolled.** `node-ical` depends on Node runtime APIs that do not
work reliably on Workers. These feeds are flat `VEVENT` lists with no `RRULE` and no
recurrence expansion, so a purpose-built reader is small and avoids the dependency
entirely.

**Timezones go through `Intl`, never hard-coded offsets.** Workers ship full ICU. A
fixed offset is wrong twice a year.

**State is one KV blob, not one key per event.** KV allows roughly one write per second
per key; a single blob read once and written once per run is faster, cheaper and atomic
from a reader's point of view.

**`showAs: "free"` and `isReminderOn: false` are load-bearing.** Without them a busy
week fills your free/busy availability with blocks that make you look booked solid, and
fires a reminder for every episode.

## Roadmap

### Admin GUI

Planned: a small admin interface for managing feeds and rotating credentials, with
**Cloudflare Access in front** — SSO/MFA enforced at the edge, with the Worker
verifying the signed Access JWT, so there is no hand-rolled password, session or CSRF
logic to get wrong. Secrets will be **write-only**: settable and rotatable, displayed
only as a masked fingerprint, never readable back over HTTP. A GUI compromise then
cannot exfiltrate existing credentials.

State is already scoped by `FEED_ID`, so multi-feed support is additive rather than a
migration.

### On parallelism

For this workload, a manager Worker spawning sub-Workers would be a pessimisation:

- The work is **I/O-bound, not CPU-bound**. One isolate holds many concurrent fetches
  happily, and time spent waiting on a fetch does not count against Worker CPU time.
- **`$batch` already does the bundling.** 200 events is 10 batches, run 4 at a time.
- **The real constraint is Graph's throttler, not local capacity.** Fanning out makes
  throttling *worse* and destroys the ability to coordinate one backoff across workers.
- **A single writer is a feature.** One KV key at ~1 write/sec means concurrent workers
  would race and lose updates.

Fan-out becomes correct when the units of work are genuinely independent — many feeds
or many mailboxes. The idiomatic shape there is **Cloudflare Queues**: the cron becomes
a producer that enqueues one message per feed, and a consumer processes one feed per
message, with per-message retries and a dead-letter queue. That is the version of
"manager and task doers" worth building, and only once there is more than one feed.

## Non-goals

- No two-way sync. The Exchange calendar is a mirror; edits there are overwritten.
- No writes back to Sonarr, TVmaze or Trakt.
- No handling of recurring events. These feeds do not emit them.

## License

Apache 2.0 — see [LICENSE](LICENSE).
