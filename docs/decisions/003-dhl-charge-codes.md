# ADR 003 — DHL charge code mapping

**Status.** Accepted. Implemented in `code/pipeline/dhl_pipeline.py`.
**Date.** 2026-05-08.

## Context

DHL MyBill invoices use a different charge code taxonomy from UPS. Where UPS uses 3-letter category codes (FRT, FSC, ACC, BRK, GOV, TAX) plus 2-3 character sub-codes, DHL uses a flat 2-letter "extra charge" code per row (FF, FD, YK, …) and a separate "Weight Charge" field for the freight itself.

We need to map DHL's codes onto the same actionable buckets we use for UPS (Freight, Fuel Surcharge, Service Surcharges, Documentation, Service Issues, Brokerage, VAT, Duty/Tax, Adjustment) so a single dashboard and a single P&L view work across both carriers.

## Decision

Map DHL codes as follows. Anything not in the explicit table defaults to **Service Surcharges** with the carrier-provided name preserved.

| DHL field / code | Maps to bucket | Rationale |
|---|---|---|
| `Weight Charge` (no code, base freight) | **Freight** | The base shipping charge. Equivalent of UPS `FRT`. |
| `FF` "Fuel Surcharge" | **Fuel Surcharge** | Direct equivalent of UPS `FSC`. |
| `FD` "GOGREEN PLUS - CARBON REDUCED" | **Service Surcharges** | DHL's sustainability fee. Per-package add-on; user-chosen service option. |
| `YK` "PREMIUM 12:00" | **Service Surcharges** | Time-definite delivery surcharge. Like UPS's PFC (Surge Fee). |
| `Total Tax` (if > 0) | **VAT** | UK VAT on DHL services. Reclaimable for VAT-registered. |
| `Discount {n} Amount` | **Adjustment** (negative) | Account-level discounts applied at invoice or shipment level. |
| Anything else (unknown XC code) | **Service Surcharges** (fallback) | Default; review the DHL codes log periodically and promote to an explicit bucket. |

## Why these mappings

- **Weight Charge → Freight** — UPS-side parity. The user wants "what did the parcel cost to move?" answered consistently regardless of carrier.
- **FF → Fuel Surcharge** — same conceptual category as UPS FSC; tracked as % of freight.
- **FD GoGreen → Service Surcharges** — it's a chosen service option (sustainability), not paperwork or penalty. Treating it as a Service Surcharge surfaces it under "what optional services are we paying for?"
- **YK Premium 12:00 → Service Surcharges** — same logic; time-definite delivery is a service choice.
- **VAT** — separate bucket because it's reclaimable, unlike duty.
- **Discounts as negative Adjustments** — preserves bucket sums (e.g. Freight is gross, then Adjustment is the rebate). Matches how UPS adjustments are handled.

## What we DON'T have yet (and may need to add)

This ADR is based on a single sample invoice (`LHRIR04103667.csv`). When more invoices land we'll likely see codes that need explicit mapping. Watch for:

- Customs / brokerage charges on DHL imports (probably a separate "duty" code or "import processing" code) → likely **Brokerage** bucket
- Address correction fees → **Service Issues** if they apply (these are often disputable)
- Remote area / extended area surcharges → **Service Surcharges**
- Saturday delivery, Signature, Direct Signature → **Service Surcharges**

When new codes appear, the parser logs them as "Service Surcharges" by default. Review the dashboard's Top Surcharges tab for bucket = "Service Surcharges" + Code that isn't in `DHL_CHARGE_CODES` and promote them.

## Consequences

**Good.**
- Single dashboard works across UPS and DHL, with a Carrier filter.
- Bucket totals remain comparable across carriers — "what proportion of total spend is fuel?" is a meaningful question regardless of which carrier(s) you're looking at.
- Per-shipment reconciliation works the same way (sum of Net charges per Tracking Number = the invoice's per-shipment total).

**Bad / accepted.**
- Mapping is sample-driven, not authoritative. We'll need to refine as more invoices arrive.
- Some judgement is involved (is GoGreen a "Service Surcharge" or a separate "Sustainability" bucket?). For now we keep the bucket count low for clarity; can split later if Finance wants to track sustainability spend separately.

## Alternatives considered

- **Keep DHL's own taxonomy and show side-by-side rather than merge into shared buckets.** Rejected: defeats the purpose of multi-carrier analysis. The whole point is "what's the freight bill across carriers, what's the fuel bill across carriers, etc."
- **Auto-discover bucket from charge name string matching.** Rejected as fragile — DHL might rename "FUEL SURCHARGE" to "Energy Surcharge" tomorrow and our buckets break silently. Explicit code mapping is auditable.
