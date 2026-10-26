import { STATUS_CODES } from 'node:http';
import { SonarrClient } from 'tsarr/sonarr';
import { RadarrClient } from 'tsarr/radarr';
import { createBazarrClient, describeBazarrError } from './bazarr.js';

// Only controlled diagnostics leave this module, never SDK errors, URLs or bodies.
export function describeStatusError(error) {
  const status = error?.httpStatus;
  if (Number.isInteger(status) && status >= 100 && status <= 599) return `HTTP ${status} ${STATUS_CODES[status] ?? ''}`.trim();
  const code = error?.cause?.code ?? error?.code;
  if (['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)) return code;
  if (['AbortError', 'TimeoutError'].includes(error?.name)
    || (code === 'CONNECTION_ERROR' && /^Request timed out after \d+ms$/.test(error.message))) return 'TIMEOUT';
  if (error instanceof SyntaxError || code === 'INVALID_RESPONSE') return 'INVALID_RESPONSE';
  return 'connection, configuration or response error';
}

async function arrStatus(client) {
  const result = await client.getSystemStatus();
  if (result?.response && !result.response.ok) throw Object.assign(new Error('Service status HTTP error.'), { httpStatus: result.response.status });
  if (result?.error !== undefined) throw result.error;
  if (!result?.response?.ok || !result.data || typeof result.data !== 'object' || Array.isArray(result.data)
    || !['version', 'appName'].some((field) => typeof result.data[field] === 'string' && result.data[field].trim())) {
    throw Object.assign(new Error('Invalid service status response.'), { code: 'INVALID_RESPONSE' });
  }
  return result.data;
}

export async function inspectServices(config, {
  logger, bazarrFactory = createBazarrClient,
  sonarrFactory = (options) => new SonarrClient(options),
  radarrFactory = (options) => new RadarrClient(options),
} = {}) {
  let failed = false;
  const summaries = [];
  for (const instance of config.instances) {
    if (!instance.enabled) { logger.info(`[${instance.name}] Disabled. Skipping.`); continue; }
    const summary = { instance: instance.name };
    logger.info(`[${instance.name}] Inspecting services...`);
    for (const service of ['bazarr', 'sonarr', 'radarr']) {
      if (!instance[service]) continue;
      try {
        let status;
        if (service === 'bazarr') {
          status = await bazarrFactory({ ...instance.bazarr, name: instance.name }).getStatus();
        } else {
          const connection = instance[service];
          const factory = service === 'sonarr' ? sonarrFactory : radarrFactory;
          const client = factory({ baseUrl: connection.url.replace(/\/+$/, ''), apiKey: connection.apiKey });
          status = await arrStatus(client);
        }
        const version = service === 'bazarr' ? status.bazarr_version : status.version;
        // Versions are remote text; only print version-shaped values.
        const safeVersion = typeof version === 'string' && /^[0-9][0-9A-Za-z.+-]{0,63}$/.test(version) ? version : null;
        summary[service] = { connected: true, version: safeVersion };
        logger.info(`[${instance.name}] ${service}: Connected; version: ${safeVersion ?? 'unavailable'}.`);
      } catch (error) {
        failed = true;
        summary[service] = { connected: false };
        const detail = service === 'bazarr' ? describeBazarrError(error) : `GET /api/v3/system/status: ${describeStatusError(error)}`;
        logger.error(`[${instance.name}] ${service}: Failed (${detail}); continuing inspection.`);
      }
    }
    summaries.push(summary);
  }
  logger.info(failed ? 'Service inspection completed with failures.' : 'Service inspection completed.');
  return { failed, summaries };
}
