const express = require("express");
const cors = require("cors");
const fs = require("fs/promises");
const path = require("path");
const { randomUUID, createHash } = require("crypto");

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "leaderboard.json");
const MAX_ENTRIES = 50;

const app = express();

app.use(
  cors({
    origin: "*",
  })
);
app.use(express.json());

async function readEntries() {
  try {
    const raw = await fs.readFile(DATA_FILE, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) {
      return [];
    }
    const normalized = data
      .map((entry) => normalizeEntry(entry))
      .filter((entry) => entry && entry.fingerprint);

    const deduped = new Map();
    for (const entry of normalized) {
      const existing = deduped.get(entry.fingerprint);
      if (!existing) {
        deduped.set(entry.fingerprint, entry);
        continue;
      }
      if (entry.score > existing.score) {
        deduped.set(entry.fingerprint, entry);
      } else if (entry.score === existing.score) {
        const existingTime = new Date(existing.playedAt).getTime();
        const incomingTime = new Date(entry.playedAt).getTime();
        if (incomingTime > existingTime) {
          deduped.set(entry.fingerprint, entry);
        }
      }
    }

    return Array.from(deduped.values());
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    console.error("[leaderboard] failed to read data file:", error);
    return [];
  }
}

async function writeEntries(entries) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DATA_FILE, JSON.stringify(entries, null, 2), "utf8");
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0].trim();
  }
  if (req.ip) {
    return String(req.ip).trim();
  }
  return (req.socket?.remoteAddress || "").trim();
}

function buildFingerprint(req) {
  const ip = clientIp(req) || "unknown-ip";
  const ua = req.headers["user-agent"] || "unknown-agent";
  const acceptLang = req.headers["accept-language"] || "";
  const raw = `${ip}|${ua}|${acceptLang}`;
  const hash = createHash("sha256").update(raw).digest("hex");
  const fingerprint = hash.slice(0, 32);
  const displayName = `飞行员-${hash.slice(0, 8).toUpperCase()}`;
  return { fingerprint, displayName };
}

function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") {
    return null;
  }
  const fingerprint = entry.fingerprint || entry.id || null;
  const displayName =
    entry.displayName || entry.name || (fingerprint ? `飞行员-${String(fingerprint).slice(0, 8).toUpperCase()}` : "飞行员");
  return {
    id: entry.id || randomUUID(),
    fingerprint,
    displayName,
    score: Number.isFinite(entry.score) ? Math.floor(entry.score) : 0,
    playedAt: entry.playedAt || new Date().toISOString(),
  };
}

function normalizeScore(value) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(Math.floor(value), 0);
}

app.get("/api/leaderboard", async (req, res) => {
  const entries = await readEntries();
  entries.sort((a, b) => b.score - a.score || new Date(a.playedAt) - new Date(b.playedAt));
  res.json({
    entries: entries.slice(0, MAX_ENTRIES),
  });
});

app.post("/api/leaderboard", async (req, res) => {
  const { score } = req.body || {};

  const numericScore = Number(score);
  if (!Number.isFinite(numericScore)) {
    return res.status(400).json({ error: "score must be a number" });
  }

  const normalizedScore = normalizeScore(numericScore);
  const { fingerprint, displayName } = buildFingerprint(req);

  if (!fingerprint) {
    return res.status(400).json({ error: "unable to determine fingerprint" });
  }

  const entries = await readEntries();
  const now = new Date().toISOString();
  const existingIndex = entries.findIndex((item) => item.fingerprint === fingerprint);

  if (existingIndex >= 0) {
    const existing = entries[existingIndex];
    if (normalizedScore > existing.score) {
      existing.score = normalizedScore;
      existing.playedAt = now;
    }
    existing.displayName = displayName;
    entries[existingIndex] = existing;
    entries.sort((a, b) => b.score - a.score || new Date(a.playedAt) - new Date(b.playedAt));
    const trimmed = entries.slice(0, MAX_ENTRIES);
    await writeEntries(trimmed);
    const responseEntry =
      trimmed.find((item) => item.fingerprint === fingerprint) || existing;
    return res.status(200).json({ entry: responseEntry, entries: trimmed });
  }

  const entry = {
    id: randomUUID(),
    fingerprint,
    displayName,
    score: normalizedScore,
    playedAt: now,
  };

  entries.push(entry);
  entries.sort((a, b) => b.score - a.score || new Date(a.playedAt) - new Date(b.playedAt));
  const trimmed = entries.slice(0, MAX_ENTRIES);
  await writeEntries(trimmed);

  res.status(201).json({ entry, entries: trimmed });
});

app.get("/health", (req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Leaderboard API listening on http://localhost:${PORT}`);
});
