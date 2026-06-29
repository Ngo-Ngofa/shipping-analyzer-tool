# ADR 001 — Sub-categorise UPS Accessorials into three buckets

**Status.** Accepted. Implemented in `categorize()` (Python and JS).
**Date.** 2026-05-04.

## Context

UPS uses a single `ACC` category for all "accessorial" charges. In practice this lumps together radically different cost types:

- **Service-level** — Surge Fee, Additional Handling, Remote Area, Residential
- **Documentation** — Paper Commercial Invoice, Print Label, International Processing
- **Penalty** — Prohibited Item Fee, Customer Solution Service Fee

Treating these as a single bucket made the dashboard's "what should we do about high accessorials?" question unanswerable — the answer depends entirely on which sub-type is driving the spend.

## Decision

Split `ACC` charges by sub-code into three buckets:

- **Service Surcharges** — default for ACC unless the sub-code matches one of the lists below. These are real shipping costs driven by parcel attributes; you accept them as the cost of using a fast/special service.
- **Documentation** — sub-codes `CIS`, `ALP`, `FIP`, `F/D`. Per-invoice paperwork. Some (especially CIS) can be eliminated by going paperless.
- **Service Issues** — sub-codes `PIF`, `CGS`. Penalties or unusual high-value lines worth disputing individually.

Implemented as constant sets `ACC_DOCUMENTATION` and `ACC_SERVICE_ISSUES` in `code/pipeline/ups_pipeline.py`. The JS dashboard mirrors with `ACC_DOCUMENTATION` / `ACC_SERVICE_ISSUES` constants.

## Consequences

**Good.**
- Dashboard "Service Issues > £100" alert is meaningful — those are dispute candidates.
- Going paperless saves a known number (£18.30 × N CIS surcharges), now visible.
- Conversation with UPS rep can target specific sub-categories rather than vague "your fees are too high."

**Bad / accepted.**
- Categorisation is now a UX-driven decision, not just a data-driven one. New ACC sub-codes default to "Service Surcharges" and may need re-classification later.
- The Python and JS implementations of `categorize()` have to be kept in sync manually. Roadmap item: factor out a shared schema once we add a backend.

## Alternatives considered

- **Stay with single ACC bucket and explain in glossary.** Rejected because the dashboard's job is to surface action, not require interpretation.
- **Five+ buckets.** Rejected as over-engineering for current data volume.
