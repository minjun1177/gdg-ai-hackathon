import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import multer from "multer";
import {
  createGithubPullRequest,
  runBugReelPipeline,
} from "./pipeline.js";

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

const ALLOWED_EXTS = new Set([".mp4", ".webm", ".mov"]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadsDir),
  filename: (_req, file, cb) => {
    const rawExt = path.extname(file.originalname || "").toLowerCase();
    const ext = ALLOWED_EXTS.has(rawExt) ? rawExt : ".mp4";
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
    if (ALLOWED_MIMES.has(file.mimetype) || ALLOWED_EXTS.has(ext)) {
      cb(null, true);
    } else {
      cb(new Error("Only mp4, webm, and mov video files are allowed."));
    }
  },
});

export function isValidGithubRepoUrl(urlStr) {
  try {
    const parsed = new URL(urlStr);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return false;
    }
    if (parsed.hostname !== "github.com") {
      return false;
    }
    const parts = parsed.pathname.replace(/^\/+|\/+$/g, "").split("/");
    return parts.length >= 2 && Boolean(parts[0]) && Boolean(parts[1]);
  } catch {
    return false;
  }
}

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
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

// Serve static assets and uploaded videos for review playback
app.use("/static", express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(uploadsDir));

// GET /healthz (and /health, /api/healthz for Cloud Run GFE compatibility) -> ok
app.get(["/healthz", "/health", "/api/healthz"], (_req, res) => {
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

// POST /api/reports -> Create report & start pipeline in background
app.post("/api/reports", (req, res) => {
  upload.single("video")(req, res, (uploadErr) => {
    if (uploadErr) {
      return res
        .status(400)
        .json({ error: uploadErr.message || "Invalid video upload." });
    }

    try {
      const file = req.file;
      const note = (req.body?.note || "").trim();
      const repoUrl = (req.body?.repoUrl || "").trim();

      if (!file) {
        return res.status(400).json({ error: "Video file is required." });
      }
      if (!repoUrl || !isValidGithubRepoUrl(repoUrl)) {
        fs.unlink(file.path, () => {});
        return res.status(400).json({
          error:
            "A valid GitHub repository URL (https://github.com/<owner>/<repo>) is required.",
        });
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
        message: "Bug video uploaded. Starting BugReel pipeline...",
      });

      if (process.env.BUGREEL_DISABLE_AUTO_RUN !== "1") {
        setImmediate(() => {
          runBugReelPipeline(report, emitReportEvent).catch((err) => {
            console.error(`Pipeline error for report ${id}:`, err);
          });
        });
      }

      return res.status(201).json({ id });
    } catch (err) {
      if (req.file?.path) {
        fs.unlink(req.file.path, () => {});
      }
      return res.status(500).json({ error: err.message || "Upload failed" });
    }
  });
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

// GET /api/reports/:id/diff -> Download unified diff as patch file
app.get("/api/reports/:id/diff", (req, res) => {
  const report = reports.get(req.params.id);
  if (!report) {
    return res.status(404).json({ error: "Report not found" });
  }
  if (!report.fix?.diff) {
    return res.status(404).json({ error: "No diff available for this report" });
  }
  res.setHeader("Content-Type", "text/x-diff; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="bugreel-fix-${report.id}.diff"`
  );
  return res.send(report.fix.diff);
});

// GET /api/reports/:id/events -> SSE stream of ReportEvent
app.get("/api/reports/:id/events", (req, res) => {
  const { id } = req.params;
  const report = reports.get(id);
  if (!report) {
    return res.status(404).json({ error: "Report not found" });
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();

  const { videoPath, ...publicReport } = report;
  res.write(
    `data: ${JSON.stringify({ type: "result", report: publicReport })}\n\n`
  );

  if (!sseClients.has(id)) {
    sseClients.set(id, new Set());
  }
  sseClients.get(id).add(res);

  const heartbeat = setInterval(() => {
    try {
      res.write(": keep-alive\n\n");
    } catch {
      clearInterval(heartbeat);
    }
  }, 15000);

  req.on("close", () => {
    clearInterval(heartbeat);
    const set = sseClients.get(id);
    if (set) {
      set.delete(res);
      if (set.size === 0) {
        sseClients.delete(id);
      }
    }
  });
});

// POST /api/reports/:id/approve -> Opens the PR -> { prUrl }
app.post("/api/reports/:id/approve", async (req, res) => {
  const report = reports.get(req.params.id);
  if (!report) {
    return res.status(404).json({ error: "Report not found" });
  }

  if (report.prUrl) {
    return res.json({ prUrl: report.prUrl });
  }

  const testsAllPassed =
    report.fix?.tests?.total > 0 &&
    report.fix?.tests?.passed === report.fix?.tests?.total;

  if (
    (report.stage !== "fixed" && report.stage !== "approved") ||
    report.fix?.status !== "fixed" ||
    !testsAllPassed
  ) {
    return res.status(400).json({
      error: `Report is in stage "${report.stage}" and cannot be approved until stage is "fixed" with all tests passing.`,
    });
  }

  try {
    report.stage = "approved";
    emitReportEvent(report.id, {
      type: "stage",
      stage: "approved",
      message: "Developer approved fix. Opening GitHub Pull Request...",
    });

    const protocol = req.headers["x-forwarded-proto"] || req.protocol || "https";
    const host = req.get("host") || `localhost:${PORT}`;
    const reviewPageUrl = `${protocol}://${host}/review/${report.id}`;

    const prUrl = await createGithubPullRequest(report, reviewPageUrl);
    report.prUrl = prUrl;
    report.stage = "pr_opened";

    const { videoPath, ...publicReport } = report;
    emitReportEvent(report.id, {
      type: "stage",
      stage: "pr_opened",
      message: `Pull Request opened: ${prUrl}`,
    });
    emitReportEvent(report.id, {
      type: "result",
      report: publicReport,
    });

    return res.json({ prUrl });
  } catch (err) {
    report.stage = "fixed"; // revert to fixed so developer can retry or download diff
    return res.status(500).json({
      error: err.message || "Failed to open Pull Request.",
    });
  }
});

export { app };

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  app.listen(PORT, () => {
    console.log(`BugReel server listening on http://localhost:${PORT}`);
  });
}

