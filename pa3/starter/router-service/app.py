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
    'subscription': 'orders.subscription',
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

    # Declare every queue we might publish to, idempotently.
    for queue_name in ROUTES.values():
        channel.queue_declare(queue=queue_name, durable=True)

    items = order.get('items', [])
    item_count = len(items)

    for item_index, item in enumerate(items):
        item_message = {
            "orderId": order_id,
            "correlationId": correlation_id,
            "itemIndex": item_index,
            "totalItems": item_count,
            "item": item,
        }

        item_type = item.get('type')
        routing_key = ROUTES.get(item_type)

        if routing_key is None:
            # Unknown item type: don't let it vanish silently. Log it and
            # route it to orders.physical as a defensible fallback (a
            # physical fulfillment path is the safest default — it still
            # produces a result the aggregator can count, rather than the
            # item disappearing and the order hanging until timeout).
            # See docs/adr-002.md for the reasoning.
            print(
                f"[Router] Unknown item type '{item_type}' for order "
                f"{order_id}, item {item_index} -- routing to orders.physical"
            )
            routing_key = 'orders.physical'

        channel.basic_publish(
            exchange='',
            routing_key=routing_key,
            body=json.dumps(item_message),
            properties=pika.BasicProperties(delivery_mode=2)  # Persistent
        )

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