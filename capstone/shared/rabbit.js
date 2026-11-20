import amqp from "amqplib";

export async function startRabbit({ url, queues = [] }) {
  let connection = null;
  let channel = null;
  let connected = false;
  let connecting = false;
  let reconnectTimer = null;
  let stopped = false;

  const consumerTags = Object.fromEntries(
    queues.map((queue) => [queue, null]),
  );

  function resetHealth() {
    connected = false;
    for (const queue of queues) {
      consumerTags[queue] = null;
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;

    resetHealth();

    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, 3000);
  }

  async function connect() {
    if (stopped || connecting) return;

    connecting = true;
    let retry = false;

    try {
      const newConnection = await amqp.connect(url);
      const newChannel = await newConnection.createChannel();

      connection = newConnection;
      channel = newChannel;

      newConnection.on("error", (error) => {
        console.error("[RabbitMQ] Connection error:", error.message);
      });

      newConnection.on("close", () => {
        console.warn("[RabbitMQ] Connection closed; reconnecting");
        scheduleReconnect();
      });

      newChannel.on("error", (error) => {
        console.error("[RabbitMQ] Channel error:", error.message);
      });

      newChannel.on("close", () => {
        console.warn("[RabbitMQ] Channel closed; reconnecting");
        scheduleReconnect();
      });

      for (const queue of queues) {
        const result = await newChannel.consume(
          queue,
          (message) => {
            if (message && channel === newChannel) {
              newChannel.ack(message);
            }
          },
          { noAck: false },
        );

        consumerTags[queue] = result.consumerTag;
      }

      connected = true;
      console.log(
        "[RabbitMQ] Connected; queues:",
        queues.join(", ") || "(none)",
      );
    } catch (error) {
      console.error("[RabbitMQ] Connection failed:", error.message);
      resetHealth();
      retry = true;

      try {
        await connection?.close();
      } catch {
        // Ignore errors while closing a failed connection.
      }

      connection = null;
      channel = null;
    } finally {
      connecting = false;
      if (retry) scheduleReconnect();
    }
  }

  await connect();

  return {
    health() {
      const consumers = Object.fromEntries(
        queues.map((queue) => [
          queue,
          consumerTags[queue] ? 1 : 0,
        ]),
      );

      const healthy =
        connected &&
        queues.every((queue) => consumers[queue] > 0);

      return {
        healthy,
        body: {
          status: healthy ? "ok" : "degraded",
          checks: {
            broker: connected ? "up" : "down",
            consumers,
          },
        },
      };
    },

    async close() {
      stopped = true;

      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }

      resetHealth();

      try {
        await connection?.close();
      } catch {
        // Ignore errors during shutdown.
      }

      connection = null;
      channel = null;
    },
  };
}
