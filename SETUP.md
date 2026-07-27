# Airdate — Setup

Follow these in order. Don't skip ahead. Roughly **30–45 minutes**, most of it
waiting on Microsoft.

At any point you can run:

```bash
npm run doctor
```

and it will tell you exactly what is still missing and which step covers it.

---

## The one concept you need

There are **two** kinds of settings, and putting one in the wrong place is the
single most common mistake:

| | Goes in | Is it secret? |
|---|---|---|
| **Vars** — your email, feed URL, timezone | `wrangler.toml` | **No.** Public. Anyone reading the repo sees these. |
| **Secrets** — passwords, tokens, client secrets | `.dev.vars` → uploaded to Cloudflare | **Yes.** Never committed, never public. |

**If a value would let someone else do something as you, it is a secret.**
It does not go in `wrangler.toml`. Ever.

---

## Worksheet

Print this, or keep it in a scratch note. You will collect 6 values.
**Delete the note when you're done.**

| # | Value | Where you get it | Goes in |
|---|---|---|---|
| 1 | Tenant ID | Step 1 | `.dev.vars` |
| 2 | Client ID | Step 1 | `.dev.vars` |
| 3 | Client secret | Step 1 | `.dev.vars` |
| 4 | Feed token | Step 3 | `.dev.vars` |
| 5 | KV namespace id | Step 4 | `wrangler.toml` |
| 6 | KV preview id | Step 4 | `wrangler.toml` |

---

## Step 0 — Install things

```bash
npm install
npx wrangler login
```

`wrangler login` opens a browser. Approve it.

- [ ] `npm install` finished without errors
- [ ] Browser said you're logged in to Cloudflare

---

## Step 1 — Register the app with Microsoft

This is what lets the Worker write to your calendar.

**1a. Create the registration**

1. Go to **https://entra.microsoft.com**
2. Left sidebar → **Applications** → **App registrations**
3. Click **+ New registration**
4. Name: `Airdate` (anything you like)
5. Supported account types: **Accounts in this organizational directory only**
6. Redirect URI: **leave completely blank**
7. Click **Register**

You land on the Overview page. Two of your values are right there:

- **Directory (tenant) ID** → this is **Value 1**
- **Application (client) ID** → this is **Value 2**

Copy both onto your worksheet now.

- [ ] Value 1 (Tenant ID) written down
- [ ] Value 2 (Client ID) written down

**1b. Create a client secret**

1. Left sidebar of your app → **Certificates & secrets**
2. **Client secrets** tab → **+ New client secret**
3. Description: `airdate`, Expires: 24 months
4. Click **Add**

> ⚠️ **Copy the value immediately.** The table shows two columns —
> you want the one headed **Value**, *not* **Secret ID**. Once you leave this
> page it is hidden forever. If you miss it, delete the secret and make another.

- [ ] Value 3 (Client secret, from the **Value** column) written down

**1c. Grant the permission**

Once you have Values 1 and 2, this prints both links you need, filled in with
your own ids so there is nothing to hunt for:

```bash
npm run consent -- <Value 1: tenant id> <Value 2: client id>
```

Or do it by hand:

1. Left sidebar of your app → **API permissions**
2. **+ Add a permission** → **Microsoft Graph**
3. Choose **Application permissions** — ***not*** Delegated permissions
4. Search for `Calendars.ReadWrite`, tick it, click **Add permissions**
5. Back on the list, click **Grant admin consent for &lt;your org&gt;** → **Yes**

- [ ] `Calendars.ReadWrite` shows a green tick under "Status"

> Why **Application** and not **Delegated**: delegated permissions act on behalf
> of a signed-in user. A cron job has no signed-in user, so a delegated grant
> looks correct in the portal and then fails at runtime.

**If you are not a tenant admin**, the "Grant admin consent" button is greyed
out. Send your admin this link instead — it gives them a normal Microsoft
sign-in page, shows exactly what is being granted, and they click Accept:

```
https://login.microsoftonline.com/<tenant-id>/adminconsent?client_id=<client-id>
```

They may land on a blank or error page afterwards, because this app has no
redirect URI registered. That is harmless — the consent is recorded before the
redirect happens. Confirm by reloading the API permissions page and looking for
the green tick.

---

## Step 2 — Lock the app to your mailbox only

**Do not skip this.** What you just created can currently read and write the
calendar of **every single person in your tenant**. This step restricts it to
one mailbox.

Open PowerShell:

```powershell
Install-Module ExchangeOnlineManagement -Scope CurrentUser
Connect-ExchangeOnline
```

Then, replacing the three placeholders:

```powershell
New-DistributionGroup -Name "sg-airdate" -Type Security -Members <YOUR-EMAIL>

New-ApplicationAccessPolicy `
  -AppId <VALUE-2-CLIENT-ID> `
  -PolicyScopeGroupId sg-airdate@<YOUR-DOMAIN> `
  -AccessRight RestrictAccessTo `
  -Description "Airdate calendar sync"
```

Check it:

```powershell
Test-ApplicationAccessPolicy -Identity <YOUR-EMAIL> -AppId <VALUE-2-CLIENT-ID>
```

- [ ] It printed `AccessCheckResult : Granted`

> ⏰ **This takes up to an hour to actually take effect**, and the test above
> says `Granted` before Graph honours it. If your first sync fails with a 403,
> this is why. Wait, then try again.

---

## Step 3 — Get your TV feed

### TVmaze (easiest)

1. Log in at **https://www.tvmaze.com**
2. Go to your dashboard and find the **personal iCal feed** link
3. It looks like: `https://api.tvmaze.com/ical/followed?token=abc123xyz`

Split it in two:

- The part **before** `?token=` → stays in `wrangler.toml` as `ICS_URL`
- The part **after** `?token=` → **Value 4**, goes in `.dev.vars`

- [ ] Value 4 (feed token) written down

### Sonarr (harder, only if you self-host)

Settings → Calendar → iCal Feed.

> ⚠️ The Sonarr feed URL contains your **API key**, which gives full control of
> your Sonarr instance. Do not put that URL anywhere public. Put it behind a
> Cloudflare Tunnel with an Access service token, then fill in
> `CF_ACCESS_CLIENT_ID` and `CF_ACCESS_CLIENT_SECRET` in `.dev.vars` instead.

---

## Step 4 — Create the Cloudflare storage

Run both commands:

```bash
npx wrangler kv namespace create TV_SYNC_STATE
npx wrangler kv namespace create TV_SYNC_STATE --preview
```

Each prints something like:

```
id = "a1b2c3d4e5f6..."
```

The first is **Value 5**, the second is **Value 6**.

- [ ] Value 5 and Value 6 written down

---

## Step 5 — Fill in the two files

### 5a. `wrangler.toml` (the public one)

Open it. Replace all four `PASTE_...` placeholders:

| Replace | With |
|---|---|
| `PASTE_YOUR_KV_NAMESPACE_ID_HERE` | Value 5 |
| `PASTE_YOUR_PREVIEW_KV_NAMESPACE_ID_HERE` | Value 6 |
| `PASTE_YOUR_EMAIL_HERE@example.com` | Your Microsoft 365 email |
| `ICS_URL` / `DISPLAY_TIMEZONE` | Your feed URL (no token!) and your IANA timezone |

### 5b. `.dev.vars` (the secret one)

```bash
cp .dev.vars.example .dev.vars
```

Open `.dev.vars` and paste in:

```
GRAPH_TENANT_ID=<Value 1>
GRAPH_CLIENT_ID=<Value 2>
GRAPH_CLIENT_SECRET=<Value 3>
ICS_TOKEN=<Value 4>
```

Optionally, to switch on the `/recent` and `/sync` endpoints, generate a token:

```bash
openssl rand -hex 32
```

and paste it as `MANUAL_TRIGGER_TOKEN=`. Leave blank if you don't want them.

Now check your work:

```bash
npm run doctor
```

- [ ] `npm run doctor` says **All set**

---

## Step 6 — Upload the secrets to Cloudflare

`.dev.vars` only works on your own machine. The deployed Worker needs its own
copy. One command does all of them:

```bash
npm run secrets:push
```

- [ ] Every required secret shows `ok`

<details>
<summary>Doing it manually instead (two other ways)</summary>

**One at a time on the command line.** It prompts, you paste, press enter:

```bash
npx wrangler secret put GRAPH_TENANT_ID
npx wrangler secret put GRAPH_CLIENT_ID
npx wrangler secret put GRAPH_CLIENT_SECRET
npx wrangler secret put ICS_TOKEN
npx wrangler secret put MANUAL_TRIGGER_TOKEN     # optional
npx wrangler secret put CF_ACCESS_CLIENT_ID      # Sonarr-behind-Access only
npx wrangler secret put CF_ACCESS_CLIENT_SECRET  # Sonarr-behind-Access only
npx wrangler secret put ALERT_WEBHOOK_URL        # optional
```

**Or in the Cloudflare dashboard** (you must deploy once first, so the Worker
exists): **Workers & Pages** → **airdate** → **Settings** → **Variables and
Secrets** → **Add** → set type to **Secret** → name and value → **Deploy**.

Use the exact names above. A typo means the Worker refuses to run and logs
which one is missing.
</details>

---

## Step 7 — Deploy

```bash
npm test        # 125 tests, should all pass
npm run deploy
```

- [ ] Deploy printed a `https://airdate.<something>.workers.dev` URL

---

## Step 8 — Check it worked

The cron runs on the hour. To watch it live, in one terminal:

```bash
npx wrangler tail
```

If you set `MANUAL_TRIGGER_TOKEN`, trigger a sync now instead of waiting:

```bash
curl -X POST -H "Authorization: Bearer <your MANUAL_TRIGGER_TOKEN>" \
  https://airdate.<your-subdomain>.workers.dev/sync
```

You want to see a line like:

```json
{"level":"info","message":"Sync complete","created":47,"updated":0,"deleted":0,"errors":0}
```

Then open Outlook. There should be a new calendar called **TV** with your
episodes in it.

See what got added recently:

```bash
curl -H "Authorization: Bearer <your MANUAL_TRIGGER_TOKEN>" \
  https://airdate.<your-subdomain>.workers.dev/recent
```

- [ ] The **TV** calendar exists in Outlook and has episodes in it

**You're done.** It will now sync every hour by itself.

---

## When it goes wrong

| What you see | What it means | Fix |
|---|---|---|
| `403` from Graph | Step 2's policy hasn't propagated yet, or admin consent wasn't granted | Wait up to an hour. Re-check step 1c shows a green tick. |
| `401` from Graph | Client secret is wrong or expired | Make a new one (step 1b), re-run `npm run secrets:push` |
| `ics-fetch-failed` | Feed URL or token is wrong | Paste your full feed URL into a browser. If it doesn't download a file, the URL is wrong. |
| `ics-feed-empty` | Feed returned nothing | Usually an expired token. Nothing was deleted — that's deliberate. |
| `Refusing to run with invalid configuration` | A required value is missing | The log lists every problem by name. Run `npm run doctor`. |
| `wrangler deploy` complains about the KV id | Step 4/5a not done | Run `npm run doctor` |
| Calendar events block out your free/busy | Shouldn't happen | Events are set `showAs: free`. If not, you edited them manually — delete the TV calendar and re-sync. |

**Nothing here can damage your real calendar.** Everything is written to a
separate calendar called `TV`. If it all goes wrong, delete that calendar in
Outlook, run `npx wrangler kv key delete --binding TV_SYNC_STATE "sync-state:default" --remote`,
and sync again from scratch.

---

## Rotating a secret later

When the client secret expires (24 months), or if you think one leaked:

1. Make the new secret in Entra (step 1b)
2. Put it in `.dev.vars`
3. `npm run secrets:push`

The Worker's cached Microsoft token is keyed to a fingerprint of the secret, so
it notices the change on the very next run — no cache to clear by hand.
