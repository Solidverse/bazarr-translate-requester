import { parseArgs } from 'node:util';

export function parseRequestArgs(args) {
  let parsed;
  try { parsed = parseArgs({ args, strict: true, allowPositionals: false, tokens: true, options: { max: { type: 'string' } } }); }
  catch { throw new Error('Invalid request arguments. Use only --max followed by a positive integer.'); }
  if (parsed.tokens.length > 1 || (parsed.values.max !== undefined
    && (!/^\d+$/.test(parsed.values.max) || !Number.isSafeInteger(Number(parsed.values.max)) || Number(parsed.values.max) < 1))) {
    throw new Error('--max must be specified once as a positive integer.');
  }
  return { max: parsed.values.max === undefined ? undefined : Number(parsed.values.max) };
}
