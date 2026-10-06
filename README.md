# lego-catalog-mcp

A monorepo of read-only [Model Context Protocol](https://modelcontextprotocol.io) (MCP) servers, all served from one
Vercel domain under `/<server>/mcp`. The first (and currently only) server is **`lego-catalog`**.

## 1. What it is

`lego-catalog` is a **read-only remote MCP server** (Streamable HTTP, stateless) that exposes the
[Rebrickable](https://rebrickable.com/downloads/) LEGO catalog (parts, colors, set inventories) from a SQLite snapshot.
The goal: an agent can **verify part IDs and colors** instead of inventing them.

Deployments require a **bearer token** (`MCP_AUTH_TOKEN`): the data is public, the endpoint is not.

> Development happens in a private source repository; the public copy at https://github.com/mariansan/lego-catalog-mcp is a reference copy updated from it periodically and runs no CI or deploy automation.

Monorepo layout:

| Path | Role |
|---|---|
| `mcps/<name>/` | One self-contained MCP server (source, tests, snapshot build scripts) |
| `api/<name>/mcp.ts` | Thin Vercel function adapter for that server |
| `/<name>/mcp` | Public URL path (rewritten to the function in `vercel.json`) |
| `scripts/` | Snapshot sanity check and smoke test |
| `docs/` | Self-hosting guide and security review |

## 2. Your endpoint and how to add it in Claude

This repository does not publish a hosted endpoint. Run the server locally or host your own copy (see the
[self-hosting guide](docs/SELF_HOSTING.md)). Your endpoint will look like:

```
https://<your-domain>/lego-catalog/mcp
```

In Claude: Customize -> Connectors -> **Add custom connector** -> paste your URL -> Authentication: **No sign-in**, then
under **Request headers** add `authorization` = `Bearer <your token>` and mark it Required. Request headers are in beta
and available to a limited set of organizations; Claude does not show a header value again after you save it, so changing
the token means removing and re-adding the connector [source: Claude's custom connector documentation, read 2026-10-06].

> **Use the FULL path.** The origin alone (`https://<your-domain>`) is not an MCP endpoint: it answers 405 to MCP
> requests, and Claude then shows a misleading sign-in warning. The full path answers 401 without the token.

The [self-hosting guide](docs/SELF_HOSTING.md#add-the-connector-in-claude) covers adding the connector (including Team/Enterprise steps and per-chat enabling), running locally and hosting your own copy.

## 3. Tools

All six tools are **read-only** (annotated `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`,
`openWorldHint: false`). Arguments are validated strictly: unknown keys are rejected with `invalid_input`.
Argument types, defaults and bounds below are copied from the zod schemas in `mcps/lego-catalog/src/tools.ts` and
`config.ts`.

| Tool | Purpose |
|---|---|
| `search_parts` | Full-text search over part names and part numbers |
| `get_part` | One part by `part_num`: category, material, colors, element records |
| `list_colors` | The Rebrickable color palette, filterable |
| `get_set_inventory` | Part list of a set (sets only, not minifigures) |
| `snapshot_info` | Snapshot date, source, row counts, limits |
| `lookup_element` | Resolve an `element_id` to part and color |

### ID vocabulary

- `part_num` is **Rebrickable's** part number: usually, but not always, the LEGO design number (printed/assembled
  variants such as `6895a` or `90462pr0004` have their own `part_num`).
- `element_id` identifies a design **in one color**.
- `design_id` exists **only on element records** (the `elements` table) and may be `null`.
- No BrickLink, LDraw or other external ids are available. `color_id` is Rebrickable's color id.

### `search_parts`

Every word in `query` must match; results are ranked by relevance. Use it to find the right `part_num`; never guess one.

| Argument | Type | Default | Bounds |
|---|---|---|---|
| `query` | string (required) | - | trimmed, 1-200 chars, at most 20 distinct words; punctuation ignored |
| `limit` | integer | 25 | 1-100 |
| `offset` | integer | 0 | 0-10,000 |

```json
{"name": "search_parts", "arguments": {"query": "brick 2 x 4", "limit": 5}}
```

Verified on the live deployment (2026-10-05): this query returns `3001` "Brick 2 x 4" first, `total` 1708.

### `get_part`

Returns name, category, material, up to 100 colors (most-used first) and up to 25 element records
(`element_id`, `color_id`, `design_id`), plus `colors_total`, `elements_total` and `*_truncated` flags.
Unknown ids return `not_found` (ids are case-sensitive).

| Argument | Type | Default | Bounds |
|---|---|---|---|
| `part_num` | string (required) | - | trimmed, 1-64 chars, e.g. `"3001"` |

```json
{"name": "get_part", "arguments": {"part_num": "3001"}}
```

Verified on the live deployment (2026-10-05): category Bricks, 78 colors, 148 elements.

### `list_colors`

About 275 colors (id, name, RGB hex, transparency, `num_parts`, `num_sets`, `first_year`, `last_year`), ordered by
`color_id`.

| Argument | Type | Default | Bounds |
|---|---|---|---|
| `name` | string (optional) | - | trimmed, 1-64 chars; case-insensitive substring |
| `is_trans` | boolean (optional) | - | `true` = transparent only, `false` = opaque only |
| `limit` | integer | **100** | 1-100 |
| `offset` | integer | 0 | 0-10,000 |

```json
{"name": "list_colors", "arguments": {"name": "blue", "is_trans": false}}
```

### `get_set_inventory`

Part list of a **set**. `"75192"` is read as `"75192-1"`. Minifigure ids (`fig-...`) are not supported and return
`not_found`. Uses the highest inventory version unless `version` is given; the response lists `available_versions`.
Rows are ordered by `part_num`, `color_id`; `is_spare` rows are not part of the built model; `total_quantity` counts
non-spare pieces.

| Argument | Type | Default | Bounds |
|---|---|---|---|
| `set_num` | string (required) | - | 1-32 chars of letters, digits, `.`, `_`, `-` |
| `version` | integer (optional) | highest available | 1-1000 |
| `limit` | integer | 25 | 1-200 |
| `offset` | integer | 0 | 0-10,000 |

```json
{"name": "get_set_inventory", "arguments": {"set_num": "75192-1", "limit": 50}}
```

Verified on the live deployment (2026-10-05): "Millennium Falcon", 2017, inventory version 2 of [2, 1], 726 rows.
An unknown set returns:

```json
{"error": {"code": "not_found", "message": "No set \"99999999-1\".", "hint": "Set numbers look like \"75192-1\" (number-version)."}}
```

### `snapshot_info`

No arguments. Returns snapshot date, source URL and attribution, build and download timestamps, schema version, the
inventory-version rule, per-table `row_counts`, the server's `limits`, and the ID notes. Call it to tell the user how
fresh the data is.

```json
{"name": "snapshot_info", "arguments": {}}
```

Row counts at the 2026-10-05 snapshot: colors 275, parts 64,826, sets 28,444, inventories 47,671, inventory_parts
1,565,757, elements 114,601.

### `lookup_element`

Resolves an element id (one design in one color, as on packaging / Pick a Brick) to `part` (`part_num`, name),
`color` (`color_id`, name, `rgb`) and `design_id` (may be `null` and may differ from `part_num`). Unknown ids return
`not_found`.

| Argument | Type | Default | Bounds |
|---|---|---|---|
| `element_id` | string (required) | - | trimmed, 1-12 digits |

```json
{"name": "lookup_element", "arguments": {"element_id": "300126"}}
```

(`"300126"` is the format example from the tool's schema; its lookup result was not checked for this README.)

## 4. Responses and limits

Every response from the tool handlers, **success and error alike**, carries `source` (`"Rebrickable"`) and
`snapshot_date`. Results are returned both as `structuredContent` and as a JSON text block.

Errors are tool results with `isError: true` and the shape
`{"source", "snapshot_date", "error": {"code", "message", "hint?"}}`. Codes: `not_found`, `invalid_input`,
`unknown_tool`, `response_too_large`, `internal_error`. Missing data is a structured `not_found`, never an empty guess.

**Known exception:** errors raised by the MCP SDK before a handler runs (for example `tools/call` with non-object
`arguments`) come back as a JSON-RPC `-32603` error **without** the envelope. A known, accepted limitation; see SEC-L2 in
[docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md).

**Pagination** (`search_parts`, `list_colors`, `get_set_inventory`): requests take `limit` and `offset`; responses add
`total`, `offset`, `limit`, `returned`, `has_more`, `next_offset` (`null` on the last page) and `size_capped`.

| Limit | Value |
|---|---|
| Default page size | 25 (`list_colors`: 100) |
| Max page size | 100 (`get_set_inventory`: 200) |
| Max `offset` | 10,000 |
| Search query | 200 characters, 20 distinct words |
| Response payload budget | 20,000 characters; rows are dropped past it and `size_capped: true` is set. `next_offset` then points at the first omitted row, so paging loses nothing |
| Hard refusal | A payload still over 24,000 characters becomes `response_too_large` |
| Request body | 64 KiB (larger gets HTTP 413) |
| JSON-RPC batches | Rejected (HTTP 400) |
| `GET` / `DELETE` | HTTP 405 (stateless: no stream or session to manage) |

Because of the payload budget, `get_set_inventory` with `limit=200` may return fewer rows than requested; follow
`next_offset`.

Latency, for orientation only: a sequential client-side sample from one machine (2026-10-05, includes network) gave
`search_parts` p50 about 130 ms and p95 about 200 ms. This is **not** a cold-start or load test and is not an SLA.

## 5. Data and refresh

- The snapshot is a SQLite file built from [Rebrickable's CSV downloads](https://rebrickable.com/downloads/) by
  `pnpm --filter @mcps/lego-catalog build:snapshot`.
- The hosted instance's snapshot is rebuilt periodically by the maintainer. Every response carries `snapshot_date`.
- Rebrickable's Downloads page allows automated downloads of the zipped CSVs at most **once a day**; do not spam rebuilds. [source: Rebrickable Downloads page, text read 2026-10-06]
- The `.sqlite` file is **never committed** (gitignored) and **never published as a download**; it is bundled only
  inside the function.
- To host your own copy, see [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md).

## 6. Development

Requires Node 22.x (`engines` in the root `package.json`; `node:sqlite` is used and prints an experimental warning) and
pnpm.

```powershell
pnpm install

pnpm lint            # eslint .
pnpm typecheck       # tsc --noEmit in every package
pnpm test            # vitest in every package

# Build the SQLite snapshot (downloads Rebrickable CSVs; max one automated download per day)
pnpm --filter @mcps/lego-catalog build:snapshot

# Local dev server on http://127.0.0.1:3000/lego-catalog/mcp (PORT env overrides the port)
pnpm --filter @mcps/lego-catalog dev

# Smoke test any endpoint
node scripts/smoke-mcp.mjs --no-auth http://127.0.0.1:3000/lego-catalog/mcp   # the dev server has no token check
```

Tests that need the real snapshot **skip** when `LEGO_CATALOG_DB` is unset. To run everything, point it at a built
snapshot:

```powershell
$env:LEGO_CATALOG_DB = "C:\path\to\rebrickable.sqlite"; pnpm test
```

The server looks for the snapshot in `LEGO_CATALOG_DB`, then `mcps/lego-catalog/data/rebrickable.sqlite`.

`MCP_AUTH_TOKEN` is required by the deployed function: set it as a **Sensitive** environment variable for Production in
Vercel (at least 32 random characters). If it is unset the function answers **503** to every request (it fails closed).
The smoke test reads the same variable from the environment, never from the command line. The local dev server does not
check it.

## 7. Security and status

See [docs/SECURITY_REVIEW.md](docs/SECURITY_REVIEW.md) for the review and its findings. Honest status:

- The deployed function requires `Authorization: Bearer <token>`. The token is compared in constant time against
  `MCP_AUTH_TOKEN`; a missing or wrong token gets 401 before the request body is read, and an unset variable gets 503.
- The local dev server has no token check and listens on 127.0.0.1 only.
- The maintainer's deployment is private.
- No CORS headers are sent.

## 8. Attribution and legal

- Data: Rebrickable (https://rebrickable.com/downloads/). Rebrickable asks to be acknowledged as the source of the data
  [source: Rebrickable Downloads page, text read 2026-10-06].
- LEGO is a trademark of the LEGO Group; this project is not affiliated with or endorsed by it.
- Rebrickable's Terms of Service (section 5.3) forbid training AI models on their content. This server serves data **at
  inference time only**. [source: Rebrickable Terms of Service, text read 2026-10-06]
- Not covered by the texts read: whether serving data derived from the CSVs is permitted. That question is open.
  This is not legal advice; read Rebrickable's terms yourself before reuse.

## 9. License

The code is released under the [MIT License](LICENSE), copyright (c) 2026 Marian Sanjur.

The license covers this repository's code only. The catalog data comes from Rebrickable and stays under Rebrickable's
own terms (see section 8); it is not relicensed by this project.
