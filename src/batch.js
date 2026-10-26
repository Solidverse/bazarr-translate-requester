import { lstat, open, link, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';

const existingMessage = 'An existing requests.yml batch awaits processing or manual removal; it will not be overwritten.';
export async function ensureNoBatch(path) {
  try { await lstat(path); } catch (error) {
    if (error.code === 'ENOENT') return;
    throw new Error('Cannot inspect requests.yml; check directory access.');
  }
  throw new Error(existingMessage);
}
export async function writeBatch(path, requests) {
  if (!requests.length) return;
  const temporary = join(dirname(path), `.requests-${randomUUID()}.tmp`);
  let file;
  try {
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(stringify({ requests }, { lineWidth: 0 }), 'utf8');
    await file.sync();
    await file.close(); file = null;
    // Same-filesystem hard link publishes the fully written inode atomically.
    // Unlike rename(), link() cannot replace an existing file or symlink.
    await link(temporary, path);
  } catch (error) {
    throw new Error(error.code === 'EEXIST' ? existingMessage : 'Cannot publish requests.yml safely; check permissions and filesystem hard-link support.');
  } finally {
    if (file) await file.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}
