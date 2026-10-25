import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';

const usage = `Bazarr Translate Requester — Generate → Review → Request → Cleanup

Usage:
  npm run run:generate   Load configuration and identify the generate operation
  npm run run:request    Load configuration and identify the request operation
  npm start             Display this help

Translation workflows are not implemented yet. No API requests or batch files are created.`;

export async function main(args = process.argv.slice(2), { configPath } = {}) {
  const [operation = 'help'] = args;
  if (['help', '--help', '-h'].includes(operation) && args.length <= 1) {
    console.log(usage);
    return 0;
  }
  if (!['generate', 'request'].includes(operation) || args.length !== 1) {
    // Do not echo arbitrary CLI input, which may contain secrets.
    createLogger().error('Unknown command or unexpected arguments. Use help, generate or request.');
    return 1;
  }
  try {
    const config = await loadConfig(configPath);
    const logger = createLogger(config.logging.level, config.bazarr.map((instance) => instance.apiKey));
    logger.info(`Operation: ${operation}; dryRun=${config.dryRun}.`);
    const enabled = config.bazarr.filter((instance) => instance.enabled);
    logger.info(`Enabled Bazarr instances (${enabled.length}): ${enabled.map((instance) => instance.name).join(', ') || 'none'}.`);
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
