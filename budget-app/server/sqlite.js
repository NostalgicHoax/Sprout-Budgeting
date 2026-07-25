import Database from 'better-sqlite3-multiple-ciphers';

function readable(db) {
  try {
    db.prepare('SELECT count(*) AS n FROM sqlite_master').get();
    return true;
  } catch {
    return false;
  }
}

/** Opens an unencrypted database (system.db — holds no financial data). */
export function openPlain(path) {
  const db = new Database(path);
  if (!readable(db)) {
    db.close();
    throw new Error(`${path} is unreadable or encrypted`);
  }
  return db;
}

/** Opens a budget database encrypted with the given hex key. A plaintext file
 *  (created before encryption existed) is encrypted in place on first open. */
export function openEncrypted(path, hexKey) {
  let db = new Database(path);
  db.pragma(`key = '${hexKey}'`);
  if (readable(db)) return db;
  db.close();

  db = new Database(path);
  if (!readable(db)) {
    db.close();
    const err = new Error(`cannot open ${path}: wrong key`);
    err.code = 'WRONG_KEY';
    throw err;
  }
  // legacy plaintext database — encrypt in place (rekey requires non-WAL mode)
  db.pragma('journal_mode = DELETE');
  db.pragma(`rekey = '${hexKey}'`);
  db.close();

  db = new Database(path);
  db.pragma(`key = '${hexKey}'`);
  if (!readable(db)) {
    db.close();
    throw new Error(`failed to encrypt ${path}`);
  }
  console.log(`[budget-app] encrypted ${path} at rest`);
  return db;
}
