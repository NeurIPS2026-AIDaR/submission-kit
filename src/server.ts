import { buildApi } from "./api.js";
import { loadConfig } from "./config.js";
import { AIDaRDatabase } from "./database.js";
import { LiveGithubGateway } from "./github/live.js";
import { MockGithubGateway } from "./github/mock.js";
import { AIDaRService } from "./service.js";

const config = loadConfig();
const database = new AIDaRDatabase(config.databasePath);
const github = config.githubMode === "live"
  ? new LiveGithubGateway(config.github!)
  : new MockGithubGateway(database);
const service = new AIDaRService(database, github, config);
const app = await buildApi(service, config);

const shutdown = async (): Promise<void> => {
  await app.close();
  database.close();
};
process.on("SIGINT", () => void shutdown().then(() => process.exit(0)));
process.on("SIGTERM", () => void shutdown().then(() => process.exit(0)));

await app.listen({ host: config.host, port: config.port });
process.stdout.write(`AIDaR API listening at http://${config.host}:${config.port} (${config.githubMode} GitHub mode)\n`);
