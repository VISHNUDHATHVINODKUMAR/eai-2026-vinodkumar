"""
Aggregator Service
==================
Your job: implement the AGGREGATOR pattern on top of the connection
handling and consume loop already wired up below.

- Collect item results from orders.results, grouped by orderId.
- Completion condition: every item of the order has reported a result.
- Timeout: if the order has been sitting incomplete for too long (one
  worker crashed, or was never running), emit a PARTIAL result instead of
  waiting forever. A hung order is a worse outcome than an honest partial
  answer.
- Duplicate results (the same item redelivered, e.g. after a requeue) must
  not be double-counted.
- Two orders in flight at once must never have their results mixed up.

Consumes from: orders.results
Publishes to:  orders.complete

Required shape of the message you publish to orders.complete (tests depend
on every one of these fields):

    {
        "orderId": "<the order this result set belongs to>",
        "correlationId": "<same value as orderId>",
        "status": "complete" | "partial",
        "totalItems": <the totalItems every item message carried>,
        "receivedItems": <how many distinct items you actually collected>,
        "itemResults": [ <the result messages you received, in any order> ],
        "missingItemIndexes": [ <itemIndex values you never received>
                                 -- empty list when status == "complete" ]
    }

Publish exactly ONE message to orders.complete per order, whichever status
it ends up with.
"""

import json
import pika
import os
import threading
import time


# orderId -> {
#   "totalItems": int,
#   "items": {itemIndex: result_dict},   # keyed by itemIndex so a
#                                         # redelivered duplicate overwrites
#                                         # rather than duplicates
#   "correlationId": str,
#   "lastActivity": float,               # time.monotonic() timestamp
# }
in_flight = {}
lock = threading.Lock()

# orderIds that have already been published (complete OR partial). Guarded
# by `lock`. Guarantees exactly one message per order: a late duplicate or
# straggler result for a finished order is ignored instead of recreating it.
# Grows without bound -- fine at assignment scale (see docs/adr-002.md).
completed = set()

# How long an order sits with no new results before we give up and emit a
# partial. See docs/adr-002.md for the reasoning behind this value.
IDLE_TIMEOUT_SECONDS = float(os.environ.get('AGGREGATOR_IDLE_TIMEOUT_SECONDS', '5'))

# How often the background sweep checks for timed-out orders. Independent
# of IDLE_TIMEOUT_SECONDS; this just controls how promptly a timeout is
# noticed once it has actually elapsed.
SWEEP_INTERVAL_SECONDS = 1.0


def get_rabbitmq_connection():
    """Create a connection to RabbitMQ using environment variable for host."""
    return pika.BlockingConnection(
        pika.ConnectionParameters(host=os.environ.get('RABBITMQ_HOST', 'localhost'))
    )


def publish_completion(message):
    """Publish a single message to orders.complete. Called with the lock
    already released -- do not hold `lock` while doing network I/O."""
    connection = get_rabbitmq_connection()
    channel = connection.channel()
    channel.queue_declare(queue='orders.complete', durable=True)
    channel.basic_publish(
        exchange='',
        routing_key='orders.complete',
        body=json.dumps(message),
        properties=pika.BasicProperties(delivery_mode=2)  # Persistent
    )
    connection.close()


def _build_completion_message(order_id, order_state, status):
    """Build the orders.complete payload from an order's collected state."""
    total_items = order_state['totalItems']
    received_indexes = set(order_state['items'].keys())
    missing_indexes = sorted(
        i for i in range(total_items) if i not in received_indexes
    )
    return {
        "orderId": order_id,
        "correlationId": order_state['correlationId'],
        "status": status,
        "totalItems": total_items,
        "receivedItems": len(order_state['items']),
        "itemResults": list(order_state['items'].values()),
        "missingItemIndexes": missing_indexes,
    }


def aggregate_result(ch, method, properties, body):
    """
    Handle one message from orders.results:
    1. Parse it (fields: orderId, correlationId, itemIndex, totalItems,
       plus whatever the worker added -- status, trackingNumber /
       downloadUrl / confirmationCode, itemName, ...).
    2. Record it against the right order, keyed by itemIndex so a
       redelivered duplicate is a no-op rather than a second entry.
    3. Update that order's last-activity timestamp (for the sweep).
    4. If every expected item has now been recorded, build the
       "complete" message and publish it, then drop the order from
       in-flight state.
    5. Ack regardless -- a bad/unparseable message should not jam the
       queue.
    """
    try:
        result = json.loads(body)
        order_id = result['orderId']
        item_index = result['itemIndex']
        total_items = result['totalItems']
        correlation_id = result.get('correlationId', order_id)
    except (json.JSONDecodeError, KeyError) as e:
        print(f'[Aggregator] Dropping unparseable/malformed message: {e}', flush=True)
        ch.basic_ack(delivery_tag=method.delivery_tag)
        return

    completion_message = None

    with lock:
        # Order already published (complete or partial): ignore late
        # duplicates/stragglers so we never emit a second message.
        if order_id in completed:
            print(f'[Aggregator] Ignoring late result for finished order {order_id}', flush=True)
            ch.basic_ack(delivery_tag=method.delivery_tag)
            return

        if order_id not in in_flight:
            in_flight[order_id] = {
                'totalItems': total_items,
                'items': {},
                'correlationId': correlation_id,
                'lastActivity': time.monotonic(),
            }

        order_state = in_flight[order_id]
        # Keyed by itemIndex: a redelivered duplicate just overwrites the
        # same slot instead of inflating the count.
        order_state['items'][item_index] = result
        order_state['lastActivity'] = time.monotonic()

        if len(order_state['items']) >= order_state['totalItems']:
            completion_message = _build_completion_message(
                order_id, order_state, status='complete'
            )
            del in_flight[order_id]
            completed.add(order_id)

    # Publish outside the lock -- never hold it during network I/O.
    if completion_message is not None:
        publish_completion(completion_message)

    ch.basic_ack(delivery_tag=method.delivery_tag)


def sweep_timeouts():
    """
    Runs forever in a background thread, started from main(). Every
    SWEEP_INTERVAL_SECONDS, look for orders that have gone quiet: any
    in-flight order whose last-activity timestamp is more than
    IDLE_TIMEOUT_SECONDS in the past gets a "partial" completion message
    and is dropped from in-flight state.
    """
    while True:
        time.sleep(SWEEP_INTERVAL_SECONDS)

        completions = []
        now = time.monotonic()

        with lock:
            timed_out_ids = [
                order_id
                for order_id, state in in_flight.items()
                if now - state['lastActivity'] > IDLE_TIMEOUT_SECONDS
            ]
            for order_id in timed_out_ids:
                order_state = in_flight.pop(order_id)
                completed.add(order_id)
                completions.append(
                    _build_completion_message(order_id, order_state, status='partial')
                )

        # Publish outside the lock.
        for message in completions:
            publish_completion(message)


def main():
    """Main entry point: connect to RabbitMQ, start the timeout sweeper,
    and start consuming results."""
    connection = get_rabbitmq_connection()
    channel = connection.channel()

    # Declare queues (idempotent)
    channel.queue_declare(queue='orders.results', durable=True)
    channel.queue_declare(queue='orders.complete', durable=True)

    # Fair dispatch
    channel.basic_qos(prefetch_count=1)

    # Background thread: sweeps for orders that timed out waiting on a
    # worker that never answered.
    sweeper = threading.Thread(target=sweep_timeouts, daemon=True)
    sweeper.start()

    # Start consuming
    channel.basic_consume(queue='orders.results', on_message_callback=aggregate_result)

    print('[Aggregator] Waiting for results...', flush=True)
    channel.start_consuming()


if __name__ == '__main__':
    main()