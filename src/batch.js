import { open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { stringify } from 'yaml';

export async function writeBatch(path, requests) {
  const temporary = join(dirname(path), `.requests-${randomUUID()}.tmp`);
  let file;
  try {
    if (!requests.length) {
      await unlink(path).catch((error) => { if (error.code !== 'ENOENT') throw error; });
      return;
    }
    file = await open(temporary, 'wx', 0o600);
    await file.writeFile(stringify({ requests }, { lineWidth: 0 }), 'utf8');
    await file.sync();
    await file.close(); file = null;
    // Same-directory rename atomically publishes the complete replacement.
    await rename(temporary, path);
  } catch {
    throw new Error('Cannot publish requests.yml safely; check directory access.');
  } finally {
    if (file) await file.close().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}
