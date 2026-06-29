# Deployment Guide

This file walks you through deploying a fresh copy of this tool from scratch. Pair it with the README.

## Prerequisites

- A Cloudflare account (Free tier is fine)
- Node.js installed locally
- An ERP or accounting system with data accessible via BigQuery (or any source that can publish a CSV to a public URL)
- A Google account if you're using the BigQuery → Connected Sheet → published CSV pattern (the same one used in the original)

## Steps

### 1. Clone and install

```bash
git clone https://github.com/<you>/shipping-analyzer.git
cd shipping-analyzer
npm install -g wrangler
wrangler login
```

### 2. Create the KV namespace

```bash
wrangler kv:namespace create CHARGES_KV
```

Wrangler prints something like:

```
🌀 Creating namespace with title "shipping-analyzer-CHARGES_KV"
✨ Success!
Add the following to your configuration file in your kv_namespaces array:
{ binding = "CHARGES_KV", id = "abc123..." }
```

Copy the `id` value. Open `wrangler.jsonc` and replace the placeholder under `kv_namespaces` with that ID.

### 3. Generate your team password hash

Pick a team password (the shared secret that gates the dashboard). Compute its SHA-256 hash.

Browser: https://emn178.github.io/online-tools/sha256.html  
Terminal (Linux/Mac): `echo -n "yourpassword" | sha256sum`  
Terminal (Windows PowerShell): `Get-FileHash -Algorithm SHA256 -InputStream ([System.IO.MemoryStream]::new([byte[]][char[]]"yourpassword"))`

Paste the hash into `wrangler.jsonc` → `vars.AUTH_HASH`.

### 4. Set up the ERP data feed (optional, but required for AP KPIs)

The Worker expects two CSV URLs in `wrangler.jsonc`: `BQ_SHEET_URL` (sales revenue) and `VLE_SHEET_URL` (vendor ledger). The canonical way to provide them:

a. In your ERP, expose two views in BigQuery: one for revenue lines, one for vendor ledger entries.
b. Create a Google Sheet. In the Sheet: **Data → Data connectors → Connect to BigQuery**, pick each view, paste each as a separate tab.
c. **File → Share → Publish to web**. For each tab, "Publish" and copy the CSV URL.
d. Paste each URL into `wrangler.jsonc`.

If you don't want this feed at all, leave the placeholders. The Worker will skip those syncs gracefully and only the AP/Margin KPIs will be unpopulated.

### 5. Deploy

```bash
wrangler deploy
```

Wrangler prints the deployed URL (e.g. `https://shipping-analyzer.<your-account>.workers.dev`). Open it in a browser, log in with the team password, and you should see the dashboard.

### 6. (Optional) Custom domain

In Cloudflare → Workers & Pages → click your worker → **Triggers → Add Custom Domain**. Use any domain you control. Cloudflare will manage the DNS automatically.

## Schema expectations for the BigQuery feeds

**Sales revenue feed** (`BQ_SHEET_URL`) — columns expected:

```
document_no, line_no, order_no, posting_date, sell_to_customer_no, sell_to_customer_name,
type, no, description, quantity, unit_price, amount, line_discount_percent, currency_code
```

**Vendor ledger feed** (`VLE_SHEET_URL`) — columns expected:

```
vendor_no, vendor_name, document_no, external_document_no, document_type,
posting_date, due_date, document_date, original_amt_lcy, remaining_amt_lcy, amount_lcy,
open, currency_code, closed_at_date, description, payment_method_code
```

(Both follow Microsoft Business Central's standard schema. If your ERP differs, edit `bqRowToRevenue()` and `vleRowToRecord()` in `src/worker.js`.)

## Verifying a deploy

After deploying, the worker exposes:

```bash
# Health check (no auth needed)
curl https://your-worker.workers.dev/api/health

# Stored data (auth required — pass the SHA-256 hash of your password)
curl -H "X-Auth-Hash: <hash>" https://your-worker.workers.dev/api/sync-vle

# Force a sync
curl -X POST -H "X-Auth-Hash: <hash>" https://your-worker.workers.dev/api/sync-vle
```

## Common gotchas

- **`wrangler deploy` fails with "no such namespace"** — the `kv_namespaces[0].id` in `wrangler.jsonc` doesn't match a real namespace in your account. Re-run `wrangler kv:namespace list` and confirm the ID.
- **The dashboard loads but every KPI is "—"** — the sync hasn't run. Click **🔄 Refresh from BC** once.
- **The published Google Sheet URLs work in a browser but the Worker reports "Fetch 401"** — Google's "Publish to web" needs to be active for each tab. Check **File → Share → Publish to web** in the Sheet.
