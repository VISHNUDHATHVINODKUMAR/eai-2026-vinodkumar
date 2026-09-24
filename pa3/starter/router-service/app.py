"""
Router Service
==============
Your job: implement two EIP patterns on top of the connection handling and
consume loop already wired up below.

1. SPLITTER: Break a multi-item order into one message per line item.
2. CONTENT-BASED ROUTER: Route each item message to a queue chosen by
   item['type'] -- physical / digital / subscription.

Consumes from: orders.incoming
Publishes to:  orders.physical, orders.digital, orders.subscription

Required shape of each item message you publish (the aggregator and the
tests depend on every one of these fields being present):

    {
        "orderId": "<same orderId as the incoming order>",
        "correlationId": "<same value as orderId -- this is what lets the
                            aggregator group results from the same order>",
        "itemIndex": <0-based position of this item within order['items']>,
        "totalItems": <len(order['items'])>,
        "item": <the original item object, unchanged>
    }

Every item message for a given order MUST carry the same correlationId and
the same totalItems -- that is how correlation is preserved once the order
has been split into independent messages travelling independent paths.
"""

import json
import pika
import os


def get_rabbitmq_connection():
    """Create a connection to RabbitMQ using environment variable for host."""
    return pika.BlockingConnection(
        pika.ConnectionParameters(host=os.environ.get('RABBITMQ_HOST', 'localhost'))
    )


# Map an item's `type` field to the routing key (== queue name, since we
# publish to the default exchange) it should be sent to.
ROUTES = {
    'physical': 'orders.physical',
    'digital': 'orders.digital',
    # TODO: this assignment adds a third item type. What routing key should
    # 'subscription' items go to? Keep the naming convention consistent with
    # the other two.
}


def route_order(ch, method, properties, body):
    """
    Process an incoming order:
    1. Parse the order message.
    2. SPLITTER: break the order into one message per item (see the
       required shape in the module docstring above).
    3. CONTENT-BASED ROUTER: publish each item message to the queue that
       matches its type, using ROUTES above.
    4. Ack the original orders.incoming message once every item has been
       published -- not before, and not per-item.
    """
    order = json.loads(body)
    order_id = order['orderId']
    correlation_id = order['correlationId']

    print(f"[Router] Processing order {order_id}")

    connection = get_rabbitmq_connection()
    channel = connection.channel()

    # TODO: declare the output queues you publish to (idempotent -- safe to
    # call every time). You need at least orders.physical, orders.digital,
    # orders.subscription. (orders.results is declared by the workers that
    # publish to it; you do not need it here.)

    items = order.get('items', [])
    item_count = len(items)

    # TODO — SPLITTER + CONTENT-BASED ROUTER:
    # For each item in `items` (keep track of its index):
    #   1. Build the item message dict per the required shape above.
    #   2. Look up the routing key for item['type'] in ROUTES.
    #   3. Decide what happens for a type that is not in ROUTES -- do not
    #      let it silently vanish. Log it and pick a defensible fallback;
    #      say what you did and why in your ADR.
    #   4. channel.basic_publish(..., properties=pika.BasicProperties(delivery_mode=2))
    #      so the message survives a broker restart.

    connection.close()

    # Acknowledge the original message once every item has been routed.
    ch.basic_ack(delivery_tag=method.delivery_tag)

    print(f"[Router] Order {order_id} split into {item_count} items and routed")


def main():
    """Main entry point: connect to RabbitMQ and start consuming orders."""
    connection = get_rabbitmq_connection()
    channel = connection.channel()

    # Declare input queue (idempotent)
    channel.queue_declare(queue='orders.incoming', durable=True)

    # Fair dispatch: don't give more than one message to a worker at a time
    channel.basic_qos(prefetch_count=1)

    # Start consuming
    channel.basic_consume(queue='orders.incoming', on_message_callback=route_order)

    print('[Router] Waiting for orders...')
    channel.start_consuming()


if __name__ == '__main__':
    main()
