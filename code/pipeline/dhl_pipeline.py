"""DHL MyBill CSV parser.

Reads a DHL MyBill invoice CSV (153-column format with header row) and unpivots
DHL's wide format (one row per shipment, with up to 9 extra charges as columns)
into the same long-format charge records as the UPS pipeline (one row per charge
line).

Output records are dicts with the same shape as `ups_pipeline.parse_file` returns,
plus a "Carrier" field set to "DHL". This means the workbook builder and the
HTML dashboard's data model can consume both carriers without modification.

Usage:
    python3 dhl_pipeline.py <invoice.csv>
    python3 dhl_pipeline.py /sessions/.../data/raw/dhl/LHRIR04103667.csv

Each DHL CSV is one invoice. The CSV has:
- One "I" line (invoice header summary) per file
- One "S" line per shipment in the invoice

Per "S" row we emit:
- 1 record for the Weight Charge (mapped to bucket "Freight")
- 0-9 records for the populated XC1-XC9 extra charges
- 1 record for VAT if Total Tax > 0
- 0-3 records for non-zero Discount 1/2/3 (negative)
"""
import csv
import os
import sys
from collections import defaultdict


# DHL extra-charge code → (bucket, friendly name).
# Add to this as new codes are observed in real invoices.
DHL_CHARGE_CODES = {
    "FF": ("Fuel Surcharge", "Fuel Surcharge"),
    "FD": ("Service Surcharges", "GoGreen Plus - Carbon Reduced"),
    "YK": ("Service Surcharges", "Premium 12:00"),
}


def categorize_dhl(code, name):
    """Map a DHL XC code to one of our buckets. Returns (bucket, friendly_name) or None to skip."""
    if not code or code == "0":
        return None
    if code in DHL_CHARGE_CODES:
        return DHL_CHARGE_CODES[code]
    # Unknown code — default to Service Surcharges with the carrier-provided name.
    # Worth logging so we can extend DHL_CHARGE_CODES.
    return ("Service Surcharges", name or f"DHL {code}")


def parse_dhl_date(s):
    """Convert YYYYMMDD to YYYY-MM-DD. Pass through anything else unchanged."""
    if not s or not s.isdigit() or len(s) != 8:
        return s
    return f"{s[:4]}-{s[4:6]}-{s[6:8]}"


def _to_float(v):
    """Parse a numeric string; treat empty / "0" / non-numeric as 0.0."""
    if v is None:
        return 0.0
    s = str(v).strip()
    if not s:
        return 0.0
    try:
        return float(s)
    except ValueError:
        return 0.0


def parse_file(path):
    """Parse one DHL invoice CSV. Returns list of long-format charge records."""
    records = []
    invoice_meta = {
        "invoice_number": "",
        "invoice_date": "",
        "account": "",
        "invoice_total": 0.0,
        "currency": "GBP",
    }
    src = os.path.basename(path)

    with open(path, encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for r in reader:
            line_type = (r.get("Line Type") or "").strip()

            # Capture invoice-level totals from the I row.
            # We use "Total amount (incl. VAT)" because our sum of Net charges
            # includes VAT (Total Tax field) for VAT-bearing UK domestic invoices.
            if line_type == "I":
                invoice_meta["invoice_number"] = r.get("Invoice Number", "")
                invoice_meta["invoice_date"] = parse_dhl_date(r.get("Invoice Date", ""))
                invoice_meta["account"] = r.get("Billing Account", "")
                invoice_meta["invoice_total"] = _to_float(r.get("Total amount (incl. VAT)"))
                invoice_meta["currency"] = r.get("Currency", "GBP")
                continue

            if line_type != "S":
                continue

            # ---- shipment row ----
            shipment_number = r.get("Shipment Number", "")
            shipment_date = parse_dhl_date(r.get("Shipment Date", ""))
            ref = r.get("Shipment Reference 1", "") or r.get("Shipment Reference 2", "")
            product_name = r.get("Product Name", "")
            currency = r.get("Currency") or invoice_meta["currency"]

            base = {
                "Carrier": "DHL",
                "Account": r.get("Billing Account") or invoice_meta["account"],
                "Invoice Date": invoice_meta["invoice_date"],
                "Invoice Number": invoice_meta["invoice_number"],
                "Invoice Total": invoice_meta["invoice_total"],
                "Pickup Date": shipment_date,
                "Tracking Number": shipment_number,
                "Sales Order Ref": ref,
                "Service Zone": r.get("Origin", ""),
                "Billable Wt": _to_float(r.get("Weight (kg)")),
                "Wt Unit": "K",
                "Actual Wt": _to_float(r.get("Weight (kg)")),
                "Pkg Type": product_name,
                "Currency": currency,
                "Origin Name": r.get("Senders Name", ""),
                "Origin City": r.get("Senders City") or r.get("Orig Name", ""),
                "Origin Postal": r.get("Senders Postcode", ""),
                "Origin Country": r.get("Orig Country Code", ""),
                "Dest Name": r.get("Receivers Name", ""),
                "Dest City": r.get("Receivers City") or r.get("Dest Name", ""),
                "Dest Postal": r.get("Receivers Postcode", ""),
                "Dest Country": r.get("Dest Country Code", ""),
                "Source File": src,
            }

            # 1. Freight charge (always present in DHL: the Weight Charge field)
            weight_charge = _to_float(r.get("Weight Charge"))
            if weight_charge != 0:
                records.append({
                    **base,
                    "Charge Cat": "FRT",
                    "Charge Code": "WT",
                    "Charge Desc": product_name or "Weight Charge",
                    "Bucket": "Freight",
                    "Friendly Name": product_name or "Weight Charge",
                    "Published": weight_charge,
                    "Net": weight_charge,
                })

            # 2. Extra charges XC1..XC9
            for i in range(1, 10):
                code = (r.get(f"XC{i} Code") or "").strip()
                name = (r.get(f"XC{i} Name") or "").strip()
                charge = _to_float(r.get(f"XC{i} Charge"))
                if not code or code == "0" or charge == 0:
                    continue
                bf = categorize_dhl(code, name)
                if bf is None:
                    continue
                bucket, friendly = bf
                records.append({
                    **base,
                    "Charge Cat": "XC",
                    "Charge Code": code,
                    "Charge Desc": name,
                    "Bucket": bucket,
                    "Friendly Name": friendly,
                    "Published": charge,
                    "Net": charge,
                })

            # 3. VAT (Total Tax) — only if non-zero
            total_tax = _to_float(r.get("Total Tax"))
            if total_tax > 0:
                records.append({
                    **base,
                    "Charge Cat": "TAX",
                    "Charge Code": r.get("Tax Code") or "VAT",
                    "Charge Desc": "VAT",
                    "Bucket": "VAT",
                    "Friendly Name": "VAT",
                    "Published": total_tax,
                    "Net": total_tax,
                })

            # 4. Discounts 1/2/3 — recorded as negative values in Adjustment bucket
            for i in range(1, 4):
                amt = _to_float(r.get(f"Discount {i} Amount"))
                if amt == 0:
                    continue
                code = r.get(f"Discount {i}") or f"D{i}"
                records.append({
                    **base,
                    "Charge Cat": "DSC",
                    "Charge Code": str(code),
                    "Charge Desc": f"Discount {i}",
                    "Bucket": "Adjustment",
                    "Friendly Name": f"Discount {i}",
                    "Published": -amt,
                    "Net": -amt,
                })

    return records


def main():
    if len(sys.argv) < 2:
        print("Usage: dhl_pipeline.py <invoice.csv>")
        sys.exit(1)
    path = sys.argv[1]
    records = parse_file(path)
    print(f"Parsed {len(records)} charge records from {path}")
    if not records:
        return

    # Group by invoice — for one DHL CSV there's only one invoice, but be defensive.
    invoices = defaultdict(list)
    for r in records:
        invoices[r["Invoice Number"]].append(r)

    print()
    print("Per-invoice verification (sum of Net charges vs Invoice Total field):")
    for inv, recs in invoices.items():
        sum_net = sum(r["Net"] for r in recs)
        inv_total = recs[0]["Invoice Total"]
        diff = round(sum_net - inv_total, 2)
        flag = "OK" if abs(diff) < 0.05 else "MISMATCH"
        print(f"  {inv}: sum_net=£{sum_net:.2f}  invoice_total=£{inv_total:.2f}  diff=£{diff:.2f}  [{flag}]")

    print()
    print("Bucket breakdown:")
    buckets = defaultdict(float)
    for r in records:
        buckets[r["Bucket"]] += r["Net"]
    for b, v in sorted(buckets.items(), key=lambda x: -x[1]):
        print(f"  {b}: £{v:.2f}")

    print()
    print("Per-shipment summary:")
    by_ship = defaultdict(list)
    for r in records:
        by_ship[r["Tracking Number"]].append(r)
    for tk, recs in by_ship.items():
        net = sum(r["Net"] for r in recs)
        first = recs[0]
        route = f"{first['Origin Country']} -> {first['Dest Country']}"
        print(f"  {tk}  {first['Pickup Date']}  {route:8}  {first['Pkg Type'][:30]:30}  £{net:.2f}")


if __name__ == "__main__":
    main()
