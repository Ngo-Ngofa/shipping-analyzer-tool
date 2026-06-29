# ADR 004 — Split VAT into "UK VAT" and "Import VAT"

**Status:** Accepted. Implemented in `code/dashboard/Shipping_Analyzer.html` and `code/pipeline/ups_pipeline.py`.
**Date:** 2026-05-13.

## Context

Originally we lumped all VAT-like charges into a single "VAT" bucket. Looking at the live data, that bucket actually contained three different things:

| Source | What it is | Approx £ (current dataset) |
|---|---|---|
| UPS GOV / 205 "Value Added Tax" | **Import VAT** — paid on the imported goods' customs value, passed through to the customer | £1,321 |
| UPS TAX / 01 "20.000 % Tax" | **UK VAT** on UPS's service fees | £377 |
| DHL TAX / A "VAT" | **UK VAT** on DHL's service fees (UK-domestic shipments only) | £15 |

The two flavours have different economic meaning:

- **UK VAT on service fees** — NM pays it to the carrier, reclaims it via the VAT return. It IS a real cash outflow even though it nets to zero on the VAT return. Including it in cost reflects the cash-flow picture finance cares about month to month.
- **Import VAT on imported goods** — the carrier pays customs on behalf of NM (acting as the importer of record for the goods) and passes it through on the invoice. NM in turn pays import VAT but reclaims it via C79 documentation. **It is NOT a cost of providing the shipping service.** Including it in "Total Cost" overstates what NM actually spent on shipping by exactly the import VAT amount.

This was flagged by Finance once it became visible on the dashboard.

## Decision

Two separate buckets:

- **"UK VAT"** — captures UPS `TAX/*` lines and DHL `Total Tax`. Included in cost calculations and margin math.
- **"Import VAT"** — captures UPS `GOV/205` lines. **Excluded from cost calculations.** Visible separately in the P&L detail panel as "Import VAT (pass-through, NOT in cost)" so the line is auditable, but doesn't affect the margin number.

## Consequences

**Good.**
- Margin numbers now reflect real economic cost rather than being inflated by customer-pass-through VAT.
- The two VAT flavours are visible and distinguishable in the dashboard, so when Finance audits the P&L they can see exactly what's been excluded and why.
- Aligns with how the rest of NM accounting (presumably) treats import VAT — as a recoverable disbursement, not a service cost.

**Bad / accepted.**
- Two-bucket model means a tiny bit more code complexity in `bucketGroup()` and `emptyCostRow()`.
- If UPS ever changes its coding scheme (e.g. starts coding service VAT as GOV/205 too), we'd misclassify until we update the rule. The ADR exists partly so a future maintainer notices when the categorize() logic needs an update.

## Alternatives considered

- **Keep one VAT bucket but expose two columns separately in tables only.** Rejected — the calculation logic still has to distinguish them, so might as well make them first-class buckets.
- **Exclude UK VAT too (pure economic view).** Rejected for now — finance asked for cash-flow view. We could add a toggle later if the economic view is also wanted.
- **Treat both as cost (the old behaviour).** Rejected — overstates shipping cost by ~£1.3k in current dataset; would only get worse as international shipments grow.

## Verification

- After deploy: hover any P&L SO row, expand, confirm Import VAT shows as separate greyed-out line, doesn't add to Total Cost.
- Spot-check: pick an international SO known to have customs duty + import VAT in UPS data; confirm dashboard Total Cost matches (Freight + Fuel + Surcharges + Brokerage + Duty + UK VAT) and NOT including the GOV/205 Import VAT line.
