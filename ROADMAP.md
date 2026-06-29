# Roadmap

Status legend: ✅ shipped · 🟡 partial · 🚧 in progress · ⏸ blocked · 🔜 next

---

## What's shipped

| ID | Description | Shipped |
|---|---|---|
| M1 | Robust UPS download (filter blindness fix) | 2026-04 |
| M2 | Compact upload UI redesign | 2026-04 |
| M3 | DHL MyBill CSV ingestion + parsing | 2026-05 |
| M4 | Excel exports with formatting + multiple tabs | 2026-05 |
| M5 | Hosted shareable dashboard (Cloudflare Worker + team password) | 2026-05 |
| M6 Phase 1 | BC CSV upload + revenue API + P&L by SO | 2026-05 |
| M6 Phase 1.5 | Dashboard redesign patches A/B/C (tabs, Unbilled, Internal) | 2026-05 |
| M6 Phase 2 | Editability for orphan carrier rows (corrections overlay) | 2026-05 |
| M6 Phase 3 | BigQuery automation via published Google Sheet + nightly cron | 2026-05 |
| M9 | Per-table CSV downloads | 2026-05 |
| M10 | Table column layout / fit on page | 2026-05 |
| M11 | Amount Due / Amount Overdue KPI cards (VLE sync) | 2026-06 |
| M11.2 | Status column on By Carrier Invoice + Overdue/Due Invoices drill-down tabs + clickable KPIs | 2026-06 |
| M12 | UPS rate card variance (Shipments + P&L + Dashboard anomaly) | 2026-05 |
| M12.2 | DHL rate card variance (3-step country/zone/letter lookup) | 2026-06 |
| M13 | Handover documentation (Confluence + technical HANDOVER.md) | 2026-06 |

---

## What's next

### M7 — Direct carrier integrations 🟢

**Goal:** stop manually downloading invoice CSVs from carrier portals. Have the Worker pull them on a schedule.

#### M7.1 — UPS automated ingestion via SFTP + UBD ⏸ blocked

UPS exposes invoices over SFTP (User Billing Data programme). We've requested credentials from UPS; awaiting them.

**When credentials arrive, the developer should:**

1. Store the SFTP credentials in Cloudflare Worker secrets (`wrangler secret put UPS_SFTP_HOST` etc — never commit them).
2. Add an SFTP client to the Worker (Cloudflare Workers don't have native FS, so we'll need to use an HTTP-bridge service or a Worker-compatible SFTP library — research point at implementation time).
3. Add a new sync function `syncFromUpsSftp(env)` modelled after `syncFromBq(env)` in `src/worker.js`.
4. Wire it into the scheduled handler so it runs nightly alongside the existing BC syncs.
5. Reuse the existing `ups_pipeline.py` parsing logic (port to JS, or expose Python in a separate runtime).

Acceptance criteria: a fresh UPS invoice posted to UPS SFTP at 11pm UK is visible on the dashboard the next morning, without anyone clicking anything.

Estimated effort: 1-2 days.

#### M7.2 — DHL direct integration 🟡 lower priority

DHL MyBill exposes a similar download mechanism. Lower priority because DHL volume is much smaller than UPS. Same shape of work.

---

### Future improvements (not committed)

- **Replace the Google Sheet middleman with direct BigQuery queries** from the Worker using a service account. Removes a fragile dependency (the Sheet can silently un-publish). ~1 day's dev work.
- **Custom domain** (e.g. `shipping.example-co.co.uk`) instead of the workers.dev subdomain. Cleaner branding. Free if NM uses Cloudflare DNS.
- **Cloudflare Access for SSO** — replace the shared team password with Microsoft 365 / Google Workspace SSO. Stronger security, individual access logs.
- **Anomaly email alerts** — when a carrier variance exceeds £100 on a single shipment, email AP automatically.
- **Multi-carrier expansion** — FedEx, EuroSender, etc. when they're onboarded.

---

## Open questions

- BC sometimes leaves the `external_document_no` field empty on Vendor Ledger Entries. This is what would give us a direct link from a carrier invoice to a BC vendor ledger entry. Currently the dashboard matches by amount + posting date proximity, which gets ~77% match rate. If BC starts populating `external_document_no`, match rate becomes 100% and the Status column gets more reliable.

---

## Decision log

Architecture Decision Records live in [`docs/decisions/`](docs/decisions/). Notable ones:

- **001** — Why Cloudflare Workers (vs alternative hosts)
- **003** — DHL charge code mapping
- **004** — VAT split (reclaimable UK VAT vs pass-through Import VAT)
- **005** — Corrections overlay for orphan carrier rows
