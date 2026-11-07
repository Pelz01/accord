import { DatabaseSync, backup } from 'node:sqlite';
import { mkdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

process.umask(0o077);
const directory = process.env.ACCORD_BACKUP_DIR || '/backups';
await mkdir(directory, { recursive: true });
const source = new DatabaseSync(process.env.ACCORD_DATA_PATH || '/data/accord.sqlite', {
  readOnly: true,
});
const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = join(directory, `accord-${timestamp}.sqlite`);
try {
  await backup(source, target);
  const check = new DatabaseSync(target, { readOnly: true });
  try {
    if (check.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok')
      throw new Error('Backup integrity check failed.');
  } finally {
    check.close();
  }
  console.log(JSON.stringify({ status: 'ok', backup: target, bytes: (await stat(target)).size }));
} finally {
  source.close();
}
