import { app } from "./app";
import { ENV } from "./config/env.config";
import { setupDatabase } from "./db/schema";
import { sql } from "./db/index";

await setupDatabase();

const server = app.listen(ENV.PORT, () => {
    console.log(`[SERVER] is listening at ${ENV.PORT}`);
});

const gracefulShutdown = async () => {
  server.close();
  await sql.end({ timeout: 5 });
};

process.on("SIGINT", gracefulShutdown);
process.on("SIGTERM", gracefulShutdown);