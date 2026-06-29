# ADR 005 — Corrections overlay for orphan carrier charges

**Status:** Accepted. Implemented in `src/worker.js` (`/api/corrections` endpoint) and `code/dashboard/Shipping_Analyzer.html` (inline edit UI + apply on load).
**Date:** 2026-05-14.

## Context

Carrier (UPS / DHL) charges arrive with a free-text reference field that's often **not a Sales Order number**. We've seen `example-co`, `STOCK`, `ROSS AVER`, `JEM STOCK`, `(blank)`, etc. — about £1.8k of 2026 spend isn't attributable to any customer SO and shows up in the Internal Shipping tab.

Some of these *should* have a real SO ref but didn't get one entered at the carrier's end. Finance often knows after the fact which SO a charge belongs to. We need a way to fix these retroactively **without modifying the original carrier records** (those are auditable source data we re-ingest from CSV uploads).

## Decision

A **non-destructive corrections overlay**:

- New KV key `corrections_v1` storing a `{ chargeKey → { ref1, updatedAt, updatedBy } }` map.
- `chargeKey` = the existing stable `recordKey()` derived from `(carrier|invoiceNumber|tracking|chargeCat|chargeCode|chargeDesc|net)` — same key already used to dedupe records.
- New Worker endpoint `/api/corrections` (GET/POST/DELETE) with the same `X-Auth-Hash` auth as the other endpoints.
- Dashboard fetches the overlay on every page load and applies it BEFORE the P&L computation:
  - For each charge whose `recordKey` matches a key in `corrections`, override `c.ref1` with the corrected value
  - Store the original in `c._originalRef1` so audits can see what changed
  - Flag `c._corrected = true` so UI can show a "corrected" pill
- Internal Shipping tab gets an "Assign SO" button per row → opens inline input → POSTs to `/api/corrections` → re-renders. Charge migrates out of Internal into matched P&L automatically since the regex now matches.

## Why a separate overlay store, not mutating the source

- **Original carrier data stays clean** — we re-ingest from carrier CSVs / EDI on a regular cadence, and corrections should survive that without us having to track "which rows did we already fix?"
- **Audit trail** — corrections store has `updatedAt` and `updatedBy` (IP). Original `ref1` preserved in `_originalRef1` in the live record.
- **Revertable** — DELETE `/api/corrections` with `{ chargeKey }` body removes a single correction. Or DELETE with empty body clears all.

## Validation

- POST endpoint requires the new `ref1` to contain `SOxxxxx` regex match (enforced client-side; not server-side yet — server trusts the dashboard).
- ChargeKey collisions: in principle, two different carrier charges could produce the same recordKey if they have identical (carrier, invoice, tracking, cat, code, desc, net). Unlikely but possible. Acceptable risk for v1.

## Consequences

**Good.**
- Finance can clean up the Internal Shipping bucket over time, reclaiming that spend into proper P&L by SO.
- All users see corrections immediately (it's in shared KV).
- Original carrier data is untouched — re-ingest works safely.
- Same pattern extends to: correcting customer attribution, fixing typo'd SO refs in Unbilled Shipments, etc.

**Bad / accepted.**
- One extra fetch on page load (small).
- ChargeKey is brittle if we ever change the recordKey formula — corrections would orphan. Documented here so a future maintainer notices.
- No server-side validation of the new ref1 — client only.

## Future extensions

- Edit UI on **Unbilled Shipments** tab too — for SOs where the carrier ref typo'd
- "Revert correction" affordance — show a small ↺ on corrected rows that DELETEs the entry
- Audit log view — show all corrections + who/when
- Edit other fields (carrier, customer attribution) if needed
