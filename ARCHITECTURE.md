# Architecture

## High level

The Shipping Invoice Analyzer is a Cloudflare Worker that serves a single-page HTML dashboard and a handful of JSON APIs. Data lives in three places:

1. **Cloudflare KV** — the canonical store. Holds parsed UPS/DHL charge records, Business Central revenue, Vendor Ledger Entries, the parsed rate cards, and the corrections overlay.
2. **Browser localStorage** — per-user state (current filter selections, DHL rate card if uploaded locally).
3. **External sources** — UPS/DHL invoice CSVs (uploaded manually), and a Google Sheet connected to BigQuery (BC data).

## Data flow

```
┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
│ UPS Billing Ctr  │    │ DHL MyBill       │    │ Business Central │
│ (CSV download)   │    │ (CSV download)   │    │ ↓ via DLT        │
└────────┬─────────┘    └────────┬─────────┘    │ BigQuery views   │
         │                       │              │ ↓ Connected Sheet│
         │                       │              │ ↓ "Publish to web│
         │ (browser-side parse)  │ (parse)      │   as CSV"        │
         ▼                       ▼              ▼
   ┌───────────────────────────────────────────────────────────┐
   │            Cloudflare Worker (src/worker.js)               │
   │                                                            │
   │   /api/records       /api/revenue    /api/sync-bq          │
   │   /api/corrections   /api/rate-card  /api/sync-vle         │
   │   /api/health                                              │
   │                                                            │
   │   scheduled() at 06:00 UTC nightly:                        │
   │     - syncFromBq(env)  — pulls Posted Sales Invoice Lines  │
   │     - syncFromVle(env) — pulls Vendor Ledger Entries       │
   └───────────────────────────┬───────────────────────────────┘
                               │
                               ▼
                    ┌──────────────────────┐
                    │ Cloudflare KV         │
                    │  all_charges_v1       │
                    │  revenue_v1           │
                    │  vendor_ledger_v1     │
                    │  rate_card_v1         │
                    │  corrections_v1       │
                    │  bq_synced_at         │
                    │  vle_synced_at        │
                    └──────────┬───────────┘
                               │
                               ▼
            ┌────────────────────────────────────────┐
            │ Browser dashboard                        │
            │ (code/dashboard/Shipping_Analyzer.html)  │
            │                                          │
            │ Reads from /api/* on page load,          │
            │ renders KPI tiles + 11 tabs,             │
            │ stores DHL rate card in localStorage     │
            └────────────────────────────────────────┘
```

## Key modules

### `src/worker.js`

The Cloudflare Worker entrypoint. Defines:

- **HTTP routes** — `/api/records`, `/api/revenue`, `/api/corrections`, `/api/sync-bq`, `/api/sync-vle`, `/api/rate-card`, `/api/health`. Everything else falls through to the static asset binding (the dashboard HTML).
- **`scheduled(event, env, ctx)` handler** — runs on cron `0 6 * * *`. Calls `syncFromBq()` then `syncFromVle()` in sequence. Records timestamps to KV (`bq_synced_at`, `vle_synced_at`) so the dashboard can show freshness.
- **`handleStore()`** — generic GET/POST/DELETE handler for additive-merge KV stores. Used by `/api/records` and `/api/revenue`.
- **`handleVleSync()`** — VLE is REPLACE not additive (ledger state changes as invoices get paid).
- **`syncFromBq()` / `syncFromVle()`** — fetch published-CSV URL, parse, normalize column names (snake_case → camelCase), write to KV.
- **`handleRateCard()`** — stores parsed rate card JSON (UPS) under one KV key. DHL rate card lives in browser localStorage.

### `code/dashboard/Shipping_Analyzer.html`

The single-page dashboard. Pure HTML + vanilla JS. Loads SheetJS (XLSX) and Chart.js from CDN. Uses the auth gate (team password → SHA-256 → session storage) for access control. ~4,700 lines including the embedded styles and the Excel export builder.

Major sections:
- **`fetchVle()` / `fetchRevenue()` / `fetchRecords()`** — load data from `/api/*` on page init
- **`render()`** — main render function; produces every tab's HTML in one pass
- **`parseUpsRateCard()` / `parseDhlRateCard()`** — XLSX/XML parsing
- **`lookupExpectedRate()`** — variance lookup; routes DHL charges to `lookupExpectedDhlRate()`
- **`buildAndDownloadXlsx()`** — Excel export, ~10 sheets

### `code/pipeline/ups_pipeline.py` and `dhl_pipeline.py`

Python parsers, kept for batch/offline use. The dashboard does the same parsing in-browser via JS, so the Python pipelines are no longer in the live request path. They're useful for:
- Bulk historical reprocessing
- Generating standalone Excel workbooks outside the dashboard
- Validating the JS parser against a known-good Python implementation

### `wrangler.jsonc`

Cloudflare Worker config. Defines:
- `name` — the worker name (becomes the subdomain)
- `kv_namespaces` — `CHARGES_KV` binding to a specific KV namespace ID
- `triggers.crons` — `["0 6 * * *"]` nightly sync
- `vars` — `AUTH_HASH` (team password SHA-256), `BQ_SHEET_URL`, `VLE_SHEET_URL`

## Charge categorisation model

Both UPS and DHL charges map to a common set of buckets:

| Bucket | Description |
|---|---|
| Freight | Base shipping charge (UPS FRT, DHL Weight Charge) |
| Fuel Surcharge | Variable % on freight (UPS FSC, DHL FF) |
| Service Surcharges | Per-package add-ons (UPS PFC/AHC/HIS/etc., DHL FD/YK) |
| Documentation | Per-invoice paperwork (UPS CIS/ALP/FIP/F/D) |
| Service Issues | Penalties (UPS PIF, CGS) |
| Brokerage | Customs clearance (UPS BRK) |
| VAT | Reclaimable UK VAT (UPS TAX/01, DHL TAX/A) |
| Import VAT | Pass-through VAT on imported goods (excluded from our cost) |
| Duty/Tax | Non-reclaimable customs duty |
| Adjustment | Post-invoice corrections, refunds, DHL discounts |

DHL-specific code mappings live in [`docs/decisions/003-dhl-charge-codes.md`](docs/decisions/003-dhl-charge-codes.md).

## Verification logic

Per invoice, the parser:
1. Sums all charge lines (Net, including VAT but excluding Import VAT)
2. Compares the sum to the carrier's "Invoice Total" field
3. Flags anomalies if the difference exceeds £0.01

Carrier invoice totals are also compared to BC's Vendor Ledger Entry amounts (within £0.05 tolerance, ±21 days posting date) to assign the Paid/Due/Overdue status on the By Carrier Invoice tab.

## Anomaly thresholds

| Anomaly | Threshold |
|---|---|
| Rate card variance (UPS) | £5+ OR 20%+ off (either alone is enough) |
| Rate card variance (DHL) | Same |
| Fuel surcharge anomaly | Fuel >40% of freight on a single shipment |
| High-value shipment | Single charge >£500 |
| Repeat tracking number | Same tracking on >2 invoices (possible duplicate billing) |

## Important characteristics of BC data

- Vendor invoices post as **negative** in BC (`original_amt_lcy`, `remaining_amt_lcy`). The Worker normalizes via `Math.abs()` before storing.
- The `external_document_no` field on Vendor Ledger Entries is often empty. Without it, we can't directly link a carrier invoice to its BC vendor entry — we match by amount + posting date proximity (~77% match rate). Resolving this on the BC side would improve Status column accuracy.

## Decisions worth knowing

See [`docs/decisions/`](docs/decisions/) for full ADRs. Headlines:

- **Cloudflare Workers over Vercel/Lambda** — cheapest Free-tier fit for the workload (server code + nightly cron + shared storage). ADR 001.
- **Google Sheet as BC conduit** — interim solution; gives BC data to the Worker without a GCP service account. Roadmap item: replace with direct BigQuery queries.
- **DHL rate card stored in browser localStorage** rather than shared KV — minimises Worker changes for the M12.2 rollout. Each finance user uploads it once.
- **VLE storage is REPLACE not additive** — ledger state changes when invoices get paid; we want the current snapshot, not historical accumulation.
- **Corrections overlay** for orphan carrier rows — non-destructive way to attach SO refs to shipments where the carrier label was blank. ADR 005.
- **VAT split** — UK VAT (reclaimable) vs Import VAT (pass-through, excluded from cost). ADR 004.
