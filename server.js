import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname || ".mp4").toLowerCase();
    cb(null, `${Date.now()}-${crypto.randomBytes(4).toString("hex")}${ext}`);
  },
});

const ALLOWED_MIMES = new Set([
  "video/mp4",
  "video/webm",
  "video/quicktime",
]);

const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname || "").toLowerCase();
    if (
      ALLOWED_MIMES.has(file.mimetype) ||
      [".mp4", ".webm", ".mov"].includes(ext)
    ) {
      cb(null, true);
    } else {
      cb(new Error("Only mp4, webm, and mov video files are allowed."));
    }
  },
});

/**
 * In-memory state store (no database per security rules)
 * @type {Map<string, any>}
 */
export const reports = new Map();

/**
 * Active SSE clients per report ID
 * @type {Map<string, Set<import("express").Response>>}
 */
export const sseClients = new Map();

export function emitReportEvent(reportId, event) {
  const clients = sseClients.get(reportId);
  if (!clients) return;
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    res.write(payload);
  }
}

// Serve static assets and uploaded videos for review playback
app.use("/static", express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(uploadsDir));

// GET /healthz -> ok
app.get("/healthz", (_req, res) => {
  res.status(200).type("text/plain").send("ok");
});

// GET / -> Reporter upload page
app.get("/", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// GET /review/:id -> Developer review page
app.get("/review/:id", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "review.html"));
});

// POST /api/reports -> Create report & start pipeline
app.post("/api/reports", upload.single("video"), (req, res) => {
  try {
    const file = req.file;
    const note = (req.body?.note || "").trim();
    const repoUrl = (req.body?.repoUrl || "").trim();

    if (!file) {
      return res.status(400).json({ error: "Video file is required." });
    }
    if (!repoUrl) {
      return res.status(400).json({ error: "Repository URL is required." });
    }

    const id = crypto.randomBytes(4).toString("hex");
    const report = {
      id,
      createdAt: new Date().toISOString(),
      stage: "uploaded",
      note,
      repoUrl,
      videoRef: `/uploads/${file.filename}`,
      videoPath: file.path,
      videoMimeType: file.mimetype || "video/mp4",
    };

    reports.set(id, report);
    emitReportEvent(id, {
      type: "stage",
      stage: "uploaded",
      message: "Bug video uploaded. Pipeline ready.",
    });

    return res.status(201).json({ id });
  } catch (err) {
    return res.status(500).json({ error: err.message || "Upload failed" });
  }
});

// GET /api/reports/:id -> Full report JSON
app.get("/api/reports/:id", (req, res) => {
  const report = reports.get(req.params.id);
  if (!report) {
    return res.status(404).json({ error: "Report not found" });
  }
  const { videoPath, ...publicReport } = report;
  return res.json(publicReport);
});

// GET /api/reports/:id/events -> SSE stream of ReportEvent
app.get("/api/reports/:id/events", (req, res) => {
  const { id } = req.params;
  const report = reports.get(id);
  if (!report) {
    return res.status(404).json({ error: "Report not found" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders?.();

  const { videoPath, ...publicReport } = report;
  res.write(
    `data: ${JSON.stringify({ type: "result", report: publicReport })}\n\n`
  );

  if (!sseClients.has(id)) {
    sseClients.set(id, new Set());
  }
  sseClients.get(id).add(res);

  req.on("close", () => {
    sseClients.get(id)?.delete(res);
  });
});

// POST /api/reports/:id/approve -> Opens the PR -> { prUrl }
app.post("/api/reports/:id/approve", async (req, res) => {
  const report = reports.get(req.params.id);
  if (!report) {
    return res.status(404).json({ error: "Report not found" });
  }
  return res
    .status(501)
    .json({ error: "PR creation will be enabled in Step 6." });
});

app.listen(PORT, () => {
  console.log(`BugReel server listening on http://localhost:${PORT}`);
});
