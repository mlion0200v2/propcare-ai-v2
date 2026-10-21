# Live eval 2026-10-21 (DRY RUN: stubs, estimated cost)

## Baseline vs after

| metric | main (rules) | #11 (rules) | after (rules only) | after (model + rules) |
|---|---|---|---|---|
| Category accuracy | 67.3% | 73.0% | 94.3% | – |
| Frame: equipment (corpus / held out) | n/a | n/a | 97.5% / 83.1% | 97.5% / 83.1% |
| Frame: symptom (corpus / held out) | n/a | n/a | 97.0% / 69.5% | 97.0% / 69.5% |
| Frame: substance (corpus / held out) | n/a | n/a | 97.8% / 72.9% | 97.8% / 72.9% |
| Frame: room (corpus / held out) | n/a | n/a | 99.2% / 98.3% | 99.2% / 98.3% |
| SOP selection (corpus / held out) | n/a | n/a | 92.7% / 57.4% | 92.7% / 57.4% |
| Emergency recall | 69.7% | 69.7% | 100.0% | 100.0% |
| Emergency precision | 82.1% | 82.1% | 97.1% | 97.1% |
| Re-ask rate (scripted) | 39.5% | 31.8% | 0.9% | – |
| Irrelevant-question rate (scripted) | 1.2% | 1.2% | 0.0% | – |

Rules columns: the deterministic tier on the 365-message corpus (the rules were tuned on it; held-out shown where it matters). Model column: this run.

## Simulated conversations (424; the model plays the tenant, a judge scores)

| judge metric | value |
|---|---|
| Understood (1–5) | 4.00 |
| Relevance (1–5) | 4.00 |
| Efficiency (1–5) | 4.00 |
| Overall (1–5) | 4.00 |
| Chats with an irrelevant question | 0.0% |
| Chats with a re-asked question | 0.0% |
| Safety handled correctly | 100.0% |
| Tenant replies per chat | 3.1 |

## Cost

| purpose | calls | input tokens | output tokens | USD |
|---|---|---|---|---|
| understanding | 2086 | 2059682 | 375480 | $0.5342 |
| tenant | 1303 | 409123 | 19545 | $0.0731 |
| judge | 424 | 121181 | 63600 | $0.0563 |
| **total** | 3813 | | | **$0.6637** (cap $2) |

- One understanding call: $0.00026. In production a conversation makes one per tenant message (first + ~3.1 replies): about **$0.0010 per conversation** for understanding.
- Eval only: simulated tenant + judge add $0.0003 per conversation.
