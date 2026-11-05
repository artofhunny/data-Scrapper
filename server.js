/**
 * WEB UI SERVER
 * ---------------------------------------------------------
 * Serves the search page (public/index.html) and runs the EXACT same
 * pipeline as the CLI (lib/agent.js -> runFullPipeline), just triggered
 * by a browser request instead of a terminal prompt.
 *
 * The search query is entirely user-supplied, so this works for any kind
 * of local business lead, not just mechanics (e.g. tuition teachers, web
 * dev companies, salons, clinics, etc.).
 *
 * Flow:
 *   1) Browser POSTs a search query to /api/search -> server starts a job
 *      and immediately returns a jobId (doesn't make the browser wait)
 *   2) Browser opens a live connection to /api/progress/:jobId (Server-Sent
 *      Events) to watch the same log lines that used to print in the terminal
 *   3) When the pipeline finishes, the browser gets a download link
 *   4) GET /api/download/:jobId serves the finished Excel file
 *
 * NOTE: log messages now carry a "level" (info | warn | error) so the
 * frontend console can color-code rate-limit warnings and real failures
 * instead of showing everything as plain green text.
 * ---------------------------------------------------------
 */

import "dotenv/config";
import express from "express";
import path from "path";
import fs from "fs";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { runFullPipeline } from "./lib/agent.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = path.join(__dirname, "generated");
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// in-memory job store: jobId -> { logs: [], clients: [], done, filepath, error }
const jobs = new Map();

function sendEvent(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function pushLog(jobId, message, level = "info") {
  const job = jobs.get(jobId);
  if (!job) return;
  job.logs.push({ message, level });
  job.clients.forEach((res) => sendEvent(res, { type: "log", message, level }));
}

app.post("/api/search", (req, res) => {
  const query = (req.body?.query || "").trim();
  if (!query) {
    return res.status(400).json({ error: "Search query is required." });
  }
  if (!process.env.GEMINI_API_KEY) {
    return res.status(500).json({ error: "Server is missing GEMINI_API_KEY. Check the .env file." });
  }

  const jobId = crypto.randomUUID();
  jobs.set(jobId, { logs: [], clients: [], done: false, filepath: null, error: null });
  res.json({ jobId });

  // run the pipeline in the background - the HTTP response above already returned
  (async () => {
    const job = jobs.get(jobId);
    try {
      const filepath = await runFullPipeline(
        query,
        (msg, level = "info") => pushLog(jobId, msg, level),
        OUTPUT_DIR
      );
      job.done = true;
      job.filepath = filepath;
      job.clients.forEach((res) => {
        sendEvent(res, { type: "done", downloadUrl: `/api/download/${jobId}` });
        res.end();
      });
    } catch (err) {
      job.done = true;
      job.error = err.message || "Unknown error";
      job.clients.forEach((res) => {
        sendEvent(res, { type: "error", message: job.error });
        res.end();
      });
    }
  })();
});

app.get("/api/progress/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).end();

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  // replay anything that already happened before this client connected
  job.logs.forEach((entry) =>
    sendEvent(res, { type: "log", message: entry.message, level: entry.level })
  );

  if (job.done) {
    if (job.error) {
      sendEvent(res, { type: "error", message: job.error });
    } else {
      sendEvent(res, { type: "done", downloadUrl: `/api/download/${req.params.jobId}` });
    }
    return res.end();
  }

  job.clients.push(res);
  req.on("close", () => {
    job.clients = job.clients.filter((c) => c !== res);
  });
});

app.get("/api/download/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job || !job.filepath) return res.status(404).send("File not found.");
  res.download(job.filepath);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Local Lead Scraper UI running at http://localhost:${PORT}`);
});