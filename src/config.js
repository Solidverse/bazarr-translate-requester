import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (field, message) => { throw new Error(`Invalid configuration: ${field} ${message}`); };

export async function loadConfig(path = '/config/config.yml') {
  let source;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    throw new Error(error.code === 'ENOENT'
      ? 'Configuration file not found at /config/config.yml. Supply an external config.yml.'
      : 'Configuration file could not be read. Check file permissions.');
  }
  let config;
  try {
    config = parse(source);
  } catch {
    // Parser errors can include source excerpts containing API keys.
    throw new Error('Invalid YAML syntax in configuration file.');
  }
  if (!object(config)) invalid('root', 'must be a YAML mapping.');
  if (!object(config.translation)) invalid('translation', 'must be a mapping.');
  for (const field of ['sourceLanguage', 'targetLanguage']) {
    if (!nonEmpty(config.translation[field])) invalid(`translation.${field}`, 'must be a non-empty string.');
  }
  if (!Array.isArray(config.bazarr)) invalid('bazarr', 'must be an array.');
  config.bazarr.forEach((instance, index) => {
    const field = `bazarr[${index}]`;
    if (!object(instance) || typeof instance.enabled !== 'boolean') invalid(field, 'must be a mapping with a boolean enabled value.');
    if (!instance.enabled) return;
    if (!nonEmpty(instance.name)) invalid(`${field}.name`, 'must be a non-empty string.');
    if (!nonEmpty(instance.apiKey)) invalid(`${field}.apiKey`, 'must be a non-empty string.');
    try {
      if (!nonEmpty(instance.url)) throw new Error();
      const url = new URL(instance.url);
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error();
    } catch {
      invalid(`${field}.url`, 'must be an HTTP/HTTPS URL without embedded credentials.');
    }
  });
  if (!object(config.logging) || !['debug', 'info', 'warn', 'error'].includes(config.logging.level)) {
    invalid('logging.level', 'must be debug, info, warn, or error.');
  }
  if (typeof config.dryRun !== 'boolean') invalid('dryRun', 'must be a boolean.');
  return config;
}
