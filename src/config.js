import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';

const nonEmpty = (value) => typeof value === 'string' && value.trim().length > 0;
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (field, message) => { throw new Error(`Invalid configuration: ${field} ${message}`); };

// Deliberately accept the portable numeric, five-field Debian cron subset.
// Reject control characters and extensions before generating any shell input.
export function validateCron(value) {
  if (typeof value !== 'string' || !/^[0-9*,/ \t-]+$/.test(value)) return false;
  const fields = value.trim().split(/[ \t]+/);
  if (fields.length !== 5) return false;
  return fields.every((field, index) => {
    const [min, max] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]][index];
    return field.split(',').every((part) => {
      const match = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
      if (!match) return false;
      const [, range, step] = match;
      if (step !== undefined && (!Number.isSafeInteger(Number(step)) || Number(step) < 1 || Number(step) > max - min + 1)) return false;
      if (range === '*') return true;
      if (step !== undefined && !range.includes('-')) return false;
      const bounds = range.split('-').map(Number);
      return bounds.every((n) => Number.isInteger(n) && n >= min && n <= max)
        && (bounds.length === 1 || bounds[0] <= bounds[1]);
    });
  });
}

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
  if (!validateCron(config.scheduleCron)) invalid('scheduleCron', 'must be a numeric five-field cron expression with valid ranges and steps.');
  if (!object(config.translation)) invalid('translation', 'must be a mapping.');
  for (const field of ['sourceLanguage', 'targetLanguage']) {
    if (!nonEmpty(config.translation[field])) invalid(`translation.${field}`, 'must be a non-empty string.');
  }
  if (!Number.isFinite(config.translation.minimumAgeHours) || config.translation.minimumAgeHours < 0) {
    invalid('translation.minimumAgeHours', 'must be a non-negative number.');
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
