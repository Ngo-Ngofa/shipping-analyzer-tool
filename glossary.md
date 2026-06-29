# Glossary — what each charge category means

Plain-English definitions intended for dashboard users (not developers). For the technical mapping see [`ARCHITECTURE.md`](../ARCHITECTURE.md#charge-categorisation-model).

## Freight (FRT)

The base shipping charge for a parcel. Driven by service level (WW Expedited, Dom. Standard, etc.), zone, weight and dimensions.

The **Net** figure is what you actually pay after the corporate discount. The **Published** figure is the list price. For our account, Net is typically 5-15% of Published — sounds dramatic but it's the standard "hide the real price" pattern.

## Fuel Surcharge (FSC)

A variable percentage added on top of freight to cover diesel/jet fuel costs. UPS resets weekly based on US diesel and Jet A indexes. Typically 25–35% of freight; sustained spikes correlate with crude oil moves. Tracking this month-over-month is a good sanity check that we're not being silently overcharged.

## Service Surcharges

Per-package add-ons that increase the shipping cost based on parcel characteristics or service options:

- **Surge Fee (PFC / PFR)** — peak / demand pricing during busy periods
- **Additional Handling (AHC / SAH)** — for oversize, heavy, or odd-shaped parcels
- **Remote Area / Extended Area (HIS / ESD / ESP / LDS)** — destination / origin in a hard-to-reach postcode
- **Residential (RES / REP)** — delivery to a residential address rather than commercial
- **Pickup options (OSW / OFW / ASW / AFW)** — same-day, future-day, alternate-address pickups
- **Returns Pickup Attempts (ART / RSO)** — UPS attempted to collect a return shipment

These are real shipping costs driven by the parcel and service choice. They're not paperwork.

## Documentation

Per-invoice paperwork and admin fees, mostly on international shipments:

- **Paper Commercial Invoice Surcharge (CIS)** — UPS charges for handling paper customs documents. **This can usually be eliminated by switching to paperless commercial invoice (electronic submission).**
- **Print Label (ALP)** — small fee for printing labels at UPS premises rather than your own
- **International Processing Fee (FIP)** — admin overhead for cross-border shipments
- **Duty & Tax Forwarding (F/D)** — fee for advancing duty/VAT on your behalf during customs clearance

## Service Issues

Penalties or unusual high-value charges that are worth investigating individually:

- **Prohibited Item Fee (PIF)** — applied when UPS believes a shipment contains a prohibited item (often a wrong content declaration). Worth disputing if you're sure the contents were correctly declared.
- **Customer Solution Service Fee (CGS)** — a billing adjustment / dispute resolution charge. If you see one of these, a service event has happened that's worth understanding.

The dashboard flags any month with > £100 in this bucket for review.

## Brokerage (BRK)

Customs clearance services on international shipments. Includes:

- Disbursement fees (for advancing duty/tax)
- Additional handling charges
- Entry preparation
- Document posting

UPS acts as your broker submitting goods to customs. Only applies to cross-border shipments.

## VAT (Value Added Tax)

Two flavours combined into one bucket:

- **GOV/205** — VAT charged by the broker on the value of the goods being imported. Often **reclaimable** for VAT-registered businesses (ACME Labs is — talk to Finance).
- **TAX/01** — 20% UK VAT on the UPS service fees themselves. Also reclaimable.

## Duty / Tax

Customs duty on imported goods. Calculated based on commodity code (HS code) and country of origin. **Unlike VAT, duty is NOT reclaimable** — it's a true cost-of-import you simply have to absorb.

## Adjustment

Post-invoice corrections — rebills, refunds, audit credits, supplemental fees applied after the original invoice. Usually small.

## Misc / Other

Anything that doesn't fit the above. If you see meaningful values here, investigate — it may indicate a new charge code UPS introduced that we haven't categorised yet. Update `categorize()` in both Python and JS.

---

## Counts: Unique Shipments vs Shipment Lines

The dashboard shows two related but different counts:

- **Unique Shipments (parcels)** — count of distinct tracking numbers. One physical parcel = 1.
- **Shipment Lines (billed events)** — count of tracking-invoice pairs. A parcel billed across two invoices counts as 2 (one for the original invoice, one for the customs catch-up).

When the two diverge, supplementary invoices were issued for the same parcels. That's normal UPS behaviour, not a billing error.

## Service Zone

UPS routing zone code on the invoice:

- **001** — same UK zone (domestic)
- **004-009** — international zones, increasing with distance
- **010+** — far-distance international (Asia-Pacific, South America)

Higher zone = farther destination = higher freight rate.

## Tracking Number

Every UPS parcel has a unique 1Z-prefixed tracking number. The same number can appear on more than one invoice if customs/VAT bills are issued separately from the original shipment bill.
