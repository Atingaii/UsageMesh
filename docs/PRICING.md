# Cost semantics

UsageMesh reports an **estimated compatibility-card USD cost**. It is an estimate, not a provider invoice and not a subscription-quota meter.

## Source of truth and precedence

Token parsing, cache buckets, request boundaries and route evidence are resolved on the device before encryption. Pricing precedence is:

1. **Pinned compatibility cards** when UsageMesh has an audited rule for the model family.
2. `models.dev` as the general-model fallback.
3. A lower-bound marker (`≥`) when a bucket/model cannot be priced reliably.

The hosted Dashboard never re-prices aggregate rows in the browser; it displays the request/device-side cost already written into the encrypted ledger.

GPT-5.6 Sol is intentionally pinned to the widely used **undiscounted relay compatibility card**, independent of request date:

| Bucket | Standard, ≤272K input | Long context, >272K input |
| --- | ---: | ---: |
| Fresh input | $5.00 / 1M | $10.00 / 1M |
| Cached input | $0.50 / 1M | $1.00 / 1M |
| Cache write | $6.25 / 1M | $12.50 / 1M |
| Cache write (1h) | $6.25 / 1M | $12.50 / 1M |
| Output, including reasoning | $30.00 / 1M | $45.00 / 1M |

This card deliberately does not follow OpenAI's current promotional Sol rate. The official documentation remains the source for the structural rules: cache writes are 1.25x uncached input and requests above 272K input use 2x input-side plus 1.5x output-side pricing for the full request. Terra and Luna retain their date-aware official schedules.

Official reference: https://developers.openai.com/api/docs/models/gpt-5.6-sol

## Speed tier

UsageMesh never guesses Fast from model name or performance. `Standard`, `Fast` and `Priority` remain request metadata, but they do not change this compatibility-card USD estimate.

GPT-5.6 requests above 272K input tokens use OpenAI's documented long-context rule for the full request (2x input-side and 1.5x output-side pricing).

## Route / official-provider classification

Route and billing channel are separate dimensions. UsageMesh applies this local evidence precedence:

1. request/session endpoint;
2. provider `base_url`;
3. authenticated first-party ChatGPT transport (`auth_mode=chatgpt`, `requires_openai_auth=true`, Responses wire API, and no URL override);
4. raw provider label.

An official first-party URL becomes `official-api` or `official-subscription`. A ChatGPT-authenticated built-in transport with no custom URL is marked `official-subscription` even when its raw provider id is `custom` or `openai-http`. Any explicit third-party Base URL wins and remains a relay/cloud/aggregator route.

**The raw base URL is never written into the UsageMesh ledger, pair code, index, or GitHub repository.** Only the normalized route label/type can leave the machine. Host matching is boundary-aware, so a lookalike domain such as `api.openai.com.evil.example` is not accepted as official.

If a client exposes neither endpoint nor first-party authentication evidence, UsageMesh leaves the route unverified/unknown rather than falsely claiming it is official.

## Pricing-policy migration

A pricing-policy change invalidates historical stored `costUsd` values. On the first sync after an accounting-policy upgrade, UsageMesh automatically performs a full local rescan/reprice before publishing the encrypted ledger. This prevents old dates from retaining a previous price card.

## Client model aliases

Some coding clients expose internal model suffixes. Exact model IDs are attempted first; conservative lookup-only aliases are used only as fallback. For example, `deepseek-v4-flash-ioa` may fall back to `deepseek-v4-flash` when the exact ID is absent. Unknown models remain lower bounds rather than being guessed.
