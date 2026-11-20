# Failure analysis

Each scenario below records the trigger, observed system behaviour, final order state, mock side effects, alerts, and operator action. Trace excerpts and final states must be copied from actual test runs; placeholders are intentionally marked until verified.

## 1. Payment declined

**Trigger**

Configure the payment mock on port `4801` to decline authorization:

```json
{"authorize":{"failMode":"always","failStatus":402}}
```

Submit a web order.

**What the system does**

Record the actual trace from `GET /trace/:cid`. Verify whether the orchestrator retries the authorization and whether it compensates any earlier completed steps.

**Trace**

```text
[Paste the actual trace hops for this correlation ID]
```

**Final state**

- `GET /orders/:cid`: [paste actual response/state]
- Payment mock `/admin/effects`: [paste actual effects]
- Other mock effects: [record actual results]

**Alert**

[Record the alert that actually fires, or explain why no alert fires.]

**Operator action**

Inspect the order and trace. Confirm that no unintended payment or inventory side effect remains. Do not replay or compensate until the actual completed steps have been checked.

## 2. Inventory unavailable

**Trigger**

Configure the inventory mock on port `4802`:

```json
{"reserve":{"failMode":"always"}}
```

Submit a web order.

**What the system does**

Record the actual trace, including the inventory reservation failure and any retry or compensation steps.

**Trace**

```text
[Paste the actual trace hops for this correlation ID]
```

**Final state**

- `GET /orders/:cid`: [paste actual response/state]
- Inventory mock `/admin/effects`: [paste actual effects]
- Payment mock `/admin/effects`: [paste actual effects, if payment was attempted]

**Alert**

[Record the actual alert, or "none, by design" with the reason.]

**Operator action**

Inspect the trace and mock effects. If a payment was authorized before inventory failed, verify whether the refund completed before taking further action.

## 3. Shipping timeout

**Trigger**

Configure the shipping mock on port `4803`:

```json
{"create":{"delayMs":3500}}
```

Submit a web order. This delay is intended to exceed `REQUEST_TIMEOUT_MS`.

**What the system does**

Record the actual shipping timeout, retry behaviour, and any compensation steps shown in the trace.

**Trace**

```text
[Paste the actual trace hops for this correlation ID]
```

**Final state**

- `GET /orders/:cid`: [paste actual response/state]
- Shipping mock `/admin/effects`: [paste actual effects]
- Payment and inventory mock effects: [paste actual effects]

**Alert**

[Record the actual alert, or explain why no alert fires.]

**Operator action**

Inspect the trace and shipping mock effects before retrying. A timeout does not by itself prove that the remote shipping operation had no side effect.

## 4. A refund fails, then operator compensation

**Trigger**

Configure shipping and payment:

```json
{"create":{"failMode":"always"}}
```

on port `4803`, and:

```json
{"refund":{"failMode":"always"}}
```

on port `4801`. Submit a web order. Wait until the saga reaches `compensation_failed`. Then configure refunds to succeed:

```json
{"refund":{"failMode":"never"}}
```

Call:

```text
POST /sagas/:cid/compensate
```

Replace `:cid` with the actual correlation ID.

**What the system does**

Record the original failure and failed compensation. Then record the operator-triggered compensation attempt. Verify which compensations ran again and which were skipped because they had already succeeded.

**Trace**

```text
[Paste the actual trace hops, including the operator compensation attempt]
```

**Final state**

- `GET /orders/:cid`: [paste actual response/state]
- Payment mock `/admin/effects`: [paste actual effects]
- Inventory mock `/admin/effects`: [paste actual effects]
- Compensations repeated: [list actual operations]
- Compensations skipped: [list actual operations]

**Alert**

[Record the actual alert and why its predicate matched.]

**Operator action**

Fix the refund provider, inspect the completed compensation steps, then call `POST /sagas/:cid/compensate`. Verify the final state and provider effects.

## 5. A payment outage before step 1: retry, parked, replay

**Trigger**

Configure the payment mock on port `4801`:

```json
{"authorize":{"failMode":"always","failStatus":503}}
```

Submit a web order. Wait until the message is parked. Restore payment:

```json
{"authorize":{"failMode":"never"}}
```

Then call:

```text
POST /dlq/replay
```

**What the system does**

Record the initial authorization failure, retry attempts, parking in the dead-letter queue, and the replay result after payment is restored.

**Trace**

```text
[Paste the actual trace hops for this correlation ID]
```

**Final state**

- `GET /orders/:cid`: [paste actual response/state]
- Payment mock `/admin/effects`: [paste actual effects]
- DLQ before replay: [record actual message/count]
- DLQ after replay: [record actual message/count]

**Alert**

[Record the actual DLQ or consumer alert, or explain why none fires.]

**Operator action**

Inspect the parked message and its failure reason. Restore the provider, then use `POST /dlq/replay` and verify the resulting order state and payment effects.

## 6. A failure-notice delivery outage

**Trigger**

Cause an order to fail, for example by declining payment. Configure the notification mock on port `4804` to fail only failure notices:

```json
{"send":{"failMode":"always","failStatus":503,"failForKinds":["order_not_completed"]}}
```

Wait for the notifier's DLQ entry. Restore notification delivery and replay the parked message using the supported replay endpoint.

**What the system does**

Record the failed order, notification delivery retries, and the final parked message. Then record the replay after the notification provider is restored.

**Trace**

```text
[Paste the actual trace hops for the order]
```

**Final state**

- `GET /orders/:cid`: [paste actual response/state]
- Notification mock `/admin/effects`: [paste actual effects]
- Notifier DLQ entry before replay: [record actual result]
- Result after replay: [record actual result]

**Alert**

[Record the actual notifier/DLQ alert and why it fires.]

**Operator action**

Inspect the notification DLQ entry, restore the notification provider, and replay using the actual supported endpoint. Verify that the notice is delivered and not duplicated.

## 7. The orchestrator crashes mid-saga

**Trigger**

Configure shipping on port `4803`:

```json
{"create":{"delayMs":5000}}
```

Submit a web order. While shipping is in flight, kill the orchestrator:

```powershell
docker kill cap-orchestrator
```

Then restart it:

```powershell
docker start cap-orchestrator
```

**What the system does**

Record what happened to the in-flight request, the RabbitMQ delivery, and the persisted saga. Check whether the previous-run saga is marked `needs_attention`. Do not assume the saga automatically resumes.

**Trace**

```text
[Paste the actual trace hops before and after the restart]
```

**Final state**

- `GET /orders/:cid`: [paste actual response/state]
- `GET /sagas/stuck`: [paste actual response]
- Shipping mock `/admin/effects`: [paste actual effects]
- Payment and inventory mock effects: [paste actual effects]

**Alert**

[Record the actual alert. If the observer's stuck-saga alert is not wired to the orchestrator, state that explicitly.]

**Operator action**

Inspect `GET /sagas/stuck`, the trace, and provider effects. If appropriate, use `POST /sagas/:cid/compensate`. Do not assume a remote operation did not happen just because the orchestrator crashed before recording it.

## 8. A broker restart

**Trigger**

Restart RabbitMQ:

```powershell
docker restart cap-rabbitmq
```

Then submit a web order.

**What the system does**

Record how each service behaves during broker unavailability and after RabbitMQ returns. Distinguish health-check status, connection recovery, consumer recovery, and message processing. Do not claim automatic reconnection unless the run demonstrates it.

**Trace**

```text
[Paste the actual trace hops for this correlation ID]
```

**Final state**

- `GET /orders/:cid`: [paste actual response/state]
- RabbitMQ queues: [record actual state]
- Mock effects: [paste actual effects]
- Service health after restart: [record actual results]

**Alert**

[Record the actual alerts and which services or queues triggered them.]

**Operator action**

Check RabbitMQ and each service's health endpoint and logs. Verify consumers are active and inspect the order and mock effects before resubmitting.

## 9. A duplicate submission with a new Idempotency-Key

**Trigger**

Submit the same order twice, using two different `Idempotency-Key` values.

**What the system does**

Record whether intake treats the requests as separate submissions. Check the generated correlation IDs and business keys, and whether the orchestrator processes both orders.

**Trace**

```text
[Paste the actual trace hops for both correlation IDs]
```

**Final state**

- First `GET /orders/:cid`: [paste actual response/state]
- Second `GET /orders/:cid`: [paste actual response/state]
- Payment mock `/admin/effects`: [paste actual effects]
- Inventory mock `/admin/effects`: [paste actual effects]
- Other mock effects: [paste actual effects]

**Alert**

[Record the actual alert, or "none, by design" with the reason.]

**Operator action**

Compare both correlation IDs, business keys, and provider effects. Do not assume two different idempotency keys represent the same request to the idempotency layer.

## 10. A malformed message

**Trigger**

Publish `{ not json` to `orders.exchange` through the RabbitMQ management UI. Run the test once with a `correlationId` header and once without one.

**What the system does**

Record how the consumer handles invalid JSON in both cases. Check whether the message is routed to the invalid-message channel and whether trace information can be associated with it.

**Trace**

```text
[Paste the actual trace hops or state that no trace was recorded, with the reason]
```

**Final state**

- Invalid queue contents: [record actual result for both tests]
- Order status, if any: [record actual result]
- Mock effects: [record actual result; normally no business operation should be assumed]
- Behaviour with correlationId: [record actual result]
- Behaviour without correlationId: [record actual result]

**Alert**

[Record the actual invalid-message alert, or explain why none fires.]

**Operator action**

Inspect the invalid message and its headers. Correct the payload at the source and republish a valid message through the normal intake path. Do not blindly replay malformed JSON.
