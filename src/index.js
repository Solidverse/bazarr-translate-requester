import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { inspectBazarr } from './inspect.js';
import { inspectServices } from './services.js';
import { generateRequests } from './generate.js';
import { parseGenerateArgs } from './generate-options.js';
import { processRequests } from './request.js';
import { parseRequestArgs } from './request-options.js';

const usage = `Bazarr Translate Requester — Generate → Review → Request → Cleanup

Usage:
  npm run run:generate -- [--type movie|series] [--instance NAME] [--series ID]
                          [--min-age DAYS] [--preview]
  npm run run:request -- [--max NUMBER]  Validate, submit and clean up a reviewed batch
  npm run bazarr:inspect Read indexed library/wanted metadata only
  npm run services:inspect Check configured Bazarr/Sonarr/Radarr status
  npm start             Display this help

generate reads indexed metadata and writes a review batch unless --preview is used.
request respects global dryRun; only confirmed HTTP 204 removes a batch entry.
Accepted means submitted to Bazarr, not a finished translation.`;

export async function main(args = process.argv.slice(2), { configPath, inspect = inspectBazarr, servicesInspect = inspectServices, generate = generateRequests, request = processRequests } = {}) {
  const [operation = 'help'] = args;
  if (['help', '--help', '-h'].includes(operation) && args.length <= 1) {
    console.log(usage);
    return 0;
  }
  if (!['generate', 'request', 'inspect', 'services'].includes(operation) || (!['generate', 'request'].includes(operation) && args.length !== 1)) {
    // Do not echo arbitrary CLI input, which may contain secrets.
    createLogger().error('Unknown command or unexpected arguments. Use help, generate, request, inspect or services.');
    return 1;
  }
  let logger = createLogger();
  let configured = false;
  try {
    const options = operation === 'generate' ? parseGenerateArgs(args.slice(1))
      : operation === 'request' ? parseRequestArgs(args.slice(1)) : null;
    const config = await loadConfig(configPath);
    logger = createLogger(config.logging.level, config.instances.flatMap((instance) => ['bazarr', 'sonarr', 'radarr'].map((service) => instance[service]?.apiKey)));
    configured = true;
    logger.info(`Operation: ${operation}; dryRun=${config.dryRun}.`);
    const enabled = config.instances.filter((instance) => instance.enabled);
    logger.info(`Enabled instances (${enabled.length}): ${enabled.map((instance) => instance.name).join(', ') || 'none'}.`);
    if (operation === 'generate') {
      await generate(config, options, { logger, configPath });
      return 0;
    }
    if (operation === 'request') {
      const controller = new AbortController();
      let exitSignal;
      const terminate = () => { exitSignal = 143; controller.abort(); };
      const interrupt = () => { exitSignal = 130; controller.abort(); };
      process.once('SIGTERM', terminate); process.once('SIGINT', interrupt);
      try {
        const result = await request(config, options, { logger, configPath, signal: controller.signal });
        return exitSignal ?? (result.hasProblems ? 1 : 0);
      } finally { process.removeListener('SIGTERM', terminate); process.removeListener('SIGINT', interrupt); }
    }
    if (operation === 'services') return (await servicesInspect(config, { logger })).failed ? 1 : 0;
    if (operation === 'inspect') return (await inspect(config, { logger })).failed ? 1 : 0;

  } catch (error) {
    // loadConfig only produces sanitized, field-specific error messages.
    logger.error(configured ? `Operation failed: ${error.message}` : error.message);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
