# Methodology

How we calculate, verify, and reason about the numbers.

## Where the data comes from

UPS Billing Centre exposes a 250-column "Billing Data File" CSV per invoice. Every charge line is a separate row:

- One row for the freight charge (FRT)
- One row for the fuel surcharge (FSC)
- One or more rows for accessorial charges (ACC)
- One row each for VAT (GOV/205, TAX/01), duty, brokerage etc.
- Plus informational rows (EXM = exempt, INF = info) which carry no actual charge

The file has no headers — column meaning is positional, defined by UPS's spec. Field positions are coded as constants in `code/pipeline/ups_pipeline.py`.

## Net vs Published

Each charge line has both:
- **Published** (column 52) — the public list price
- **Net** (column 53) — what we actually pay after corporate discount

We always sum **Net** for actual cost analysis. Published is shown alongside in the Charge Detail view so users can see the discount level — useful when negotiating contract renewals.

## How we verify totals

Each invoice CSV has the total amount in column 11 (`Invoice Total`). At parse time:

```
sum(Net for all charge lines in this invoice, excluding EXM and INF) ≈ Invoice Total
```

Tolerance is ±£0.05 per invoice (rounding, since UPS truncates per-line and we sum to two decimals). Anything more than that triggers a warning.

## How we handle the same tracking number on multiple invoices

A single parcel can be billed across two or three invoices:

1. **Original invoice** (week of shipment) — freight + fuel + per-package surcharges + VAT on services
2. **Customs catch-up invoice** (1-3 weeks later) — broker fees + duty + VAT on goods
3. **Adjustment invoice** (occasional) — weight corrections, address corrections, peak surcharge true-ups

The pipeline preserves both invoice-level and tracking-level views:

- **By Invoice** view sums charges within each invoice number (useful for "what hit the credit card on date X?")
- **Shipments** view sums charges across all invoices for a tracking number (useful for "what did this parcel cost end-to-end?")

The Shipments view's TOTAL row is the truer "what we spent on shipping" because it captures the full landed cost per parcel. The By Invoice TOTAL is the same number but grouped differently.

## Anomaly heuristics

Three flags in the dashboard:

1. **Service Issues > £100/month** — penalty fees (PIF, CGS) that often indicate disputable items or correctable behaviour.
2. **Per-shipment fuel > 50% of freight** — typical is 25–35%; >50% usually means a zone surcharge has been mis-coded as fuel.
3. **Same tracking on 3+ invoices** — normal is 1-2; 3+ may indicate a billing error.

These thresholds are tuned for our current volume. If we 10x volume the thresholds may need to scale.

## Currency

Everything in the dashboard is GBP. UPS UK accounts only bill in GBP. When we add DHL or other carriers, multi-currency support will need explicit FX handling.

## Date handling

We use **Invoice Date** (column 5) for time-bucketing — this is when UPS issued the invoice, not when the parcel shipped. Pickup Date (column 12) is when the parcel was actually collected, and we surface it in the Shipments view because it's often more meaningful operationally.

For "how much did we spend in March?", Invoice Date is correct.
For "how much did we spend on shipments collected in March?", you'd want to filter by Pickup Date (a future enhancement; currently the dashboard groups by Invoice Date only).

## Categorisation: why ACC is split into three

UPS's own coding has one bucket called Accessorial (ACC) covering everything from oversize handling to documentation surcharges to penalties. That's not actionable.

We split into:

- **Service Surcharges** — per-package costs driven by parcel attributes; you're paying for the service complexity
- **Documentation** — per-invoice paperwork; some items can be eliminated by going paperless
- **Service Issues** — penalties/anomalies; investigate and dispute

This makes "what's avoidable?" answerable. Going paperless saves the CIS surcharge (£18.30 per international export). PIF service issues should be challenged.

## What we do NOT do

- **No imputation of missing data.** If a charge line is malformed, we surface it raw rather than trying to guess.
- **No FX conversion** — see Currency above.
- **No tax-recoverability calculation** — we surface VAT as a separate bucket, but don't auto-apply reclaim assumptions; that's Finance's call per VAT period.
- **No predictions** (yet — see ROADMAP M7).
