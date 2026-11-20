# Patterns

<!--
The integration patterns in your system, and where they are (README §6, R-6.3).

What the stage 6 tests check: a table with the columns Pattern | Problem |
Where | Why, at least 8 rows, a Normalizer row among them, and every Where
link resolving to a file and a line that exist in your repository.

What is judged (GRADING.md §5, M4): every row must be true at its link. A row
that claims something your code does not do is a false row. One false row
costs M4's point; more than one also costs up to 3 more points of the manual
block. Eight true rows beat twelve rows with two wrong ones. At the defence I
pick a row and you show me the code behind it.

Where: link the line where the pattern happens, not the file's first line.
Either form works:

    [normalize.ts:42](../intake/src/normalize.ts#L42)    a link, resolved from docs/
    intake/src/normalize.ts:42                           a bare path, from capstone/

A pattern in two places can have two links. After you change the code,
check that the lines still point where you mean.

The course's patterns include: Normalizer, Message Translator, Content
Enricher, Content Filter, Canonical Data Model, Content-Based Router,
Idempotent Receiver, Guaranteed Delivery, Dead Letter Channel, Invalid
Message Channel, Retry with a delay queue, Correlation Identifier, Wire Tap,
Message Store, Process Manager / Saga, Compensating Transaction, Semantic
Lock, Competing Consumers. List only the ones your code really has.

Problem: what goes wrong without the pattern, in this system. Why: why this
pattern and not another. One sentence each is enough.
-->
# Patterns

| Pattern | Problem | Where | Why |
|---|---|---|---|
| Normalizer | Web, mobile, and B2B orders can represent product identifiers differently. | [pa4-transform.ts:233](../intake/src/pa4-transform.ts#L233) | Converts source-specific product identifiers into the format expected by the pricing service. |
| Message Translator | Incoming orders use different source-specific field names and structures. | [pa4-transform.ts:484](../intake/src/pa4-transform.ts#L484) | Transforms source-specific order data into the common order representation used by the application. |
| Idempotent Receiver | Clients may submit the same order request more than once. | [server.js:326](../intake/src/server.js#L326) | Uses the Idempotency-Key to detect repeated requests and avoid creating duplicate orders. |
| Correlation Identifier | Messages pass through multiple services, making it difficult to identify which order they belong to. | [server.js:276](../intake/src/server.js#L276) | Publishes the order with correlation and causation identifiers so processing can be traced across services. |
| Wire Tap | Operational investigation needs visibility into service processing without replacing the business message flow. | [server.js:78](../orchestrator/src/server.js#L78) | Publishes trace information through the trace mechanism for later inspection. |
| Process Manager / Saga | An order requires several service steps that must be coordinated. | [server.js:169](../orchestrator/src/server.js#L169) | Maintains saga state and coordinates the order workflow across service calls. |
| Compensating Transaction | A failure after a successful step can leave earlier business actions needing reversal. | [server.js:231](../orchestrator/src/server.js#L231) | Runs compensation actions for completed steps when the saga cannot complete. |
| Invalid Message Channel | Malformed or invalid messages should not continue through normal order processing. | [server.js:382](../orchestrator/src/server.js#L382) | Publishes invalid messages to the separate invalid-message exchange for inspection. |