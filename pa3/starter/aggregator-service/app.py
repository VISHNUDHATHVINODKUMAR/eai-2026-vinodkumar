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


# TODO: pick a data structure for tracking in-flight orders. You need, per
# orderId, at least: the results received so far (keyed by itemIndex, so a
# redelivered duplicate does not get counted twice), the totalItems the
# order expects, and a last-activity timestamp (used by the timeout sweep
# below). A plain dict behind a lock is enough; there's no need for
# anything fancier at this scale.
#
# in_flight = {}  # orderId -> {...}
lock = threading.Lock()

# TODO: how long should an order sit with no new results before you give up
# and emit a partial? Too short and normal processing latency trips it;
# too long and "partial" stops meaning anything. Write down the number you
# pick and why in docs/adr-002.md -- this is one of its required decisions.
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


def aggregate_result(ch, method, properties, body):
    """
    Handle one message from orders.results:
    1. Parse it (fields: orderId, correlationId, itemIndex, totalItems,
       plus whatever the worker added -- status, trackingNumber /
       downloadUrl / confirmationCode, itemName, ...).
    2. TODO: record it against the right order, keyed by itemIndex so a
       redelivered duplicate is a no-op rather than a second entry.
    3. TODO: update that order's last-activity timestamp (for the sweep).
    4. TODO: if every expected item has now been recorded, build the
       "complete" message (see the shape in the module docstring) and
       call publish_completion(), then drop the order from your in-flight
       state. Do this within the lock for the state changes, but publish
       AFTER releasing it.
    5. Ack the message regardless (a bad/unparseable message should not
       jam the queue -- decide what "bad" means and log it, but don't
       let it block the good ones. Note that choice in your ADR if it's
       not obvious).
    """
    result = json.loads(body)
    order_id = result['orderId']

    # TODO: implement per the docstring above.
    _ = order_id  # placeholder so linting doesn't complain about the unused var

    ch.basic_ack(delivery_tag=method.delivery_tag)


def sweep_timeouts():
    """
    Runs forever in a background thread, started from main(). Every
    SWEEP_INTERVAL_SECONDS, look for orders that have gone quiet:

    TODO: for every in-flight order whose last-activity timestamp is more
    than IDLE_TIMEOUT_SECONDS in the past, build the "partial" message
    (status="partial", missingItemIndexes non-empty) and call
    publish_completion(), then drop the order from your in-flight state --
    same lock discipline as aggregate_result: mutate state under the lock,
    publish after releasing it.

    This is what turns "one worker never responds" from a hang into a
    completed-but-honest result.
    """
    while True:
        time.sleep(SWEEP_INTERVAL_SECONDS)
        # TODO: implement per the docstring above.


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

    print('[Aggregator] Waiting for results...')
    channel.start_consuming()


if __name__ == '__main__':
    main()
