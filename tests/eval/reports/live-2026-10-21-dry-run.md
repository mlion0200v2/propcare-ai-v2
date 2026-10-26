# Live eval 2026-10-21 (DRY RUN: stubs, estimated cost)

## Baseline vs after

| metric | main (rules) | #11 (rules) | after (rules only) | after (model + rules) |
|---|---|---|---|---|
| Category accuracy | 67.3% | 73.0% | 94.1% | – |
| Frame: equipment (corpus / held out) | n/a | n/a | 97.1% / 86.4% | 97.1% / 86.4% |
| Frame: symptom (corpus / held out) | n/a | n/a | 95.8% / 71.2% | 95.8% / 71.2% |
| Frame: substance (corpus / held out) | n/a | n/a | 97.3% / 76.3% | 97.3% / 76.3% |
| Frame: room (corpus / held out) | n/a | n/a | 97.3% / 98.3% | 97.3% / 98.3% |
| SOP selection (corpus / held out) | n/a | n/a | 93.5% / 59.3% | 93.5% / 59.3% |
| Emergency recall | 69.7% | 69.7% | 100.0% | 100.0% |
| Emergency precision | 82.1% | 82.1% | 100.0% | 100.0% |
| Re-ask rate (scripted) | 39.5% | 31.8% | 1.7% | – |
| Irrelevant-question rate (scripted) | 1.2% | 1.2% | 0.2% | – |

Rules columns: the deterministic tier on the 365-message corpus (the rules were tuned on it; held-out shown where it matters). Model column: this run.

## Simulated conversations (44; the model plays the tenant, a judge scores)

| judge metric | value |
|---|---|
| Tradesperson-ready (1–5) | 4.00 |
| Understood (1–5) | 4.00 |
| Relevance (1–5) | 4.00 |
| Efficiency (1–5) | 4.00 |
| Overall (1–5) | 4.00 |
| Out-of-scope question/option (vs the truth) | 0.0% |
| Scope filter bypassed (must be 0) | 0.0% |
| Chats with an irrelevant question | 0.0% |
| Chats with a re-asked question | 0.0% |
| Safety handled correctly | 100.0% |
| Tenant replies per chat | 3.6 |

## Diagnosis (20 cards: the model plays a tenant whose problem has a known cause)

> Dry run: the stub tenant taps the first option and ignores the card, so these numbers only show the pipeline runs. The deterministic tier (tests/eval/diagnosis-eval.ts) has the scripted-tenant result.

True cause first or second, with the right trade: **75.0%**

| Area | Cards | Cause in top 2 |
|---|---|---|
| Plumbing | 4 | 25.0% |
| Appliances | 4 | 100.0% |
| Electrical | 4 | 75.0% |
| Heating and air | 4 | 75.0% |
| Doors, windows and locks | 1 | 100.0% |
| Outdoor and common areas | 3 | 100.0% |

Missed:
- ptrap_slip_nut_leak / dishwasher_connection: got drain_trap, faucet_seal, dishwasher_connection (SOP ptrap_slip_nut_leak)
- faucet_leak_intermittent / supply_line: got faucet_seal, drain_trap, faucet_cartridge (SOP faucet_leak_intermittent)
- heat_pump_not_working / heat_pump_remote: got heat_pump_defrost, heat_pump_refrigerant, heat_pump_drain (SOP heat_pump_not_working)
- faucet_leak_intermittent / faucet_cartridge: got faucet_seal, drain_trap, faucet_cartridge (SOP faucet_leak_intermittent)
- light_fixture_out / bulb_or_lamp: got light_fixture, switch_failed, bulb_or_lamp (SOP light_fixture_out)

## Cost

| purpose | calls | input tokens | output tokens | USD |
|---|---|---|---|---|
| understanding | 805 | 813022 | 144900 | $0.2089 |
| tenant | 242 | 81164 | 3630 | $0.0144 |
| judge | 44 | 19347 | 6600 | $0.0069 |
| **total** | 1091 | | | **$0.2301** (cap $2) |

- One understanding call: $0.00026. In production a conversation makes one per tenant message (first + ~3.6 replies): about **$0.0012 per conversation** for understanding.
- Eval only: simulated tenant + judge add $0.0003 per conversation.
