require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { v2: cloudinary } = require("cloudinary");
const Database = require("better-sqlite3");

const app = express();
app.use(cors());
app.use(express.json());

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

const db = new Database("cloudy.db");
db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    url TEXT NOT NULL,
    likes INTEGER DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS blocked_users (
    owner TEXT PRIMARY KEY,
    blocked_at INTEGER
  );
  CREATE TABLE IF NOT EXISTS current_alert (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    message TEXT,
    created_at INTEGER
  );
`);

try {
  db.exec("ALTER TABLE videos ADD COLUMN media_type TEXT DEFAULT 'video'");
} catch (e) {
  // ya existe, no pasa nada
}

const MAX_VIDEO_MB = 100;
const MAX_PHOTO_MB = 10;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_VIDEO_MB * 1024 * 1024 },
});

function checkAdmin(req, res, next) {
  const password = req.headers["x-admin-password"];
  if (password !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ error: "No autorizado" });
  }
  next();
}

function isBlocked(owner) {
  return !!db.prepare("SELECT 1 FROM blocked_users WHERE owner = ?").get(owner);
}

function noCache(req, res, next) {
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate");
  res.set("Pragma", "no-cache");
  res.set("Expires", "0");
  next();
}

app.post("/videos", upload.single("file"), async (req, res) => {
  try {
    const { owner } = req.body;
    if (!owner || !req.file) {
      return res.status(400).json({ error: "Falta owner o archivo" });
    }
    if (isBlocked(owner)) {
      return res.status(403).json({ error: "Este usuario está bloqueado" });
    }

    const isPhoto = req.file.mimetype.startsWith("image/");
    const mediaType = isPhoto ? "photo" : "video";
    const sizeMB = req.file.size / (1024 * 1024);

    if (isPhoto && sizeMB > MAX_PHOTO_MB) {
      return res.status(413).json({ error: `Las fotos no pueden superar ${MAX_PHOTO_MB}MB` });
    }
    if (!isPhoto && sizeMB > MAX_VIDEO_MB) {
      return res.status(413).json({ error: `Los videos no pueden superar ${MAX_VIDEO_MB}MB` });
    }

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          resource_type: isPhoto ? "image" : "video",
          folder: "cloudy",
          quality: "auto:eco",
          fetch_format: "auto",
        },
        (err, result) => (err ? reject(err) : resolve(result))
      );
      stream.end(req.file.buffer);
    });

    const id = Date.now().toString() + Math.random().toString(36).slice(2);
    const created_at = Date.now();
    db.prepare(
      "INSERT INTO videos (id, owner, url, likes, created_at, media_type) VALUES (?, ?, ?, 0, ?, ?)"
    ).run(id, owner, result.secure_url, created_at, mediaType);

    res.json({ id, owner, url: result.secure_url, likes: 0, created_at, media_type: mediaType });
  } catch (err) {
    console.error(err);
    if (err.message && err.message.includes("File too large")) {
      return res.status(413).json({ error: `El archivo supera los ${MAX_VIDEO_MB}MB` });
    }
    res.status(500).json({ error: "Error subiendo el archivo" });
  }
});

app.get("/videos", noCache, (req, res) => {
  const rows = db
    .prepare(
      `SELECT * FROM videos WHERE owner NOT IN (SELECT owner FROM blocked_users) ORDER BY created_at DESC`
    )
    .all();

  const withWeights = rows.map((row, index) => {
    const weight = Math.exp(-index / 15);
    const score = Math.pow(Math.random(), 1 / weight);
    return { ...row, _score: score };
  });

  withWeights.sort((a, b) => b._score - a._score);
  const shuffled = withWeights.map(({ _score, ...rest }) => rest);

  res.json(shuffled);
});

app.get("/videos/:owner", noCache, (req, res) => {
  const rows = db
    .prepare("SELECT * FROM videos WHERE owner = ? ORDER BY created_at DESC")
    .all(req.params.owner);
  res.json(rows);
});

app.patch("/videos/:id/like", (req, res) => {
  const { liked } = req.body;
  db.prepare("UPDATE videos SET likes = likes + ? WHERE id = ?").run(
    liked ? 1 : -1,
    req.params.id
  );
  res.json({ ok: true });
});

app.delete("/videos/:id", (req, res) => {
  db.prepare("DELETE FROM videos WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

app.get("/alert", noCache, (req, res) => {
  const row = db.prepare("SELECT message FROM current_alert WHERE id = 1").get();
  res.json({ message: row ? row.message : null });
});

app.get("/debug/videos-count", (req, res) => {
  const count = db.prepare("SELECT COUNT(*) as total FROM videos").get();
  const rows = db
    .prepare("SELECT id, owner, created_at, media_type FROM videos ORDER BY created_at DESC")
    .all();
  res.json({ total: count.total, rows });
});

app.post("/admin/login", (req, res) => {
  const { password } = req.body;
  if (password === process.env.ADMIN_PASSWORD) {
    res.json({ ok: true });
  } else {
    res.status(401).json({ ok: false });
  }
});

app.get("/admin/videos", checkAdmin, noCache, (req, res) => {
  const rows = db.prepare("SELECT * FROM videos ORDER BY created_at DESC").all();
  res.json(rows);
});

app.get("/admin/blocked", checkAdmin, noCache, (req, res) => {
  const rows = db.prepare("SELECT owner, blocked_at FROM blocked_users").all();
  res.json(rows);
});

app.post("/admin/block/:owner", checkAdmin, (req, res) => {
  db.prepare(
    "INSERT OR REPLACE INTO blocked_users (owner, blocked_at) VALUES (?, ?)"
  ).run(req.params.owner, Date.now());
  res.json({ ok: true });
});

app.delete("/admin/block/:owner", checkAdmin, (req, res) => {
  db.prepare("DELETE FROM blocked_users WHERE owner = ?").run(req.params.owner);
  res.json({ ok: true });
});

app.post("/admin/alert", checkAdmin, (req, res) => {
  const { message } = req.body;
  db.prepare(
    "INSERT OR REPLACE INTO current_alert (id, message, created_at) VALUES (1, ?, ?)"
  ).run(message, Date.now());
  res.json({ ok: true });
});

app.delete("/admin/alert", checkAdmin, (req, res) => {
  db.prepare("DELETE FROM current_alert WHERE id = 1").run();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Backend corriendo en puerto ${PORT}`));