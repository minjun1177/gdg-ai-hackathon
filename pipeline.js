import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const VERIFY_PY_PATH = path.join(__dirname, "verify.py");
const VERIFY_PY_CONTENT = fs.readFileSync(VERIFY_PY_PATH, "utf-8");

export const LEAD_MODEL = "gemini-4-argon";
export const MANAGED_AGENT = "antigravity-preview-09-2026";
export const GITHUB_API_CREDENTIAL_ID = "bugreel-github-api";
export const GITHUB_GIT_CREDENTIAL_ID = "bugreel-github-git";

export const ANALYSIS_JSON_SCHEMA = {
  type: "object",
  properties: {
    bug_timestamp: {
      type: "string",
      description: "Timestamp where the bug becomes visible in M:SS format, e.g. '0:07'.",
    },
    steps: {
      type: "array",
      description: "Ordered user actions leading up to the bug.",
      items: {
        type: "object",
        properties: {
          t: { type: "string", description: "Timestamp in M:SS format, e.g. '0:02'." },
          action: {
            type: "string",
            enum: ["type", "click", "press", "reload", "navigate"],
          },
          target: {
            type: "string",
            description: "UI element or selector description interacted with.",
          },
          value: {
            type: "string",
            description: "Typed text or key pressed, if applicable.",
          },
        },
        required: ["t", "action", "target"],
      },
    },
    expected: {
      type: "string",
      description: "Expected correct application behavior.",
    },
    actual: {
      type: "string",
      description: "Actual buggy behavior observed in the video.",
    },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
    },
  },
  required: ["bug_timestamp", "steps", "expected", "actual", "confidence"],
};

/**
 * Extracts a JSON object from raw model/agent text output (handles fenced code blocks or surrounding prose).
 * @param {string} rawText
 * @returns {any}
 */
export function extractJsonObject(rawText) {
  if (!rawText || typeof rawText !== "string") {
    throw new Error("Empty model output");
  }
  const trimmed = rawText.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // Try extracting from ```json ... ``` fence
    const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenceMatch && fenceMatch[1]) {
      try {
        return JSON.parse(fenceMatch[1].trim());
      } catch {
        // continue to brace matching
      }
    }
    // Find outermost { ... }
    const firstBrace = trimmed.indexOf("{");
    const lastBrace = trimmed.lastIndexOf("}");
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1));
    }
    throw new Error(`Could not parse JSON from output: ${trimmed.slice(0, 200)}`);
  }
}

/**
 * Validates AnalysisResult contract per AGENTS.md 5.4.
 * @param {any} obj
 * @returns {import("./types").AnalysisResult}
 */
export function validateAnalysisResult(obj) {
  if (!obj || typeof obj !== "object") {
    throw new Error("AnalysisResult must be a JSON object");
  }
  if (typeof obj.bug_timestamp !== "string" || !obj.bug_timestamp.trim()) {
    throw new Error("AnalysisResult.bug_timestamp is required");
  }
  if (!Array.isArray(obj.steps)) {
    throw new Error("AnalysisResult.steps must be an array");
  }
  const validActions = new Set(["type", "click", "press", "reload", "navigate"]);
  const steps = obj.steps.map((s, idx) => {
    if (!s || typeof s !== "object") {
      throw new Error(`Step ${idx} must be an object`);
    }
    const action = validActions.has(s.action) ? s.action : "click";
    const step = {
      t: typeof s.t === "string" && s.t.trim() ? s.t.trim() : "0:00",
      action,
      target: typeof s.target === "string" ? s.target : String(s.target || ""),
    };
    if (s.value !== undefined && s.value !== null && String(s.value) !== "") {
      step.value = String(s.value);
    }
    return step;
  });
  if (typeof obj.expected !== "string" || !obj.expected.trim()) {
    throw new Error("AnalysisResult.expected is required");
  }
  if (typeof obj.actual !== "string" || !obj.actual.trim()) {
    throw new Error("AnalysisResult.actual is required");
  }
  const validConf = new Set(["high", "medium", "low"]);
  const confidence = validConf.has(obj.confidence) ? obj.confidence : "medium";

  return {
    bug_timestamp: obj.bug_timestamp.trim(),
    steps,
    expected: obj.expected.trim(),
    actual: obj.actual.trim(),
    confidence,
  };
}

/**
 * Validates ReproduceResult contract per AGENTS.md 5.4 and cross-checks test counts.
 * A bug counts as reproduced ONLY if total > 0 and passed < total (at least one failing test).
 * @param {any} obj
 */
export function validateReproduceResult(obj) {
  if (!obj || typeof obj !== "object") {
    throw new Error("ReproduceResult must be a JSON object");
  }
  const validStatus = new Set(["reproduced", "not_reproduced", "error"]);
  let status = validStatus.has(obj.status) ? obj.status : "error";
  const repro_test = typeof obj.repro_test === "string" ? obj.repro_test : "";
  const rawPassed = Number(obj.tests?.passed ?? 0);
  const rawTotal = Number(obj.tests?.total ?? 0);
  const passed = Number.isFinite(rawPassed) && rawPassed >= 0 ? rawPassed : 0;
  const total = Number.isFinite(rawTotal) && rawTotal >= 0 ? rawTotal : 0;

  let notes = obj.notes ? String(obj.notes) : undefined;
  if (status === "reproduced") {
    if (total <= 0) {
      status = "error";
      notes = notes || "Playwright ran 0 tests during reproduction.";
    } else if (passed >= total) {
      status = "not_reproduced";
      notes =
        notes ||
        "Reproduction test passed instead of failing; bug was not reproduced.";
    }
  }

  const result = {
    status,
    repro_test,
    tests: { passed, total },
  };
  if (obj.failure) result.failure = String(obj.failure);
  if (notes) result.notes = notes;
  return result;
}

/**
 * Server-side guard: inspects unified diff and returns true if any file under tests/
 * other than tests/repro.spec.js was modified.
 * @param {string} diff
 * @returns {boolean}
 */
export function detectTestFilesChanged(diff) {
  if (!diff || typeof diff !== "string") return false;
  const touchedPaths = new Set();
  const lines = diff.split(/\r?\n/);
  for (const line of lines) {
    const gitMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (gitMatch) {
      touchedPaths.add(gitMatch[1].trim());
      touchedPaths.add(gitMatch[2].trim());
      continue;
    }
    const headerMatch = line.match(/^(?:\+\+\+|---) (?:a\/|b\/)?(.+)$/);
    if (headerMatch) {
      const p = headerMatch[1].trim().split("\t")[0];
      if (p && p !== "/dev/null") {
        touchedPaths.add(p.replace(/^\/+/, ""));
      }
    }
  }

  for (const filePath of touchedPaths) {
    const normalized = filePath.replace(/\\/g, "/").replace(/^\.\//, "");
    if (
      normalized.startsWith("tests/") &&
      normalized !== "tests/repro.spec.js"
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Validates FixResult contract per AGENTS.md 5.4, cross-checks test counts
 * (passed === total && total > 0), and applies server-side test_files_changed guard.
 * @param {any} obj
 * @param {string} reportId
 */
export function validateFixResult(obj, reportId) {
  if (!obj || typeof obj !== "object") {
    throw new Error("FixResult must be a JSON object");
  }
  const attempts = Number(obj.attempts ?? 1);
  const rawPassed = Number(obj.tests?.passed ?? 0);
  const rawTotal = Number(obj.tests?.total ?? 0);
  const passed = Number.isFinite(rawPassed) && rawPassed >= 0 ? rawPassed : 0;
  const total = Number.isFinite(rawTotal) && rawTotal >= 0 ? rawTotal : 0;
  const testsAllPassed = total > 0 && passed === total;
  const status = obj.status === "fixed" && testsAllPassed ? "fixed" : "failed";

  const diff = typeof obj.diff === "string" ? obj.diff : "";
  const branch =
    typeof obj.branch === "string" && obj.branch.trim()
      ? obj.branch.trim()
      : `bugreel/fix-${reportId}`;
  const serverDetectedTestChange = detectTestFilesChanged(diff);

  return {
    status,
    attempts: Number.isFinite(attempts) && attempts > 0 ? attempts : 1,
    tests: { passed, total },
    branch,
    diff,
    test_files_changed: Boolean(obj.test_files_changed) || serverDetectedTestChange,
    summary:
      typeof obj.summary === "string" && obj.summary.trim()
        ? obj.summary.trim()
        : status === "fixed"
        ? "Fixed the reported issue verified by Playwright reproduction test."
        : "Failed to verify all Playwright tests.",
  };
}

/**
 * Builds the exact Call #1 (reproduce) prompt per AGENTS.md 5.5.
 */
export function buildReproducePrompt({ repoUrl, analysis, note }) {
  return `Repository: ${repoUrl} (branch main). It is a static web app. Serve it with: npx --yes serve -l 4173 .
A non-developer reported a bug with a screen recording. Video analysis:
${JSON.stringify(analysis, null, 2)}
Reporter note: "${note || ""}"

1. Clone the repository. Install @playwright/test and Chromium.
2. Start the static server in the background.
3. Write tests/repro.spec.js that performs the steps exactly and asserts the EXPECTED behaviour
   (not the actual one). Use stable selectors.
4. Create verify.py with the content below, run the test with the JSON reporter
   (npx playwright test tests/repro.spec.js --reporter=json > report.json), then run: python3 verify.py report.json
5. Do NOT modify application code.
The bug counts as reproduced only if the test FAILS on the assertion of the expected behaviour.

verify.py:
${VERIFY_PY_CONTENT}

Return ONLY a JSON object:
{"status":"reproduced"|"not_reproduced"|"error","repro_test":"<file content>","tests":{"passed":n,"total":m},"failure":"<assertion message>","notes":"<short>"}`;
}

/**
 * Builds the exact Call #2 (fix) prompt per AGENTS.md 5.5.
 */
export function buildFixPrompt({ repoUrl, reproTest, reportId }) {
  return `Repository: ${repoUrl} (branch main). Serve with: npx --yes serve -l 4173 .
This test reproduces a reported bug and currently fails:
--- tests/repro.spec.js ---
${reproTest}
---
Fix the APPLICATION code so that this test and any existing tests pass.
Never edit, weaken, skip or delete tests. Keep the change minimal.
Loop: run tests → read failures → fix → re-run, until everything passes or 5 attempts.
Use verify.py (content below) on the Playwright JSON report as the pass/fail signal.
When everything passes: create branch bugreel/fix-${reportId}, commit the fix and tests/repro.spec.js,
push using the provided GitHub credential. Do NOT open a pull request.

verify.py:
${VERIFY_PY_CONTENT}

Return ONLY a JSON object:
{"status":"fixed"|"failed","attempts":n,"tests":{"passed":n,"total":m},"branch":"bugreel/fix-${reportId}","diff":"<unified diff>","test_files_changed":false,"summary":"<one paragraph>"}`;
}

function getGenAIClient() {
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY environment variable is not set. Configure it in Secret Manager or environment."
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: { timeout: 20 * 60 * 1000 }, // 20 min timeout per AGENTS.md 5.6
  });
}

let credentialsRegistered = false;

/**
 * Upserts a single credential in the Gemini Credentials API.
 * @param {GoogleGenAI} ai
 * @param {object} spec
 */
async function upsertCredential(ai, spec) {
  try {
    await ai.credentials.create(spec);
    return spec.id;
  } catch (err) {
    const msg = String(err?.message || err || "");
    if (/already exists|409|ALREADY_EXISTS/i.test(msg)) {
      try {
        await ai.credentials.delete(spec.id);
        await ai.credentials.create(spec);
      } catch {
        // Existing credential can still be referenced by ID
      }
      return spec.id;
    }
    return null;
  }
}

/**
 * Registers GITHUB_TOKEN in the Gemini Credentials API so it never enters the model context
 * or request payload (`transform` headers).
 * - `bugreel-github-api`: Bearer token for `api.github.com`
 * - `bugreel-github-git`: Basic auth (`x-oauth-basic:<token>`) for `git push` to `github.com`
 * @param {GoogleGenAI} ai
 * @returns {Promise<{ apiCredentialId: string|null, gitCredentialId: string|null }|null>}
 */
export async function ensureGithubCredentials(ai) {
  const githubToken = process.env.GITHUB_TOKEN;
  if (!githubToken || !ai?.credentials) return null;
  if (credentialsRegistered) {
    return {
      apiCredentialId: GITHUB_API_CREDENTIAL_ID,
      gitCredentialId: GITHUB_GIT_CREDENTIAL_ID,
    };
  }

  const basicToken = Buffer.from(`x-oauth-basic:${githubToken}`).toString(
    "base64"
  );

  const apiCredentialId = await upsertCredential(ai, {
    id: GITHUB_API_CREDENTIAL_ID,
    type: "bearer_token",
    token: githubToken,
  });

  const gitCredentialId = await upsertCredential(ai, {
    id: GITHUB_GIT_CREDENTIAL_ID,
    type: "bearer_token",
    token: basicToken,
    header_name: "Authorization",
    prefix: "Basic ",
  });

  if (apiCredentialId || gitCredentialId) {
    credentialsRegistered = true;
  }

  return { apiCredentialId, gitCredentialId };
}

/**
 * Builds the remote sandbox environment configuration with an explicit network allowlist
 * (no wildcard `*`) and Gemini Credentials API references (never inline raw tokens).
 * @param {{ apiCredentialId?: string|null, gitCredentialId?: string|null }|null} [credentials]
 */
export function buildAgentEnvironment(credentials = null) {
  const githubRule = { domain: "github.com" };
  if (credentials?.gitCredentialId) {
    githubRule.credential = credentials.gitCredentialId;
  }

  const apiGithubRule = { domain: "api.github.com" };
  if (credentials?.apiCredentialId) {
    apiGithubRule.credential = credentials.apiCredentialId;
  }

  const allowlist = [
    githubRule,
    apiGithubRule,
    { domain: "codeload.github.com" },
    { domain: "objects.githubusercontent.com" },
    { domain: "registry.npmjs.org" },
    { domain: "*.npmjs.org" },
    { domain: "playwright.azureedge.net" },
    { domain: "cdn.playwright.dev" },
    { domain: "playwright-akamai.azureedge.net" },
    { domain: "playwright-verizon.azureedge.net" },
  ];

  return {
    type: "remote",
    network: { allowlist },
  };
}

/**
 * Polls an interaction until it reaches a terminal state.
 * @param {GoogleGenAI} ai
 * @param {any} initialInteraction
 * @param {(status: string) => void} [onTick]
 */
async function pollInteractionToCompletion(ai, initialInteraction, onTick) {
  let interaction = initialInteraction;
  const maxWaitMs = 18 * 60 * 1000; // 18 minutes max
  const start = Date.now();

  while (
    interaction.status === "in_progress" ||
    interaction.status === "queued"
  ) {
    if (Date.now() - start > maxWaitMs) {
      throw new Error(`Interaction ${interaction.id} timed out after 18 minutes.`);
    }
    await new Promise((r) => setTimeout(r, 4000));
    interaction = await ai.interactions.get(interaction.id);
    if (onTick) onTick(interaction.status);
  }

  if (interaction.status === "failed" || interaction.status === "cancelled") {
    const errDetail =
      interaction.error?.message ||
      JSON.stringify(interaction.error || interaction.status);
    throw new Error(`Interaction ${interaction.status}: ${errDetail}`);
  }

  return interaction;
}

/**
 * [A] Analyzes the uploaded screen-recorded bug video with gemini-4-argon.
 * @param {object} report
 * @param {GoogleGenAI} [aiClient]
 */
export async function analyzeVideo(report, aiClient) {
  const ai = aiClient || getGenAIClient();

  let videoPart;
  try {
    const uploaded = await ai.files.upload({
      file: report.videoPath,
      config: { mimeType: report.videoMimeType || "video/mp4" },
    });

    let fileInfo = await ai.files.get({ name: uploaded.name });
    const uploadStart = Date.now();
    while (fileInfo.state === "PROCESSING") {
      if (Date.now() - uploadStart > 120000) {
        throw new Error("Timed out waiting for Gemini Files API video processing.");
      }
      await new Promise((r) => setTimeout(r, 2000));
      fileInfo = await ai.files.get({ name: uploaded.name });
    }
    if (fileInfo.state === "FAILED") {
      throw new Error("Gemini Files API failed to process the uploaded video.");
    }
    videoPart = {
      type: "video",
      uri: fileInfo.uri || uploaded.uri,
      mime_type: fileInfo.mimeType || uploaded.mimeType || report.videoMimeType || "video/mp4",
    };
  } catch (uploadErr) {
    // Fallback to inline base64 video for small files if Files API fails
    const rawBytes = fs.readFileSync(report.videoPath);
    videoPart = {
      type: "video",
      data: rawBytes.toString("base64"),
      mime_type: report.videoMimeType || "video/mp4",
    };
  }

  const promptText = `You are analyzing a screen recording of a web application bug reported by a user.
Target repository: ${report.repoUrl}
Reporter note: "${report.note || "(no note provided)"}"

Watch the video carefully and extract:
1. "bug_timestamp": exact timestamp ("M:SS") when the bug occurs or becomes visible on screen.
2. "steps": every user interaction in chronological order (timestamp "t", "action" in ["type","click","press","reload","navigate"], "target" element description or selector, and optional "value" such as text typed or key pressed).
3. "expected": what the UI should have shown or done after those steps.
4. "actual": what the UI actually showed or did in the video.
5. "confidence": "high", "medium", or "low".

Return ONLY valid JSON matching the schema.`;

  let lastError;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const interaction = await ai.interactions.create({
        model: LEAD_MODEL,
        input: [videoPart, { type: "text", text: promptText }],
        generation_config: { thinking_level: "medium" },
        response_format: {
          type: "text",
          mime_type: "application/json",
          schema: ANALYSIS_JSON_SCHEMA,
        },
      });

      const finalInteraction =
        interaction.status === "in_progress" || interaction.status === "queued"
          ? await pollInteractionToCompletion(ai, interaction)
          : interaction;

      const parsed = extractJsonObject(finalInteraction.output_text);
      return validateAnalysisResult(parsed);
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(
    `Video analysis failed after retry: ${lastError?.message || lastError}`
  );
}

/**
 * [B] Runs Managed Agent Call #1 (reproduce) in the remote sandbox.
 * @param {object} report
 * @param {GoogleGenAI} [aiClient]
 */
export async function reproduceBug(report, aiClient) {
  const ai = aiClient || getGenAIClient();
  const credentials = await ensureGithubCredentials(ai);
  const environment = buildAgentEnvironment(credentials);
  const prompt = buildReproducePrompt({
    repoUrl: report.repoUrl,
    analysis: report.analysis,
    note: report.note,
  });

  const initial = await ai.interactions.create({
    agent: MANAGED_AGENT,
    agent_config: { type: "antigravity", model: LEAD_MODEL },
    input: prompt,
    environment,
    background: true,
  });

  let completed = await pollInteractionToCompletion(ai, initial);

  let parsed;
  try {
    parsed = extractJsonObject(completed.output_text);
  } catch {
    // Retry once on invalid JSON per AGENTS.md 5.4
    const retryTurn = await ai.interactions.create({
      agent: MANAGED_AGENT,
      agent_config: { type: "antigravity", model: LEAD_MODEL },
      input:
        'Your previous response was not valid JSON. Return ONLY the single JSON object: {"status":"reproduced"|"not_reproduced"|"error","repro_test":"<file content>","tests":{"passed":n,"total":m},"failure":"<assertion message>","notes":"<short>"}',
      environment: completed.environment_id || environment,
      previous_interaction_id: completed.id,
      background: true,
    });
    completed = await pollInteractionToCompletion(ai, retryTurn);
    parsed = extractJsonObject(completed.output_text);
  }

  const reproduceResult = validateReproduceResult(parsed);
  return {
    reproduceResult,
    environmentId: completed.environment_id || initial.environment_id || null,
    interactionId: completed.id,
  };
}

/**
 * [C] Runs Managed Agent Call #2 (fix) in the remote sandbox.
 * @param {object} report
 * @param {{ environmentId?: string|null, interactionId?: string|null }} context
 * @param {GoogleGenAI} [aiClient]
 */
export async function fixBug(report, context = {}, aiClient) {
  const ai = aiClient || getGenAIClient();
  const credentials = await ensureGithubCredentials(ai);
  const defaultEnv = buildAgentEnvironment(credentials);
  const prompt = buildFixPrompt({
    repoUrl: report.repoUrl,
    reproTest: report.reproduce?.repro_test || "",
    reportId: report.id,
  });

  const createParams = {
    agent: MANAGED_AGENT,
    agent_config: { type: "antigravity", model: LEAD_MODEL },
    input: prompt,
    background: true,
    environment: context.environmentId || defaultEnv,
  };
  if (context.environmentId && context.interactionId) {
    createParams.previous_interaction_id = context.interactionId;
  }

  const initial = await ai.interactions.create(createParams);
  let completed = await pollInteractionToCompletion(ai, initial);

  let parsed;
  try {
    parsed = extractJsonObject(completed.output_text);
  } catch {
    // Retry once on invalid JSON per AGENTS.md 5.4
    const retryTurn = await ai.interactions.create({
      agent: MANAGED_AGENT,
      agent_config: { type: "antigravity", model: LEAD_MODEL },
      input: `Your previous response was not valid JSON. Return ONLY the single JSON object: {"status":"fixed"|"failed","attempts":1,"tests":{"passed":1,"total":1},"branch":"bugreel/fix-${report.id}","diff":"<unified diff>","test_files_changed":false,"summary":"<one paragraph>"}`,
      environment:
        completed.environment_id || context.environmentId || defaultEnv,
      previous_interaction_id: completed.id,
      background: true,
    });
    completed = await pollInteractionToCompletion(ai, retryTurn);
    parsed = extractJsonObject(completed.output_text);
  }

  return validateFixResult(parsed, report.id);
}

/**
 * Parses GitHub { owner, repo } from a validated GitHub repository URL.
 * @param {string} repoUrl
 */
export function parseGithubOwnerRepo(repoUrl) {
  const parsed = new URL(repoUrl);
  const parts = parsed.pathname
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .split("/");
  return { owner: parts[0], repo: parts[1] };
}

/**
 * Parses a unified diff string into per-file patches and hunks.
 * @param {string} diffText
 */
export function parseUnifiedDiff(diffText) {
  if (!diffText || typeof diffText !== "string") return [];
  const files = [];
  const lines = diffText.split(/\r?\n/);
  let currentFile = null;
  let currentHunk = null;

  for (const line of lines) {
    const gitMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (gitMatch) {
      currentFile = {
        oldPath: gitMatch[1].trim(),
        newPath: gitMatch[2].trim(),
        hunks: [],
      };
      files.push(currentFile);
      currentHunk = null;
      continue;
    }

    const oldHeader = line.match(/^--- (?:a\/)?(.+)$/);
    if (oldHeader && !line.startsWith("--- /dev/null")) {
      const p = oldHeader[1].trim().split("\t")[0];
      if (!currentFile) {
        currentFile = { oldPath: p, newPath: p, hunks: [] };
        files.push(currentFile);
      } else {
        currentFile.oldPath = p;
      }
      continue;
    }

    const newHeader = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
    if (newHeader && !line.startsWith("+++ /dev/null")) {
      const p = newHeader[1].trim().split("\t")[0];
      if (!currentFile) {
        currentFile = { oldPath: p, newPath: p, hunks: [] };
        files.push(currentFile);
      } else {
        currentFile.newPath = p;
      }
      continue;
    }

    const hunkHeader = line.match(
      /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/
    );
    if (hunkHeader && currentFile) {
      currentHunk = {
        oldStart: Number(hunkHeader[1]),
        oldLines: hunkHeader[2] !== undefined ? Number(hunkHeader[2]) : 1,
        newStart: Number(hunkHeader[3]),
        newLines: hunkHeader[4] !== undefined ? Number(hunkHeader[4]) : 1,
        lines: [],
      };
      currentFile.hunks.push(currentHunk);
      continue;
    }

    if (
      currentHunk &&
      (line.startsWith(" ") || line.startsWith("-") || line.startsWith("+"))
    ) {
      currentHunk.lines.push(line);
    }
  }

  return files;
}

/**
 * Applies parsed unified diff hunks to an original file string.
 * @param {string} originalContent
 * @param {Array<{ oldStart: number, lines: string[] }>} hunks
 */
export function applyUnifiedDiffToContent(originalContent, hunks) {
  const hasCrlf = /\r\n/.test(originalContent);
  const eol = hasCrlf ? "\r\n" : "\n";
  const fileLines = originalContent ? originalContent.split(/\r?\n/) : [];
  let lineOffset = 0;

  for (const hunk of hunks) {
    const oldChunk = hunk.lines
      .filter((l) => l.startsWith(" ") || l.startsWith("-"))
      .map((l) => l.slice(1));
    const newChunk = hunk.lines
      .filter((l) => l.startsWith(" ") || l.startsWith("+"))
      .map((l) => l.slice(1));

    const expectedIdx = Math.max(0, hunk.oldStart - 1 + lineOffset);

    const matchesAt = (idx) => {
      if (idx < 0 || idx + oldChunk.length > fileLines.length) return false;
      for (let i = 0; i < oldChunk.length; i++) {
        if (fileLines[idx + i].trim() !== oldChunk[i].trim()) return false;
      }
      return true;
    };

    let targetIdx = -1;
    if (oldChunk.length === 0) {
      targetIdx = Math.min(expectedIdx, fileLines.length);
    } else if (matchesAt(expectedIdx)) {
      targetIdx = expectedIdx;
    } else {
      // Search nearby lines first, then full file
      for (let delta = 1; delta <= fileLines.length; delta++) {
        if (matchesAt(expectedIdx - delta)) {
          targetIdx = expectedIdx - delta;
          break;
        }
        if (matchesAt(expectedIdx + delta)) {
          targetIdx = expectedIdx + delta;
          break;
        }
      }
    }

    if (targetIdx === -1) {
      // Fallback: match only the removed ('-') lines if context lines differed
      const removedOnly = hunk.lines
        .filter((l) => l.startsWith("-"))
        .map((l) => l.slice(1));
      const addedOnly = hunk.lines
        .filter((l) => l.startsWith("+"))
        .map((l) => l.slice(1));
      if (removedOnly.length > 0) {
        for (let idx = 0; idx <= fileLines.length - removedOnly.length; idx++) {
          let ok = true;
          for (let j = 0; j < removedOnly.length; j++) {
            if (fileLines[idx + j].trim() !== removedOnly[j].trim()) {
              ok = false;
              break;
            }
          }
          if (ok) {
            fileLines.splice(idx, removedOnly.length, ...addedOnly);
            lineOffset += addedOnly.length - removedOnly.length;
            targetIdx = idx;
            break;
          }
        }
      }
      if (targetIdx === -1) {
        throw new Error("Failed to apply unified diff hunk to target file.");
      }
    } else {
      fileLines.splice(targetIdx, oldChunk.length, ...newChunk);
      lineOffset += newChunk.length - oldChunk.length;
    }
  }

  return fileLines.join(eol);
}

/**
 * Ensures the fix branch (`bugreel/fix-<id>`) exists on GitHub with the verified diff
 * and reproduction test (`tests/repro.spec.js`). If the sandbox agent already pushed
 * the branch, this is a no-op; otherwise it pushes the commit via GitHub Git Data API.
 * @param {object} report
 */
export async function ensureBranchOnGithub(report) {
  const token = process.env.GITHUB_TOKEN;
  if (!token || !report?.fix?.branch || report.fix.status !== "fixed") {
    return false;
  }

  const { owner, repo } = parseGithubOwnerRepo(report.repoUrl);
  const branchName = report.fix.branch.replace(/^refs\/heads\//, "");
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "BugReel-Agent",
  };
  const apiBase = `https://api.github.com/repos/${encodeURIComponent(
    owner
  )}/${encodeURIComponent(repo)}`;

  // 1. Check if branch already exists on GitHub
  const branchRes = await fetch(
    `${apiBase}/git/ref/heads/${ branchName.split("/").map(encodeURIComponent).join("/") }`,
    { headers }
  );
  if (branchRes.ok) {
    return true;
  }

  // 2. Get base branch ('main') SHA
  const mainRefRes = await fetch(`${apiBase}/git/ref/heads/main`, { headers });
  if (!mainRefRes.ok) {
    throw new Error(`Failed to fetch main branch ref (${mainRefRes.status}).`);
  }
  const mainRefData = await mainRefRes.json();
  const baseSha = mainRefData.object?.sha;
  if (!baseSha) {
    throw new Error("Could not resolve base SHA for main branch.");
  }

  // 3. Build tree entries from report.fix.diff + report.reproduce.repro_test
  const treeEntries = [];
  const filePatches = parseUnifiedDiff(report.fix.diff || "");

  for (const patch of filePatches) {
    const targetPath = (patch.newPath || patch.oldPath || "")
      .replace(/^\/+/, "")
      .replace(/^\.\//, "");
    if (
      !targetPath ||
      targetPath === "/dev/null" ||
      targetPath === "tests/repro.spec.js"
    ) {
      continue;
    }

    let originalText = "";
    const fileRes = await fetch(
      `${apiBase}/contents/${targetPath
        .split("/")
        .map(encodeURIComponent)
        .join("/")}?ref=main`,
      { headers }
    );
    if (fileRes.ok) {
      const fileData = await fileRes.json();
      if (fileData.content) {
        originalText = Buffer.from(fileData.content, "base64").toString("utf8");
      }
    }

    const updatedText = applyUnifiedDiffToContent(originalText, patch.hunks);
    treeEntries.push({
      path: targetPath,
      mode: "100644",
      type: "blob",
      content: updatedText,
    });
  }

  if (report.reproduce?.repro_test) {
    treeEntries.push({
      path: "tests/repro.spec.js",
      mode: "100644",
      type: "blob",
      content: report.reproduce.repro_test,
    });
  }

  if (treeEntries.length === 0) {
    throw new Error("No file changes found in diff to push branch.");
  }

  // 4. Create Git tree
  const treeRes = await fetch(`${apiBase}/git/trees`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      base_tree: baseSha,
      tree: treeEntries,
    }),
  });
  if (!treeRes.ok) {
    const errBody = await treeRes.text();
    throw new Error(`Failed to create Git tree (${treeRes.status}): ${errBody}`);
  }
  const treeData = await treeRes.json();

  // 5. Create Git commit
  const commitRes = await fetch(`${apiBase}/git/commits`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      message: `fix: resolve bug ${report.id} verified by BugReel`,
      tree: treeData.sha,
      parents: [baseSha],
    }),
  });
  if (!commitRes.ok) {
    const errBody = await commitRes.text();
    throw new Error(
      `Failed to create Git commit (${commitRes.status}): ${errBody}`
    );
  }
  const commitData = await commitRes.json();

  // 6. Create branch reference
  const createRefRes = await fetch(`${apiBase}/git/refs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      ref: `refs/heads/${branchName}`,
      sha: commitData.sha,
    }),
  });
  if (!createRefRes.ok && createRefRes.status !== 422) {
    const errBody = await createRefRes.text();
    throw new Error(
      `Failed to create branch ${branchName} (${createRefRes.status}): ${errBody}`
    );
  }

  return true;
}

/**
 * [D] Opens a GitHub Pull Request for an approved fixed report per AGENTS.md 5.9.
 * @param {object} report
 * @param {string} reviewPageUrl
 */
export async function createGithubPullRequest(report, reviewPageUrl) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    throw new Error(
      "GITHUB_TOKEN is not configured. Set GITHUB_TOKEN in Secret Manager or download the diff instead."
    );
  }
  if (
    !report.fix ||
    report.fix.status !== "fixed" ||
    !(report.fix.tests?.total > 0) ||
    report.fix.tests?.passed !== report.fix.tests?.total
  ) {
    throw new Error(
      "Cannot open a pull request before the bug is fixed and all tests pass."
    );
  }

  // Ensure the fix branch exists on GitHub before opening the PR
  await ensureBranchOnGithub(report);

  const { owner, repo } = parseGithubOwnerRepo(report.repoUrl);
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "BugReel-Agent",
  };

  // First sentence of FixResult.summary as PR title per AGENTS.md 5.9
  const rawSummary = (report.fix.summary || "").trim();
  const firstSentenceMatch = rawSummary.match(/^(.+?[.!?])(?:\s|$)/);
  const title = (
    firstSentenceMatch ? firstSentenceMatch[1] : rawSummary || `Fix bug (${report.id})`
  ).slice(0, 120);

  const stepsMarkdown = (report.analysis?.steps || [])
    .map(
      (s, i) =>
        `${i + 1}. \`[${s.t}]\` **${s.action}** on \`${s.target}\`${
          s.value ? ` — value: \`${s.value}\`` : ""
        }`
    )
    .join("\n");

  const body = [
    "## Summary",
    report.fix.summary,
    "",
    "## Video Bug Analysis (`gemini-4-argon`)",
    `- **Bug Timestamp:** \`${report.analysis?.bug_timestamp || "N/A"}\``,
    `- **Reporter Note:** ${report.note ? `> ${report.note}` : "_(none)_"}`,
    `- **Expected:** ${report.analysis?.expected || "N/A"}`,
    `- **Actual:** ${report.analysis?.actual || "N/A"}`,
    "",
    "### Reproduction Steps",
    stepsMarkdown || "_(no steps extracted)_",
    "",
    "## Verification Loop Results",
    `- **Reproduce (RED):** \`${report.reproduce?.tests?.passed ?? 0} / ${
      report.reproduce?.tests?.total ?? 1
    } passed\` (${report.reproduce?.failure || "Failed as expected"})`,
    `- **Fix (GREEN):** \`${report.fix.tests.passed} / ${report.fix.tests.total} passed\` in **${report.fix.attempts}** attempt(s)`,
    `- **Test Files Modified Outside \`tests/repro.spec.js\`:** \`${report.fix.test_files_changed}\``,
    "",
    "---",
    `*Reported via BugReel video* — [View Developer Review Page](${reviewPageUrl})`,
  ].join("\n");

  const prRes = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(
      repo
    )}/pulls`,
    {
      method: "POST",
      headers,
      body: JSON.stringify({
        title,
        head: report.fix.branch,
        base: "main",
        body,
      }),
    }
  );

  const prData = await prRes.json().catch(() => ({}));
  if (!prRes.ok) {
    // If a PR already exists for this branch, look it up and return its URL
    if (prRes.status === 422) {
      const existingRes = await fetch(
        `https://api.github.com/repos/${encodeURIComponent(
          owner
        )}/${encodeURIComponent(repo)}/pulls?head=${encodeURIComponent(
          `${owner}:${report.fix.branch}`
        )}&state=open`,
        { headers }
      );
      const existingList = await existingRes.json().catch(() => []);
      if (Array.isArray(existingList) && existingList[0]?.html_url) {
        return existingList[0].html_url;
      }
    }
    throw new Error(
      prData.message || `GitHub API returned ${prRes.status} when creating PR.`
    );
  }

  return prData.html_url;
}

/**
 * Orchestrates the full [A] -> [B] -> [C] background pipeline for a report.
 * @param {object} report
 * @param {(reportId: string, event: any) => void} emitEvent
 * @param {object} [overrides] - Optional function overrides for testing
 */
export async function runBugReelPipeline(report, emitEvent, overrides = {}) {
  const analyzeFn = overrides.analyzeVideo || analyzeVideo;
  const reproduceFn = overrides.reproduceBug || reproduceBug;
  const fixFn = overrides.fixBug || fixBug;

  const toPublicReport = (r) => {
    const { videoPath, ...rest } = r;
    return rest;
  };

  const updateStage = (stage, message) => {
    report.stage = stage;
    emitEvent(report.id, { type: "stage", stage, message });
    emitEvent(report.id, { type: "result", report: toPublicReport(report) });
  };

  try {
    // [A] Video Analysis
    updateStage("analyzing", "Analyzing bug video with gemini-4-argon...");
    const analysis = await analyzeFn(report);
    report.analysis = analysis;
    emitEvent(report.id, { type: "analysis", analysis });
    updateStage(
      "analyzed",
      `Bug detected at ${analysis.bug_timestamp} (${analysis.steps.length} steps extracted).`
    );

    // [B] Managed Agent Call #1: Reproduce (must fail -> RED)
    updateStage(
      "reproducing",
      "Cloning repository and running Playwright reproduction test in sandbox..."
    );
    const {
      reproduceResult: rawReproduceResult,
      environmentId,
      interactionId,
    } = await reproduceFn(report);
    const reproduceResult = validateReproduceResult(rawReproduceResult);
    report.reproduce = reproduceResult;
    emitEvent(report.id, {
      type: "tests",
      passed: reproduceResult.tests.passed,
      total: reproduceResult.tests.total,
    });

    if (reproduceResult.status !== "reproduced") {
      report.stage =
        reproduceResult.status === "not_reproduced"
          ? "not_reproduced"
          : "error";
      if (reproduceResult.status === "error") {
        report.error =
          reproduceResult.failure ||
          reproduceResult.notes ||
          "Reproduction test encountered an error.";
      }
      emitEvent(report.id, {
        type: "stage",
        stage: report.stage,
        message:
          report.stage === "not_reproduced"
            ? "Could not reproduce — no fix attempted."
            : report.error,
      });
      emitEvent(report.id, { type: "result", report: toPublicReport(report) });
      return report;
    }

    updateStage(
      "reproduced",
      `Bug reproduced (RED): ${reproduceResult.tests.passed}/${reproduceResult.tests.total} passed.`
    );

    // [C] Managed Agent Call #2: Fix loop until GREEN
    updateStage(
      "fixing",
      "Fixing application code and verifying all Playwright tests..."
    );
    const rawFixResult = await fixFn(report, { environmentId, interactionId });
    const fixResult = validateFixResult(rawFixResult, report.id);
    report.fix = fixResult;
    emitEvent(report.id, {
      type: "tests",
      passed: fixResult.tests.passed,
      total: fixResult.tests.total,
    });

    if (fixResult.status === "fixed") {
      try {
        await ensureBranchOnGithub(report);
      } catch (branchErr) {
        console.warn(
          `Branch push fallback deferred until PR approval for ${report.id}:`,
          branchErr?.message || branchErr
        );
      }
      updateStage(
        "fixed",
        `Fix verified (GREEN): ${fixResult.tests.passed}/${fixResult.tests.total} passed in ${fixResult.attempts} attempt(s). Ready for approval.`
      );
    } else {
      report.stage = "fix_failed";
      report.error = fixResult.summary || "Failed to pass all tests within 5 attempts.";
      emitEvent(report.id, {
        type: "stage",
        stage: "fix_failed",
        message: report.error,
      });
      emitEvent(report.id, { type: "result", report: toPublicReport(report) });
    }

    return report;
  } catch (err) {
    const message = err?.message || String(err);
    report.stage = "error";
    report.error = message;
    emitEvent(report.id, { type: "error", message });
    emitEvent(report.id, { type: "stage", stage: "error", message });
    emitEvent(report.id, { type: "result", report: toPublicReport(report) });
    return report;
  }
}
