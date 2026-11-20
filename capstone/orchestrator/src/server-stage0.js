import { startService } from "../../shared/service.js";

startService("orchestrator", Number(process.env.PORT || 8802), ["saga.queue"]);
