# Qamar Agency Agents Adaptation

This repository keeps Qamar as one business system. Agency Agents are treated as internal capability patterns, not as hundreds of separate customer-facing agents.

## Qamar internal capability map

- Orchestrator — routes each event to the smallest required capability.
- Sales Brain — discovery, objection handling, offer presentation and ethical persuasion.
- Customer Brain — support, customer-success and post-purchase care.
- Order Brain — validates order details, inventory and order creation.
- Delivery Brain — state-based assignment, acknowledgement monitoring, delivery status and escalation.
- Intelligence Brain — funnel, package, state, delivery and sales analysis.
- Growth Brain — paid-social, creative, campaign and conversion feedback loops.
- System Brain — workflow architecture, RAG, backend reliability and cost optimization.
- Reality Checker — verifies that workflows actually execute correctly before they are treated as production-ready.

## Company-specific order and delivery spine

Customer -> AI Sales Agent -> confirmed order -> inventory check -> unique order number -> state detection -> verified active delivery agent -> assignment -> acknowledgement -> delivery monitoring -> delivered/failed -> payment/receipt confirmation -> customer notification -> post-delivery follow-up.

### Required delivery states

CONFIRMED -> ASSIGNED -> RECEIVED -> OUT_FOR_DELIVERY -> DELIVERED

Failure path:

ASSIGNED -> FAILED (failure reason required)

Payment path:

DELIVERED -> PAYMENT CONFIRMATION -> RECEIPT RECEIVED

### 24-hour escalation rule

If a delivery assignment has not been acknowledged within 24 hours:

1. Follow up with the assigned delivery agent.
2. Record the follow-up event.
3. If still unresolved, create an owner alert.

The system must never invent a delivery company, agent, status, price, inventory level or payment state. Supabase remains the operational source of truth.

## Existing workflows preserved

- `Camera Hair AI Sales Agent` remains the customer-facing sales layer.
- `Camera Hair Daily Report` remains the reporting/intelligence layer.
- The existing Qamar order/delivery workflow remains the operational spine.
- `Inspect Supabase Schema` remains a development utility and should not be used as a production customer workflow until its schema-fetch issue is resolved.

## Cost/reliability principles

1. Prefer deterministic database rules over unnecessary LLM calls.
2. Use one orchestrated Qamar identity instead of spawning a separate agent for every task.
3. Keep prices and discounts database-authoritative.
4. Use verified delivery agents only.
5. Log material actions and escalations.
6. Test every automation path before activation.
