import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { inspectBazarr } from './inspect.js';

const usage = `Bazarr Translate Requester — Generate → Review → Request → Cleanup

Usage:
  npm run run:generate   Load configuration and identify the generate operation
  npm run run:request    Load configuration and identify the request operation
  npm run bazarr:inspect Read indexed library/wanted metadata only
  npm start             Display this help

Translation workflows are not implemented yet. generate/request make no API requests and create no batch files.`;

export async function main(args = process.argv.slice(2), { configPath, inspect = inspectBazarr } = {}) {
  const [operation = 'help'] = args;
  if (['help', '--help', '-h'].includes(operation) && args.length <= 1) {
    console.log(usage);
    return 0;
  }
  if (!['generate', 'request', 'inspect'].includes(operation) || args.length !== 1) {
    // Do not echo arbitrary CLI input, which may contain secrets.
    createLogger().error('Unknown command or unexpected arguments. Use help, generate, request or inspect.');
    return 1;
  }
  try {
    const config = await loadConfig(configPath);
    const logger = createLogger(config.logging.level, config.bazarr.map((instance) => instance.apiKey));
    logger.info(`Operation: ${operation}; dryRun=${config.dryRun}.`);
    const enabled = config.bazarr.filter((instance) => instance.enabled);
    logger.info(`Enabled Bazarr instances (${enabled.length}): ${enabled.map((instance) => instance.name).join(', ') || 'none'}.`);
    if (operation === 'inspect') return (await inspect(config, { logger })).failed ? 1 : 0;
    logger.warn(`${operation} is not implemented yet. No network requests or request files are created or modified.`);
    return 0;
  } catch (error) {
    // loadConfig only produces sanitized, field-specific error messages.
    createLogger().error(error.message);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
