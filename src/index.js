import { startMcpServer } from "./mcp/server.js";
import { logger } from "./utils/logger.js";

startMcpServer().catch((error) => {
  logger.error("Failed to start MCP server", { message: error.message });
  process.exit(1);
});
