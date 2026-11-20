# Architecture

## System context

```mermaid
flowchart LR
    Web[Web client]
    Mobile[Mobile client]
    B2B[B2B partner]
    Operator[Operations team]

    subgraph System[Order processing system]
        Intake[Intake service]
        Orchestrator[Orchestrator service]
        Notifier[Notifier service]
        Observer[Observer service]
    end

    Pricing[Pricing provider]
    Payment[Payment provider]
    Inventory[Inventory provider]
    Shipping[Shipping provider]
    Notification[Notification provider]

    Web --> Intake
    Mobile --> Intake
    B2B -->|JSON or XML order| Intake
    Intake --> Orchestrator
    Orchestrator --> Pricing
    Orchestrator --> Payment
    Orchestrator --> Inventory
    Orchestrator --> Shipping
    Notifier --> Notification
    Operator --> Observer
    Observer --> Operator
```

## Integration architecture

```mermaid
flowchart LR
    Intake[Intake service]
    Orchestrator[Orchestrator]
    Notifier[Notifier]
    Observer[Observer]

    OrdersExchange[orders.exchange]
    SagaQueue[saga.queue]
    RetryExchange[orders.retry.exchange]
    RetryQueue[saga.retry.queue]
    ReturnExchange[orders.return.exchange]
    DLQExchange[orders.dlq.exchange]
    DLQ[orders.dlq]
    InvalidExchange[orders.invalid.exchange]
    InvalidQueue[orders.invalid]
    OutcomeExchange[orders.outcome]
    NotificationsQueue[notifications.queue]
    NotificationRetryQueue[notifications.retry.queue]
    TraceExchange[trace.events]
    TraceStore[trace.store]

    Intake --> OrdersExchange
    OrdersExchange --> SagaQueue
    SagaQueue --> Orchestrator

    Orchestrator -->|retry| RetryExchange
    RetryExchange --> RetryQueue
    RetryQueue --> ReturnExchange
    ReturnExchange --> SagaQueue

    Orchestrator -->|permanent failure| DLQExchange
    DLQExchange --> DLQ

    Intake -->|invalid message| InvalidExchange
    InvalidExchange --> InvalidQueue

    Orchestrator --> OutcomeExchange
    OutcomeExchange --> NotificationsQueue
    NotificationsQueue --> Notifier
    NotificationsQueue --> NotificationRetryQueue
    NotificationRetryQueue --> NotificationsQueue

    Intake --> TraceExchange
    Orchestrator --> TraceExchange
    Notifier --> TraceExchange
    TraceExchange --> TraceStore
    TraceStore --> Observer
```