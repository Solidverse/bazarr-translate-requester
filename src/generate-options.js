import { parseArgs } from 'node:util';

export function parseGenerateArgs(args) {
  let parsed;
  try {
    parsed = parseArgs({ args, strict: true, allowPositionals: false, tokens: true, options: {
      type: { type: 'string' }, instance: { type: 'string' }, series: { type: 'string' },
      'min-age': { type: 'string' }, preview: { type: 'boolean', default: false },
    } });
  } catch { throw new Error('Invalid generate arguments. Use --type movie|series, --instance, --series, --min-age or --preview.'); }
  const seen = new Set();
  for (const token of parsed.tokens) {
    if (token.kind !== 'option' || seen.has(token.name)) throw new Error('Duplicate or invalid generate arguments.');
    seen.add(token.name);
  }
  const values = parsed.values;
  if (values.type !== undefined && !['movie', 'series'].includes(values.type)) throw new Error('--type must be movie or series.');
  if (values.instance !== undefined && !values.instance.trim()) throw new Error('--instance requires a nonempty name.');
  function integer(value, minimum, maximum) {
    if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum || Number(value) > maximum) throw new Error('Invalid --series or --min-age integer.');
    return Number(value);
  }
  const seriesId = values.series === undefined ? undefined : integer(values.series, 1, Number.MAX_SAFE_INTEGER);
  const minAge = values['min-age'] === undefined ? undefined : integer(values['min-age'], 0, Math.floor(Number.MAX_SAFE_INTEGER / 86_400_000));
  if (seriesId !== undefined && values.type === 'movie') throw new Error('--series cannot be combined with --type movie.');
  return { type: seriesId !== undefined ? 'series' : values.type, instance: values.instance, seriesId, minAge, preview: values.preview };
}
