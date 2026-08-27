# Cost semantics

UsageMesh reports an **estimated API-equivalent USD cost**. It is an estimate, not a provider invoice and not a subscription-quota meter.

## Source of truth and precedence

Token parsing, cache buckets, request boundaries and route evidence are resolved on the device before encryption. Pricing precedence is:

1. **Official upstream model price cards** when UsageMesh has an audited rule for the model family.
2. `models.dev` as the general-model fallback.
3. A lower-bound marker (`≥`) when a bucket/model cannot be priced reliably.

The hosted Dashboard never re-prices aggregate rows in the browser; it displays the request/device-side cost already written into the encrypted ledger.

For GPT-5.6, UsageMesh follows the official OpenAI model documentation and effective dates. GPT-5.6 Sol Standard requests on/after **2026-08-21** use **$4.00 input / $0.40 cached input / $20.00 output per 1M tokens**. Cache writes are **1.25x uncached input**, therefore **$5.00/1M** at that Sol rate. Requests before that effective date keep the prior official **$5.00 / $0.50 / $30.00** card and **$6.25/1M** cache-write rate. Terra/Luna's 2026-07-30 repricing is handled the same way.

Official reference: https://developers.openai.com/api/docs/models/gpt-5.6-sol

## Speed tier

UsageMesh never guesses Fast from model name or performance. `Standard`, `Fast` and `Priority` come from local request evidence. A Standard request uses the Standard card. Explicit API `Fast`/`Priority` requests use the official Fast API price card; they are not given the old blanket 2.5x multiplier.

GPT-5.6 requests above 272K input tokens use OpenAI's documented long-context rule for the full request (2x input-side and 1.5x output-side pricing).

## Route / official-provider classification

`official` is not inferred merely because a parser says `provider=openai` or `provider=anthropic`. UsageMesh attempts to read the request/base endpoint locally. It parses the hostname and immediately reduces it to a non-sensitive route classification such as `official`, `openrouter`, `azure-openai`, `aws-bedrock`, `local`, or `custom-relay`.

**The raw base URL is never written into the UsageMesh ledger, pair code, index, or GitHub repository.** Only the normalized route label/type can leave the machine. Host matching is boundary-aware, so a lookalike domain such as `api.openai.com.evil.example` is not accepted as official.

If a client does not expose a usable endpoint locally, UsageMesh leaves the route unverified/unknown rather than falsely claiming it is official.

## Pricing-policy migration

A pricing-policy change invalidates historical stored `costUsd` values. On the first sync after an accounting-policy upgrade, UsageMesh automatically performs a full local rescan/reprice before publishing the encrypted ledger. This prevents old dates from retaining a previous price card.

## Client model aliases

Some coding clients expose internal model suffixes. Exact model IDs are attempted first; conservative lookup-only aliases are used only as fallback. For example, `deepseek-v4-flash-ioa` may fall back to `deepseek-v4-flash` when the exact ID is absent. Unknown models remain lower bounds rather than being guessed.
