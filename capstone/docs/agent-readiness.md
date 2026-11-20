# Agent readiness

## Tools

The current system does not include an autonomous AI agent. The following tools describe a restricted interface that could be provided to a future operations agent.

**Read-only tools**

1. **Get system health** — reads service health.
   Endpoint: `GET /health` on the intake, orchestrator, notifier, or observer service.
   Input: `{ "service": "intake" | "orchestrator" | "notifier" | "observer" }`

2. **Get saga status** — reads the status of one order saga.
   Endpoint: `GET /sagas/:correlationId` on the orchestrator.
   Input: `{ "correlationId": "string" }`

3. **Get stuck sagas** — lists sagas that need operator attention.
   Endpoint: `GET /sagas/stuck` on the orchestrator.
   Input: `{}`

4. **Get trace** — reads the recorded trace for an order.
   Endpoint: `GET /trace/:correlationId` on the observer.
   Input: `{ "correlationId": "string" }`

**Write tools**

5. **Request compensation** — asks the orchestrator to compensate a saga.
   Endpoint: `POST /sagas/:correlationId/compensate` on the orchestrator.
   Input: `{ "correlationId": "string", "reason": "string" }`

This write operation must require explicit human approval. The proposed tools are a design for a future agent, not tools currently connected to an AI agent.

## Injection paths

An agent reading system data could encounter attacker-controlled content in several places:

- Incoming order JSON or XML submitted to the intake service, including customer-provided fields such as names, addresses, and item descriptions.
- Message bodies and headers delivered through RabbitMQ, including correlation and causation metadata.
- Responses returned by pricing, payment, inventory, shipping, and notification provider services.
- Notification content consumed by the notifier.
- Trace events and error details stored for inspection by the observer.
- Messages placed in the invalid-message or dead-letter queues, including messages later inspected by an operator.

If future read tools return these values to an agent, the values must be treated as untrusted data, not as instructions. A customer-provided description or provider error message must never be allowed to change the agent's permissions or operating rules.

## Controls

The current application validates incoming data using schemas and processes messages through defined service workflows. XML and JSON inputs are parsed as data; they are not executed as instructions.

A future agent should have read-only access by default. The compensation tool must require a human confirmation before it can call the orchestrator. Any future dead-letter inspection or replay operation must also remain operator-controlled.

The existing system provides several useful safeguards:

- Correlation IDs and causation IDs support tracing a request across services.
- Trace events are published to RabbitMQ and stored for inspection by the observer.
- Idempotency and business-key deduplication reduce duplicate processing.
- Retry queues and dead-letter handling separate failed messages for investigation.
- Stuck sagas are exposed for operator attention rather than automatically compensated without review.

Agent actions should be recorded with the actor, time, correlation ID, requested operation, approval result, and outcome. This is a requirement for a future agent integration; it is not a claim that a separate agent audit log already exists.

## Not exposed

An agent must not receive unrestricted shell access, PowerShell access, Docker administration, filesystem access, or direct access to environment secrets.

It must not be allowed to execute arbitrary SQL or commands, change service configuration, publish arbitrary RabbitMQ messages, delete dead-letter messages, or replay messages without operator approval.

It must not be allowed to call payment, inventory, shipping, or other provider endpoints directly outside the orchestrator's defined workflow. These restrictions reduce the risk of unauthorized financial actions, data loss, duplicate orders, and uncontrolled compensation.

There is currently no AI agent connected to the running services and no autonomous agent permission to perform these operations.