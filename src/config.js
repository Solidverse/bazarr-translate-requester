import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { languageCode } from './subtitles.js';

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
  if (['bazarr', 'sonarr', 'radarr', 'translation', 'scheduleCron', 'minimumAgeHours'].some((key) => Object.hasOwn(config, key))) {
    throw new Error('Configuration migration required: use the instances array with nested bazarr, optional sonarr/radarr and translation settings. See config.example.yml; existing files are not rewritten.');
  }
  if (!Array.isArray(config.instances)) invalid('instances', 'must be an array.');
  const names = new Set();
  config.instances.forEach((instance, index) => {
    const field = `instances[${index}]`;
    if (!object(instance) || typeof instance.enabled !== 'boolean') invalid(field, 'must be a mapping with a boolean enabled value.');
    if (!nonEmpty(instance.name)) invalid(`${field}.name`, 'must be a non-empty string.');
    if (names.has(instance.name.trim())) invalid(`${field}.name`, 'must be unique.');
    names.add(instance.name.trim());
    if (!instance.enabled) return;
    for (const service of ['bazarr', 'sonarr', 'radarr']) {
      if (service !== 'bazarr' && !Object.hasOwn(instance, service)) continue;
      const connection = instance[service];
      if (!object(connection)) invalid(`${field}.${service}`, 'must be a connection mapping.');
      if (!nonEmpty(connection.apiKey)) invalid(`${field}.${service}.apiKey`, 'must be a non-empty string.');
      try {
        if (!nonEmpty(connection.url)) throw new Error();
        const url = new URL(connection.url);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
      } catch {
        invalid(`${field}.${service}.url`, 'must be an HTTP/HTTPS URL without embedded credentials, query or fragment.');
      }
    }
    if (!object(instance.translation)) invalid(`${field}.translation`, 'must be a mapping.');
    for (const language of ['sourceLanguage', 'targetLanguage']) {
      if (!languageCode(instance.translation[language])) invalid(`${field}.translation.${language}`, 'must be a two- or three-letter language identifier; support is checked against Bazarr during generation.');
    }
    if (instance.translation.onlyEmbedded === undefined) instance.translation.onlyEmbedded = true;
    if (typeof instance.translation.onlyEmbedded !== 'boolean') invalid(`${field}.translation.onlyEmbedded`, 'must be a boolean.');
    if (instance.translation.excludeHI === undefined) instance.translation.excludeHI = false;
    if (typeof instance.translation.excludeHI !== 'boolean') invalid(`${field}.translation.excludeHI`, 'must be a boolean.');
  });
  if (!object(config.logging) || !['debug', 'info', 'warn', 'error'].includes(config.logging.level)) {
    invalid('logging.level', 'must be debug, info, warn, or error.');
  }
  if (typeof config.dryRun !== 'boolean') invalid('dryRun', 'must be a boolean.');
  return config;
}
