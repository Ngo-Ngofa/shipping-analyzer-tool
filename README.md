# Shipping Invoice Analyzer

**👉 [Live demo](https://ngongofa-81.github.io/shipping-analyzer-tool/)** — interactive dashboard with sample data, runs in your browser, no setup.

A multi-carrier shipping invoice analytics dashboard, hosted on Cloudflare Workers, with automated nightly data sync from an ERP system via BigQuery, rate-card variance detection across two carriers, and a single-page interactive HTML dashboard.

**This repository is a sanitized portfolio version.** The original was built for an internal finance team. All identifying data — company name, account numbers, passwords, customer references — has been replaced with placeholders. See **Setup** below to deploy your own.

## What it does

- **Parses two carriers' invoice CSVs** (UPS Billing Centre 250-column format and DHL MyBill format)
- **Pulls accounting data nightly from an ERP** (Business Central in the original; could be any system with a BigQuery view) via a published Google Sheet → Cloudflare Worker
- **Compares actual freight charges to a negotiated rate card** to flag carrier overcharges. Supports UPS (XML SpreadsheetML format) and DHL (XLSX with a 3-step country → zone → letter lookup)
- **Surfaces AP KPIs** — amounts due and amounts overdue from the vendor ledger, with drill-down tables
- **Computes shipping margin per sales order** by matching carrier invoices to customer revenue, and flags unbilled shipments (shipped but never invoiced)
- **Exports the dashboard to a multi-sheet Excel workbook**

## Architecture

```
                  ┌─ UPS / DHL invoice CSVs ──┐
                  │  (manual upload)           │
                  ▼                            ▼
   BigQuery ── Connected Google Sheet (published as CSV)
       │              │
       │              ▼
       └────► Cloudflare Worker ──────► KV storage
                      │                      │
                      ▼                      ▼
                  /api/* routes        Browser dashboard (HTML)
                                              │
                                              ▼
                                         Finance team
```

The Worker handles `/api/sync-bq` and `/api/sync-vle` on a nightly cron (`0 6 * * *` UTC), pulling fresh ERP data into KV. The dashboard is a static HTML page served by the same Worker.

## What this demonstrates

- **Serverless backend design** — Cloudflare Workers + KV, no managed servers
- **Scheduled background jobs** — cron triggers running data sync
- **Multi-source data integration** — invoice CSVs, ERP via BigQuery, rate cards across two formats
- **Browser-side document parsing** — UPS rate cards (XML SpreadsheetML 2003) and DHL rate cards (XLSX via SheetJS); ~250-column CSV parsing for two distinct schemas
- **Lookup table design** — DHL's 3-step country → international zone → letter zone → KG-row rate lookup with non-document/document variants
- **Single-page interactive dashboard** in vanilla JavaScript, with 11 tabs, drill-down, CSV exports, and a multi-sheet Excel export via SheetJS
- **Static asset binding + worker routing** — same Cloudflare Worker serves the dashboard and the JSON APIs
- **Authentication with hashed shared secret** — SHA-256 team password, no plain text on the server
- **Anomaly detection** — variance thresholds with OR semantics (£5+ OR 20%+ off, either alone flags)

## Tech stack

- Cloudflare Workers (server-side JS, V8 runtime)
- Cloudflare KV (key-value storage)
- Vanilla HTML + JavaScript (no framework — by choice; the dashboard is one ~4,700-line self-contained HTML file)
- Chart.js (visualisations)
- SheetJS / xlsx.js (browser-side spreadsheet parsing and writing)
- ExcelJS (multi-sheet workbook export)
- Python (offline batch parsers for UPS/DHL CSVs, kept for validation and bulk reprocessing)

## Setup

```bash
# 1. Clone
git clone https://github.com/<you>/shipping-analyzer.git
cd shipping-analyzer

# 2. Install Wrangler (Cloudflare's CLI)
npm install -g wrangler

# 3. Sign in
wrangler login

# 4. Create a KV namespace
wrangler kv:namespace create CHARGES_KV
# Copy the printed namespace ID and paste it into wrangler.jsonc → kv_namespaces[0].id

# 5. Set up env vars in wrangler.jsonc:
#    - AUTH_HASH: SHA-256 hash of your team password
#      (compute at https://emn178.github.io/online-tools/sha256.html)
#    - BQ_SHEET_URL: published-as-CSV URL of a Google Sheet connected to your ERP's revenue view
#    - VLE_SHEET_URL: same for your vendor ledger view
#    (Both can be omitted initially; the worker will report "not configured" and skip the syncs)

# 6. Deploy
wrangler deploy
```

## Folder layout

```
.
├── README.md             ← you are here
├── ARCHITECTURE.md       ← system design, data model, key decisions
├── ROADMAP.md            ← what's done and what's next
├── wrangler.jsonc        ← Cloudflare Worker config (sanitized — fill in placeholders)
├── code/
│   ├── dashboard/        ← Shipping_Analyzer.html (the browser dashboard)
│   └── pipeline/         ← Python parsers (offline / bulk use)
├── src/
│   └── worker.js         ← Cloudflare Worker entrypoint
├── docs/
│   ├── glossary.md
│   ├── methodology.md
│   └── decisions/        ← Architecture Decision Records
└── .gitignore
```

## Status

Built end-to-end and deployed in production for a small finance team. Sanitized version published as a portfolio sample. Real invoice data is excluded.

## License

MIT — see LICENSE file. (Add a LICENSE file with MIT or your preferred license before publishing.)
