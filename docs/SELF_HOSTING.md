# Self-hosting guide

This repository is a reference copy of a read-only MCP server. This guide covers adding your own endpoint to Claude,
running the server locally, and hosting your own copy on Vercel.

## Your endpoint

Once you run the server locally or host your own copy, its MCP endpoint is:

```
https://<your-domain>/lego-catalog/mcp
```

Use the **full path**. The origin alone is not an MCP endpoint: it answers 405 to MCP requests, and Claude then shows a
misleading sign-in warning. Without the token the full path answers 401.

A deployed copy requires a bearer token: requests must send `Authorization: Bearer <token>`, where the token is the
value of the `MCP_AUTH_TOKEN` environment variable (see "Host your own copy"). The local dev server does not check it.

## Add the connector in Claude

Source: https://claude.com/docs/connectors/custom/add-unlisted (read 2026-10-05).

- **Free / Pro / Max:** Customize -> Connectors -> **Add custom connector** -> enter the URL
  `https://<your-domain>/lego-catalog/mcp` -> Authentication: **No sign-in**, then under **Request headers** add `authorization` =
  `Bearer <your token>` and mark it Required -> Add. The Free plan allows one custom
  connector.
- **Request headers** are in beta and available to a limited set of organizations. Claude stores the value and does not
  show it again, and a saved header cannot be edited: to change the token, remove the connector and add it again
  [source: Claude's custom connector documentation, read 2026-10-06].
- **Team / Enterprise:** an Owner adds it under Organization settings -> Connectors -> Add -> Custom (type Web) -> URL.
  Members then open Customize -> Connectors and click Connect.
- In a chat: **+** -> Connectors -> turn it on for that conversation. For a Claude Project, enable it there.
- Server URL must be HTTPS and accept MCP at that path, e.g. `https://mcp.example.com/mcp`.

## Run locally

Requires Node 22.x (`node:sqlite` is used and prints an experimental warning) and pnpm.

```powershell
pnpm install --frozen-lockfile

# Build the SQLite snapshot from Rebrickable's CSV downloads.
# Rebrickable's Downloads page allows ONE automated download per day (text read 2026-10-06); read their terms first: https://rebrickable.com/downloads/
pnpm --filter @mcps/lego-catalog build:snapshot

# Sanity-check the snapshot
node scripts/check-snapshot.mjs mcps/lego-catalog/data/rebrickable.sqlite

# Dev server on http://127.0.0.1:3000/lego-catalog/mcp (PORT env overrides the port)
pnpm --filter @mcps/lego-catalog dev

# Smoke test (initialize, tools/list, a real search_parts "brick 2 x 4" that must return 3001).
# --no-auth: the dev server has no token check; the flag is refused for any non-local URL.
node scripts/smoke-mcp.mjs --no-auth http://127.0.0.1:3000/lego-catalog/mcp
```

The server looks for the snapshot in `LEGO_CATALOG_DB`, then `mcps/lego-catalog/data/rebrickable.sqlite`.

## Host your own copy on Vercel

These are the steps the maintainer's private pipeline automates. They ran in CI on 2026-10-05; they were not re-run
from this public copy.

0. **Create the token before the first deploy.** Generate at least 32 random characters with a password manager's
   generator (or `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`), with no spaces or
   newlines (a value with whitespace makes the function answer 503), keep it in your password manager, and add them in Vercel -> Settings -> Environment Variables as `MCP_AUTH_TOKEN`, Production, **Sensitive**.
   Without it the function answers 503 to every request (it fails closed). An environment variable applies only to
   deployments made after it was set.
1. **Create the Vercel project without a Git connection.** Run `vercel link` in the repo root and create a new project.
   Do not connect a Git repository: the snapshot is gitignored, so a Git-triggered build would not have it (`vercel.json`
   also sets `git.deploymentEnabled: false`). Leave Framework Preset as "Other" and the Build/Install commands empty.
   Do not commit `.vercel/`.
2. **Build the snapshot first** (see "Run locally"). Vercel never builds it.
3. `vercel pull --yes --environment=production`
4. `vercel build --prod`
5. **Check the build output** before deploying:
   - `.vercel/output/functions/**/.vc-config.json` lists `mcps/lego-catalog/data/rebrickable.sqlite` under `filePathMap`.
   - `.vercel/output/static` contains only `index.html`.
6. `vercel deploy --prebuilt --prod`
7. **Smoke-test your public production URL.** Read the real alias from the Vercel dashboard (Domains tab) or the deploy
   output; do not guess it. Then, in PowerShell, with the token copied to the clipboard:
   `$env:MCP_AUTH_TOKEN = Get-Clipboard; node scripts/smoke-mcp.mjs https://<your-domain>/lego-catalog/mcp https://<your-domain>/api/lego-catalog/mcp`
   Each URL must answer 401 without the token, 401 with a wrong one, and work with the right one. Afterwards clear it:
   `Remove-Item Env:MCP_AUTH_TOKEN; Set-Clipboard -Value $null`.

Also check once in the dashboard: Settings -> Deployment Protection (the production domain must be reachable without a
Vercel login, otherwise the smoke test and Claude get 401; which default applies to your plan is UNVERIFIED), and the
Node.js version setting (see below).

### Why `vercel.json` looks the way it does

- `outputDirectory: "public"`: without it, `.vercel/output/static` would hold a copy of the whole repository, and a
  prebuilt deploy would publish it as public static files. With it, only `public/index.html` is published.
- `functions[...].includeFiles` registers the snapshot in the function's `filePathMap` (in `.vc-config.json`). It does
  not copy the file into the function folder, so check the map, not the folder.
- `rewrites` maps `/lego-catalog/mcp` to the function at `/api/lego-catalog/mcp`. Both paths reach the same function, so
  the token check covers both.
- `.ts` import specifiers are not used in function code, so the function builds without special handling.
- `engines.node` is `22.x` in the root `package.json`, so production runs the same Node line the tests run on.

## Operating notes

- **Bearer token:** compared in constant time; a missing or wrong token gets 401, an unset `MCP_AUTH_TOKEN` gets 503.
  No CORS headers are sent.
- **Spend:** set a spend amount with notifications in Vercel's Spend Management. Its "pause production deployments"
  option pauses every project on the team, so check which projects share the team first.
- **If you remove the token check** and run a public endpoint, add a rate-limit rule on **both** `/lego-catalog/mcp` and
  `/api/lego-catalog/mcp`. A per-IP key puts every Claude user behind Anthropic's outbound range `160.79.104.0/21` into one
  bucket [source: Anthropic's IP addresses documentation, read 2026-10-06]. See [SECURITY_REVIEW.md](SECURITY_REVIEW.md).
- **Rotate the token:** set the new value in Vercel (and in your CI secret if you use one), redeploy, then remove and
  re-add the connector in Claude with the new header.
- **Refresh:** rebuild the snapshot and redeploy. Every response carries `snapshot_date`. Respect Rebrickable's limit of
  one automated download per day [source: Rebrickable Downloads page, text read 2026-10-06].
- **Rollback:** a deployment is immutable, so rolling back means promoting an earlier deployment. The commands and
  dashboard options for this (Instant Rollback, `vercel rollback`) are UNVERIFIED: check Vercel's documentation before
  relying on them. Rolling back also rolls back the data, because each deployment carries the snapshot it was built with.
  **Never roll back to a deployment built before the token check:** it would serve the endpoint without authentication.
  Note the ID of your first deployment with the check and treat it as the oldest allowed rollback target.

## Attribution

- Data: Rebrickable (https://rebrickable.com/downloads/). Read Rebrickable's terms before reuse.
- LEGO is a trademark of the LEGO Group; this project is not affiliated with or endorsed by it.
- Rebrickable's Terms of Service (section 5.3) forbid training AI models on their content. This server serves data at
  inference time only. [source: Rebrickable Terms of Service, text read 2026-10-06]
- Not covered by the texts read: whether serving data derived from the CSVs is permitted. That question is open.
  This is not legal advice.
