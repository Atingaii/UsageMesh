# Cost semantics

UsageMesh reports an **estimated usage cost / subscription-equivalent estimate** to make usage across models, devices and modes comparable.

It is not a provider invoice, not a guarantee of a subscription's internal quota accounting, and not a substitute for the billing console of the upstream service.

The CLI stores pricing metadata used at scan time and the dashboard can resolve known models against its pricing adapter. Model-specific policy belongs in code and tests, not in the onboarding README, so documentation does not become a stale rate card.

When a model or route cannot be resolved confidently, UsageMesh keeps the stored ledger estimate rather than inventing a price. Long-context and service-tier behavior should be applied from request-level evidence where available, not inferred from daily aggregate totals.
