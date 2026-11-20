import express from "express";
import { startRabbit } from "./rabbit.js";

export async function startService(name, port, queues = []) {
  const rabbit = await startRabbit({
    url: process.env.RABBITMQ_URL,
    queues,
  });

  const app = express();
  app.use(express.json());

  app.get("/health", (_req, res) => {
    const result = rabbit.health();
    res.status(result.healthy ? 200 : 503).json(result.body);
  });

  const server = app.listen(port, "0.0.0.0", () => {
    console.log(`[${name}] Listening on port ${port}`);
  });

  async function shutdown() {
    console.log(`[${name}] Shutting down`);
    server.close();
    await rabbit.close();
    process.exit(0);
  }

  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
}
