# Runbook

## dlq_not_empty

**Meaning:** One or more messages have exhausted their configured retry attempts and reached the dead-letter queue. The message may represent an order or notification that was not successfully processed.

**Likely causes:**
- A downstream mock or service is unavailable or repeatedly returning errors.
- A message contains data that causes processing to fail on every retry.

**Diagnose:**
1. Check `GET /ops/metrics` on the observer service (port 8801).
2. Inspect the dead-letter messages using `GET /dlq`.
3. Identify the original queue, retry history, correlation ID, and error details from the message headers and body.
4. Check the relevant service logs, for example `docker compose logs orchestrator` or `docker compose logs notifier`.
5. If the failure involves a mock provider, inspect its `/admin/logs` endpoint.

**Fix:**
- Restore an unavailable service or correct the underlying configuration.
- For invalid business data, investigate and correct the source data rather than repeatedly replaying the same message.
- Replay only after confirming the cause is fixed, the message is understood, and processing it again is safe. Check idempotency and possible duplicate side effects first.
- Never delete or replay the entire DLQ without inspecting its messages.

**Verify:** Check `/ops/metrics` and `/dlq` again. The DLQ count should return to zero after the affected messages have been safely handled. Confirm that the corresponding order or notification reached its expected outcome.

## invalid_not_empty

**Meaning:** One or more messages were rejected as invalid and sent to the separate invalid-message channel. These messages could not safely enter normal processing.

**Likely causes:**
- Required fields are missing or have invalid types or values.
- The incoming message does not match the expected order or notification structure.

**Diagnose:**
1. Check `GET /ops/metrics` on observer.
2. Inspect the invalid messages using the available invalid-message inspection endpoint or RabbitMQ management UI.
3. Examine the message body, validation error, source, and correlation ID.
4. Check `docker compose logs intake`, `docker compose logs orchestrator`, or `docker compose logs notifier`, depending on where the message was rejected.

**Fix:**
- Do not automatically replay invalid messages. They are separated from normal retries because the message itself needs investigation or correction.
- Identify the source of the invalid data and correct the producer, mapping, or input.
- If a corrected business request must be submitted, create a valid request through the normal intake path and retain the original message for investigation.

**Verify:** The invalid-message count should return to zero after the invalid messages have been reviewed and handled. Submit a corrected request and confirm that it follows the normal processing path.

## saga_consumer_missing

**Meaning:** The orchestrator is not consuming messages from `saga.queue`. New orders may wait without starting their saga.

**Likely causes:**
- The orchestrator container or its RabbitMQ connection has stopped.
- The consumer failed to start or lost its queue subscription.

**Diagnose:**
1. Run `docker compose ps` and check the orchestrator and RabbitMQ services.
2. Check `docker compose logs orchestrator`.
3. Check `docker compose logs rabbitmq`.
4. Open the RabbitMQ management UI and inspect `saga.queue`, including its consumer count and ready messages.
5. Check `GET /ops/metrics` on observer.

**Fix:**
- If the orchestrator container is stopped, investigate its logs and restart it with `docker compose restart orchestrator`.
- If RabbitMQ is unavailable, restore RabbitMQ first and then check whether the orchestrator reconnects.
- If the consumer does not return, inspect startup errors and connection settings before attempting another restart.

**Verify:** The orchestrator should be running, `saga.queue` should show an active consumer, and the missing-consumer alert should clear. Confirm that a test order starts processing.

## notifier_consumer_missing

**Meaning:** The notifier is not consuming messages from `notifications.queue`. Notifications may remain queued instead of being delivered.

**Likely causes:**
- The notifier container has stopped or crashed.
- The notifier cannot connect to RabbitMQ or failed to establish its consumer.

**Diagnose:**
1. Run `docker compose ps` and check notifier and RabbitMQ.
2. Check `docker compose logs notifier`.
3. Check `docker compose logs rabbitmq`.
4. Inspect `notifications.queue` in the RabbitMQ management UI and check its consumer count and ready messages.
5. Check `GET /ops/metrics` on observer.

**Fix:**
- Investigate the notifier logs and restore any missing dependency.
- If the notifier is stopped, restart it with `docker compose restart notifier`.
- If RabbitMQ is unavailable, restore RabbitMQ and verify the notifier connection.

**Verify:** `notifications.queue` should have an active consumer, the missing-consumer alert should clear, and pending notifications should drain. Confirm delivery using the notification mock logs.

## saga_consumer_lag

**Meaning:** The number of ready messages waiting in `saga.queue` has exceeded the configured alert threshold. Orders may take longer than expected to begin processing.

**Threshold rationale:** A threshold of 10 ready messages represents more than two batches at the configured `SAGA_CONCURRENCY=5`. This is a useful warning that the backlog is larger than the orchestrator's normal concurrent processing capacity, rather than treating a small temporary queue as an incident.

**Likely causes:**
- Order arrivals are exceeding the orchestrator's processing capacity.
- A downstream pricing, payment, inventory, or shipping service is slow or unavailable, keeping saga processing busy.

**Diagnose:**
1. Check `GET /ops/metrics` on observer and note the ready-message count.
2. Inspect `saga.queue` in the RabbitMQ management UI.
3. Check `docker compose logs orchestrator`.
4. Check the logs of the downstream mock services, such as `docker compose logs payment` or `docker compose logs inventory`.
5. Check `GET /sagas/stuck` on orchestrator for sagas that need operator attention.

**Fix:**
- Restore unavailable downstream services.
- Investigate repeated failures and retries before increasing processing capacity.
- Do not delete queued messages to make the metric look healthy.
- If the backlog is caused by a temporary burst, allow the active consumers to drain it while monitoring the queue.

**Verify:** The ready-message count should fall below the configured threshold and the alert should clear. Confirm that new orders are progressing through their saga steps.

## notifier_consumer_lag

**Meaning:** The number of ready messages waiting in `notifications.queue` has exceeded the configured alert threshold. Notification delivery is falling behind.

**Threshold rationale:** A threshold of 10 ready messages is an operational warning that notification work is accumulating rather than draining normally. It allows a short burst to be absorbed while identifying a sustained backlog that needs investigation.

**Likely causes:**
- The notifier is running but cannot process notifications quickly enough.
- The notification mock or another dependency is slow or repeatedly failing, causing retries and delayed delivery.

**Diagnose:**
1. Check `GET /ops/metrics` on observer.
2. Inspect `notifications.queue` and its consumer count in the RabbitMQ management UI.
3. Check `docker compose logs notifier`.
4. Check `docker compose logs notification`.
5. Inspect the notification mock's `/admin/logs` endpoint and the retry queue if failures are occurring.

**Fix:**
- Restore the notification service or correct its configuration.
- If the notifier is stopped, restore it and confirm that it resumes consuming.
- Allow retry handling to work; do not remove queued notifications just to clear the alert.
- Investigate repeated failures before attempting to replay dead-lettered messages.

**Verify:** The ready-message count should fall below the configured threshold. Confirm that the notifier is consuming messages and that successful notification records appear in the mock logs.

## stuck_sagas

**Meaning:** One or more sagas have entered `needs_attention` or `compensation_failed`. Automatic processing did not reach a successful final outcome.

**Likely causes:**
- A downstream service failed after one or more earlier saga steps had succeeded.
- A compensation action failed or the orchestrator stopped while a saga was processing.

**Diagnose:**
1. Call `GET /sagas/stuck` on orchestrator (port 8802).
2. Identify the affected correlation ID and inspect its saga state and completed steps.
3. Use `GET /trace/:correlationId` on observer to follow the processing history.
4. Check `docker compose logs orchestrator` and the relevant downstream service logs.
5. Inspect the relevant mock `/admin/logs` endpoint to determine which business actions succeeded or failed.

**Fix:**
- Before compensating, identify which steps completed successfully and which compensation actions are required.
- Confirm that the downstream services are available and that compensation will not create duplicate or harmful business effects.
- Use the operator compensation endpoint only after reviewing the saga state and trace: `POST /sagas/:correlationId/compensate`.
- If a compensation failed, investigate the specific failure and restore the required service before retrying the operator action.
- Do not assume that restarting the orchestrator automatically resumes or repairs every stuck saga.

**Verify:** Check the saga state again and inspect its trace. Confirm that compensation completed or that the order reached its expected final outcome. The stuck-saga alert should clear when no sagas remain in the alerting states.