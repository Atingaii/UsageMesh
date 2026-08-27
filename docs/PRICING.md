# Cost semantics

UsageMesh reports an **estimated API-equivalent USD cost** so totals on the hosted Dashboard can be compared directly with the same device-side unified ledger. It is an estimate, not a provider invoice and not a guarantee of subscription quota accounting.

## Source of truth

Token parsing, cache buckets and request boundaries are resolved on the device before encryption. The device-side pricing adapter uses the public `models.dev` catalog for general models and guarded GPT-5.6 rates where the project needs a stable audited card. The hosted Dashboard does **not** re-price aggregated rows in the browser; it displays the cost already calculated on the device.

For GPT-5.6 Sol the guarded base card per 1M tokens is: fresh input **$5.00**, cache read **$0.50**, cache write **$6.25**, output/reasoning output **$30.00**.

## Speed tier

`Standard`, `Fast` and `Priority` are usage metadata. They are useful for understanding subscription speed/quota behavior, but UsageMesh does **not** multiply the USD estimate by 2.5× simply because a request is Fast/Priority. A speed/quota multiplier is a different metric from API-equivalent monetary cost and must not be mixed into the dollar total.

## Long context and unknown prices

Long-context rules are applied from request-level evidence where supported. When a model, route or cache-write bucket cannot be priced confidently, UsageMesh marks the estimate as a lower bound instead of inventing a precise value.
