/**
 * PA5 inventory-service — the stock-check consumer. Same pattern as
 * payment-service: connect, consume, retry/DLQ.
 */

import type { ConsumeMessage } from "amqplib";
import { connectWithRetry, getRetryCount } from "../../shared/rabbit";
import type { CanonicalOrder } from "../../shared/canonical-order";

const QUEUE = "inventory.queue";
const RESULTS_EXCHANGE = "results.inventory";
const DLQ_EXCHANGE = process.env.DLQ_EXCHANGE ?? "orders.dlq.exchange";
const INVALID_EXCHANGE = "orders.invalid.exchange";
// `?? "3"`, not `|| 3`: Number("0") is 0, and `0 || 3` is 3 — a configured
// retry count of zero would silently become the default.
const MAX_RETRIES = Number(process.env.MAX_RETRIES ?? "3");
// `?? "10"`, not `|| 10`: same reasoning — a configured fail rate of zero
// would silently become the default otherwise.
const FAIL_RATE = Number(process.env.INVENTORY_FAIL_RATE ?? "10");

async function main(): Promise<void> {
  const { channel } = await connectWithRetry(process.env.RABBITMQ_URL!);
  await channel.prefetch(1);

  await channel.assertExchange(DLQ_EXCHANGE, "fanout", { durable: true });
  await channel.assertQueue("orders.dlq", { durable: true });
  await channel.bindQueue("orders.dlq", DLQ_EXCHANGE, "");

  await channel.assertExchange(INVALID_EXCHANGE, "fanout", { durable: true });
  await channel.assertQueue("orders.invalid", { durable: true });
  await channel.bindQueue("orders.invalid", INVALID_EXCHANGE, "");

  console.log(`[Inventory] Consuming from ${QUEUE}, fail rate: ${FAIL_RATE}%`);

  await channel.consume(QUEUE, async (msg: ConsumeMessage | null) => {
    if (!msg) return;

    const correlationId = msg.properties.headers?.["correlationId"] as string | undefined;
    const retryCount = getRetryCount(msg);

    console.log(`[Inventory] Processing ${correlationId} (attempt ${retryCount + 1})`);

    try {
      const order = JSON.parse(msg.content.toString()) as CanonicalOrder;

      const roll = Math.random() * 100;
      if (roll < FAIL_RATE) {
        throw new Error("Simulated stock check failure");
      }

      channel.ack(msg);
      channel.publish(
        RESULTS_EXCHANGE,
        "",
        Buffer.from(
          JSON.stringify({
            correlationId,
            source: "inventory",
            status: "success",
            timestamp: new Date().toISOString(),
            details: { message: "Stock check passed" },
          }),
        ),
        {
          headers: { correlationId },
          contentType: "application/json",
          persistent: true,
        },
      );
      console.log(`[Inventory] Success for ${correlationId}`);
      return;
    } catch (err) {
      if (err instanceof SyntaxError) {
        channel.publish(INVALID_EXCHANGE, "", msg.content, {
          headers: msg.properties.headers,
          persistent: true,
        });
        channel.ack(msg);
        console.log(`[Inventory] -> Invalid message: ${(err as Error).message}`);
        return;
      }

      // Retry / DLQ logic — same pattern as payment-service.
      if (retryCount >= MAX_RETRIES - 1) {
        channel.publish(DLQ_EXCHANGE, "", msg.content, {
          // originQueue tells a later replay which queue to send it back to.
          headers: { ...msg.properties.headers, originQueue: QUEUE },
          persistent: true,
        });
        channel.ack(msg);
        console.log(`[Inventory] -> DLQ after ${retryCount + 1} attempts: ${(err as Error).message}`);
      } else {
        channel.nack(msg, false, false);
        console.log(`[Inventory] -> Retry (attempt ${retryCount + 1}): ${(err as Error).message}`);
      }
    }
  });
}

main().catch(console.error);