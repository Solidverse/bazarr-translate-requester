import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

try {
  const config = await loadConfig();
  const logger = createLogger(config.logging.level, config.bazarr.map((instance) => instance.apiKey));
  logger.info('Bazarr Translate Requester started.');
  const enabled = config.bazarr.filter((instance) => instance.enabled);
  logger.info(`Enabled Bazarr instances (${enabled.length}): ${enabled.map((instance) => instance.name).join(', ') || 'none'}.`);
  logger.info(`Running in scaffold mode; dryRun=${config.dryRun}. No Bazarr requests are made.`);
  logger.info('Execution completed.');
} catch (error) {
  createLogger().error(error.message);
  process.exitCode = 1;
}
