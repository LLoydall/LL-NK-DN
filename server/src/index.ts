import { createApp } from "./app.js";
import { config } from "./config.js";
import { log } from "./observability.js";
import { hasCredentials, resolvedModelNames } from "./rag/models.js";
import { MigrationService } from "./service.js";

async function main(): Promise<void> {
  const service = new MigrationService();

  const app = createApp(service);
  app.listen(config.PORT, () => {
    log("server_started", {
      port: config.PORT,
      ...resolvedModelNames(config),
      credentials: hasCredentials(config) ? "configured" : "missing (ingest/chat will 503)",
      qdrant: { url: config.QDRANT_URL, collection: config.QDRANT_COLLECTION },
      engineUrl: config.ENGINE_URL,
    });
  });
}

main().catch((error) => {
  log("fatal", { error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
