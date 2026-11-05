const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, randomBytes, createHash, timingSafeEqual } = require('node:crypto');

const RULESET = 'prototype-v1';
const RUN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const hash = (value) => createHash('sha256').update(value).digest('hex');
class RequestError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

class LeaderboardStore {
  constructor(dataDir) {
    fs.mkdirSync(dataDir, { recursive: true });
    try {
      this.db = new DatabaseSync(path.join(dataDir, 'leaderboard.sqlite'));
      this.db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;');
      this.transaction(() => {
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS entries (
            fingerprint TEXT PRIMARY KEY, id TEXT NOT NULL, display_name TEXT NOT NULL,
            score INTEGER NOT NULL CHECK(score >= 0), played_at TEXT NOT NULL
          );
          CREATE TABLE IF NOT EXISTS runs (
            id TEXT PRIMARY KEY, token_hash TEXT NOT NULL, fingerprint TEXT NOT NULL,
            display_name TEXT NOT NULL, started_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
            submitted_score INTEGER, duration_ms INTEGER, receipt TEXT
          );
          CREATE INDEX IF NOT EXISTS run_expiry ON runs(expires_at);
        `);
        if (!this.db.prepare("SELECT value FROM metadata WHERE key='legacy_imported'").get()) {
          let entries = [];
          try { entries = JSON.parse(fs.readFileSync(path.join(dataDir, 'leaderboard.json'), 'utf8')); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (!Array.isArray(entries)) throw new Error('Invalid legacy leaderboard');
          for (const entry of entries) {
            const fingerprint = entry?.fingerprint || entry?.id;
            if (typeof fingerprint !== 'string' || !fingerprint ||
                !Number.isSafeInteger(entry.score) || entry.score < 0 ||
                !Number.isFinite(Date.parse(entry.playedAt))) {
              throw new Error('Invalid legacy entry; import aborted without changing source');
            }
            this.upsert({ fingerprint, id: entry.id || randomUUID(),
              displayName: entry.displayName || entry.name || '飞行员',
              score: entry.score, playedAt: entry.playedAt });
          }
          this.db.prepare("INSERT INTO metadata VALUES ('legacy_imported', '1')").run();
        }
      });
    } catch (error) {
      this.db?.close();
      throw error;
    }
  }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  upsert(entry) {
    this.db.prepare(`INSERT INTO entries VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(fingerprint) DO UPDATE SET score=excluded.score,
      played_at=excluded.played_at, display_name=excluded.display_name
      WHERE excluded.score > entries.score`).run(
      entry.fingerprint, entry.id, entry.displayName, entry.score, entry.playedAt);
  }
  list() {
    return this.db.prepare(`SELECT id, fingerprint, display_name AS displayName,
      score, played_at AS playedAt FROM entries
      ORDER BY score DESC, played_at ASC, fingerprint ASC LIMIT 50`).all();
  }
  health() {
    this.db.prepare('SELECT COUNT(*) FROM entries').get();
  }
  createRun(identity, now = Date.now()) {
    const token = randomBytes(32).toString('hex');
    const id = randomUUID();
    this.transaction(() => {
      this.db.prepare('DELETE FROM runs WHERE expires_at < ?').run(now);
      this.db.prepare(`INSERT INTO runs
        (id,token_hash,fingerprint,display_name,started_at,expires_at) VALUES (?,?,?,?,?,?)`)
        .run(id, hash(token), identity.fingerprint, identity.displayName, now, now + RUN_TTL_MS);
    });
    return { runId: id, token, ruleset: RULESET, expiresAt: now + RUN_TTL_MS };
  }
  submit({ runId, token, score, durationMs }, identity, now = Date.now()) {
    return this.transaction(() => {
      const run = this.db.prepare('SELECT * FROM runs WHERE id=?').get(runId);
      if (!run || !timingSafeEqual(Buffer.from(run.token_hash, 'hex'), Buffer.from(hash(token), 'hex')) ||
          run.fingerprint !== identity.fingerprint) throw new RequestError(403, 'invalid run credentials');
      if (run.expires_at < now) throw new RequestError(410, 'run expired');
      if (run.receipt) {
        if (run.submitted_score !== score || run.duration_ms !== durationMs)
          throw new RequestError(409, 'run already submitted with different result');
        return { entry: JSON.parse(run.receipt), entries: this.list(), duplicate: true };
      }
      // Loose upper bound from existing rules: <=3 enemies per >=150ms spawn.
      // A 5s enrollment allowance covers the client's 4s request timeout.
      // This rejects impossible claims; it is NOT authoritative gameplay validation.
      if (durationMs > now - run.started_at + 5000 || score > 3 * (1 + Math.floor(durationMs / 150)))
        throw new RequestError(422, 'score or duration exceeds possible run bounds');
      const entry = { id: randomUUID(), fingerprint: run.fingerprint,
        displayName: run.display_name, score, playedAt: new Date(now).toISOString() };
      this.upsert(entry);
      const best = this.db.prepare(`SELECT id, fingerprint, display_name AS displayName,
        score, played_at AS playedAt FROM entries WHERE fingerprint=?`).get(run.fingerprint);
      this.db.prepare('UPDATE runs SET submitted_score=?,duration_ms=?,receipt=? WHERE id=?')
        .run(score, durationMs, JSON.stringify(best), runId);
      return { entry: best, entries: this.list(), duplicate: false };
    });
  }
  close() { this.db.close(); }
}
module.exports = { LeaderboardStore, RequestError, RULESET };
