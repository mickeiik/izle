import { closeSync, fsyncSync, lstatSync, openSync, realpathSync, renameSync, rmSync, statSync, type Stats } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

/** A backup that cannot be taken; the message is meant for the owner's terminal. */
export class BackupError extends Error {
  override name = "BackupError";
}

const statOrNull = (file: string, follow: boolean): Stats | null => {
  try {
    return follow ? statSync(file) : lstatSync(file);
  } catch {
    return null;
  }
};

/** The absolute path with its directory's symlinks resolved (the file itself need not exist). */
function canonical(file: string): string {
  const abs = path.resolve(file);
  try {
    return path.join(realpathSync(path.dirname(abs)), path.basename(abs));
  } catch {
    return abs;
  }
}

/**
 * Copies the SQLite database `source` to `target` with `VACUUM INTO`, which reads one consistent snapshot. The
 * server keeps its database in WAL mode, so this works from a separate process while the server keeps reading and
 * writing; the source is opened as usual (never migrated) and closed again. The copy is a self-contained database
 * file with mode 0600 (it holds the devices' token hashes). It is written next to the target under a temporary name
 * and renamed into place, so the target path only ever holds a complete backup and a failed run leaves an older
 * file alone. An existing target is refused unless `force`; the database's own files are refused always.
 */
export function backupDatabase(source: string, target: string, opts: { force?: boolean } = {}): { bytes: number } {
  const src = statOrNull(source, true);
  if (!src) throw new BackupError(`there is no database at ${source}; the server creates it when it first starts`);
  if (!src.isFile()) throw new BackupError(`${source} is not a database file`);

  const ownFiles = new Set(["", "-wal", "-shm", "-journal"].map((suffix) => canonical(source + suffix)));
  const linked = statOrNull(target, true);
  if (ownFiles.has(canonical(target)) || (linked && linked.dev === src.dev && linked.ino === src.ino)) {
    throw new BackupError(`${target} is the database itself; write the backup somewhere else`);
  }
  const existing = statOrNull(target, false);
  if (existing?.isDirectory()) throw new BackupError(`${target} is a directory; give the backup a file name`);
  if (existing && !opts.force) throw new BackupError(`${target} already exists; pass --force to replace it`);

  // VACUUM INTO accepts an empty file and keeps its mode.
  const partial = path.join(path.dirname(target), `.${path.basename(target)}.partial-${process.pid}`);
  try {
    closeSync(openSync(partial, "wx", 0o600));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? (err as Error).message;
    throw new BackupError(code === "ENOENT" ? `the directory ${path.dirname(target)} does not exist` : `cannot write to ${path.dirname(target)} (${code})`);
  }
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(source);
    db.exec("PRAGMA busy_timeout = 5000");
    db.prepare("VACUUM INTO ?").run(partial);
    const fd = openSync(partial, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(partial, target);
  } catch (err) {
    rmSync(partial, { force: true });
    throw new BackupError(`cannot copy ${source}: ${(err as Error).message}`);
  } finally {
    db?.close();
  }
  return { bytes: statSync(target).size };
}
