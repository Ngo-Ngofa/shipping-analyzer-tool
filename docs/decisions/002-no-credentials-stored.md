# ADR 002 — Never store carrier credentials

**Status.** Accepted. Will not be revisited.
**Date.** 2026-05-04.

## Context

The weekly scheduled task that fetches new UPS invoices needs to authenticate against the UPS Billing Centre. The most automated path would be to store username/password and have the system log in unattended.

## Decision

We do NOT store UPS credentials anywhere — not in the repo, not in a vault under our control, not in 1Password under the project account. The user (Ross) types the password (or 1Password autofills on his behalf) every time UPS prompts.

## Why

- Storing carrier credentials in any system creates an attack surface where a single compromise gives an attacker access to the UPS portal, including the ability to redirect deliveries.
- The Claude assistant operating the browser will not type passwords by safety policy. Even if we wanted Claude to do it, Claude cannot.
- The realistic path to "true" automation is carrier-side: SFTP delivery of billing files (UPS) or email delivery of invoices (M6 in roadmap) — both eliminate the login entirely.

## Consequences

- Weekly run requires Chrome to be open with 1Password unlocked. If Ross is on holiday with the laptop closed, the run fails gracefully (it does not retry endlessly).
- MFA prompts (rare on Billing Centre but possible) require a human at keyboard.
- Future carriers (DHL etc.) follow the same rule.

## Alternatives considered

- **Store in Azure Key Vault.** Rejected: the issue isn't the storage mechanism, it's that whoever holds the credentials becomes a target.
- **Use UPS API credentials.** UPS's tracking API exists (developer.ups.com) but billing data is not exposed there for accounts our size. Not a viable substitute for portal login.
- **Manual upload only.** Rejected as too operationally expensive — we'd lose the weekly cadence.

## See also

- ROADMAP M6 (email delivery) — the path that legitimately removes the login.
