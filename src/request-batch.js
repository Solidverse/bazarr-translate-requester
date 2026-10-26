import { constants } from 'node:fs';
import { open, lstat, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseDocument, isSeq } from 'yaml';
import { languageCode, validSubtitleId } from './subtitles.js';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = (id) => Number.isSafeInteger(id) && id > 0;
const invalid = (index) => { throw new Error(`Invalid requests.yml entry at position ${index + 1}; check media identity, languages, tracks and selectedSubtitleId.`); };
function validate(entries) {
  const identities = new Set();
  entries.forEach((entry, index) => {
    if (!object(entry) || typeof entry.instance !== 'string' || !entry.instance.trim()
      || !['movie', 'episode'].includes(entry.type) || !validId(entry.mediaId)
      || (entry.type === 'episode' && !validId(entry.seriesId)) || typeof entry.title !== 'string' || !entry.title.trim()
      || !languageCode(entry.sourceLanguage) || !languageCode(entry.targetLanguage)
      || !validSubtitleId(entry.selectedSubtitleId) || !Array.isArray(entry.tracks) || !entry.tracks.length) invalid(index);
    const key = JSON.stringify([entry.instance, entry.type, entry.mediaId]);
    if (identities.has(key)) throw new Error(`Duplicate requests.yml media identity at position ${index + 1}.`);
    identities.add(key);
    const ids = new Set();
    for (const track of entry.tracks) {
      if (!object(track) || !validSubtitleId(track.id) || !['embedded', 'external'].includes(track.source)
        || !languageCode(track.language) || typeof track.hi !== 'boolean' || typeof track.forced !== 'boolean'
        || (track.source === 'external' && (typeof track.path !== 'string' || !track.path.trim()))
        || (track.embedded_track_id !== undefined && (!Number.isSafeInteger(track.embedded_track_id) || track.embedded_track_id < 0))
        || ids.has(String(track.id))) invalid(index);
      ids.add(String(track.id));
    }
    if (!ids.has(String(entry.selectedSubtitleId))) invalid(index);
  });
}
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino;
async function snapshot(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1) throw new Error();
    const text = await file.readFile('utf8');
    const stat = await file.stat();
    if (before.mtimeMs !== stat.mtimeMs || before.ctimeMs !== stat.ctimeMs) throw new Error();
    return { text, stat };
  } catch (error) {
    throw new Error(error.code === 'ENOENT' ? 'requests.yml not found; generate and review a batch first.' : 'Cannot safely read requests.yml; use a readable regular file without links.');
  } finally { await file?.close(); }
}

export async function openRequestBatch(path) {
  const lockPath = join(dirname(path), '.requests.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { throw new Error(error.code === 'EEXIST'
    ? 'Another requester holds .requests.lock. If a previous process crashed, verify it has stopped before removing the stale lock manually.'
    : 'Cannot acquire requester lock; check the configuration directory permissions.'); }
  const owner = await lock.stat();
  async function assertLock() {
    try { const stat = await lstat(lockPath); if (!stat.isFile() || !sameFile(stat, owner) || stat.nlink !== 1) throw new Error(); }
    catch { throw new Error('Requester lock changed; stopping to prevent concurrent submissions.'); }
  }
  async function close() {
    await lock.close();
    try { const stat = await lstat(lockPath); if (sameFile(stat, owner)) await unlink(lockPath); }
    catch (error) { if (error.code !== 'ENOENT') throw new Error('Cannot release requester lock; check .requests.lock manually after this process stops.'); }
  }
  try {
    let expected = await snapshot(path);
    let document;
    let entries;
    try {
      document = parseDocument(expected.text, { uniqueKeys: true });
      if (document.errors.length || document.warnings.length || !isSeq(document.get('requests', true))) throw new Error();
      const data = document.toJS({ maxAliasCount: 0 });
      if (!object(data) || !Array.isArray(data.requests)) throw new Error();
      entries = data.requests;
    } catch { throw new Error('Invalid requests.yml YAML; expected a requests array without duplicate keys, aliases or unsupported tags.'); }
    validate(entries);
    async function assertUnchanged() {
      await assertLock();
      const current = await snapshot(path);
      if (!sameFile(current.stat, expected.stat) || current.stat.mtimeMs !== expected.stat.mtimeMs
        || current.stat.ctimeMs !== expected.stat.ctimeMs || current.text !== expected.text) {
        throw new Error('requests.yml changed during execution; stopping without overwriting manual edits.');
      }
    }
    async function persist(next, remaining) {
      await assertUnchanged();
      const temporary = join(dirname(path), `.requests-${randomUUID()}.tmp`);
      let file;
      try {
        if (!remaining.length) await unlink(path);
        else {
          file = await open(temporary, 'wx', 0o600);
          await file.writeFile(next.toString(), 'utf8'); await file.chmod(expected.stat.mode & 0o777); await file.sync(); await file.close(); file = null;
          await assertUnchanged();
          await rename(temporary, path);
        }
        if (remaining.length) expected = await snapshot(path);
        document = next; entries.splice(0, entries.length, ...remaining);
      } catch { throw new Error('Cannot persist batch cleanup safely; stop and verify accepted requests manually before retrying.'); }
      finally { await file?.close().catch(() => {}); await unlink(temporary).catch(() => {}); }
    }
    return {
      entries, assertUnchanged, close,
      async removeAccepted(entry) {
        const index = entries.indexOf(entry);
        if (index < 0) throw new Error('Accepted entry was not found in the active batch; stopping.');
        const next = document.clone(); next.get('requests', true).items.splice(index, 1);
        await persist(next, entries.filter((_, position) => position !== index));
      },
      async deleteEmpty() { if (!entries.length) await persist(document, []); },
    };
  } catch (error) { await close().catch(() => {}); throw error; }
}
