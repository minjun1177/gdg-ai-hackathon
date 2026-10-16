# AGENTS.md — BugReel (for the coding agent)

You are the coding agent for a solo developer at the **Google DeepMind AI Hackathon** (Seoul, 2026-10-16).
This file is the single source of truth: the background, the decisions already made, the rules, the
architecture, and the build order. Read all of it before writing code.

**Language:** talk to the user in **Korean**. Write code, comments, commit messages, README and all
submission text in **English**.

---

## 1. Situation

| Item | Detail |
|---|---|
| Event | Google DeepMind AI Hackathon, Google for Startups Campus Seoul |
| Format | Solo, **4-hour build: 11:20–15:20 KST**, judged by Google / DeepMind engineers |
| Track | 4 — Open innovation: autonomous agents and developer tools |
| User's strengths | Backend in **Node.js**, tooling and scripts in **Python** |
| Accounts | Organizer-provided `@gcplab.me` Google account with a billed GCP project (ID given at kickoff). Same account works for AI Studio and Antigravity. Everything is **deleted when the event ends** |
| Region | `asia-northeast3` (Seoul) unless the user says otherwise |

---

## 2. Hard rules (from the official participant guide)

Breaking any of these risks disqualification or the project being shut down.

1. **Use Google AI.** The product's AI must be Gemini (`gemini-4-argon` as the lead model).
2. **Deploy to Google Cloud.** The app must run as a service on Cloud Run and be demoable from its URL.
3. **All feature code is written during the hackathon.** Open-source libraries and starter templates are fine.
4. **Submissions are in English:** project description, **public** GitHub repo, demo video link.
5. **Not allowed as a project:** plain chat wrappers / Q&A bots; static Streamlit pages without autonomous
   reasoning, verification loops or multimodal workflows; unverified medical, mental-health or finance advice
   without a human in the loop. → **Do not use Streamlit or Gradio. Do not build a chatbot UI.**
6. **Security (automatically detected):** no unsecured HTTP ports, no databases open to the internet, **no PHP**,
   **no OpenClaw-style autonomous agents inside the project**, no leaked API keys, no excessive resource use.
   → HTTPS Cloud Run URL only. No database at all. Secrets only in Secret Manager. `.env` is git-ignored.
7. Using the Google **managed agent** (`antigravity-preview-09-2026`) is named in the official judging criteria,
   but the user will confirm at kickoff that it does not count as a banned autonomous agent. If it is banned,
   switch to Plan B (section 10).

### Judging criteria (optimise for these)
- **Working demo:** runs on real input without errors; uses `gemini-4-argon`, Managed Agents or companion models
  **with a real verification loop**.
- **Problem & impact:** a specific user's real problem; could become a real product or open-source tool.
- **Originality:** not a commonly seen project; only possible because of Argon (1M context, long decode,
  frontier reasoning, multimodal orchestration).
- **Clarity:** the description and video make the target user and value obvious.
- Live demo must finish with real input in **under 3 minutes**.

---

## 3. How we got here (decisions already made — do not reopen them)

- Many ideas were considered: live screen coach, accessibility auto-fixer (track 3), Three.js game generator
  (track 1), firmware/datasheet verifier (track 2), and **"MigrateLoop"** — an agent that migrates a repo from
  Pydantic v1 to v2 and opens a PR.
- MigrateLoop was dropped because "point an AI at a repo, fix it, open a PR" is what existing coding agents
  already do. **Originality would score low.**
- The pivot: keep the verify-and-fix skeleton but make the **input a screen-recorded bug video**, which uses
  Argon's video understanding — something generic coding agents don't take as input.
- Who records videos? **Not developers.** QA, support (CS), planners and end users send screen recordings with a
  one-line note. Developers are on the receiving end and lose time rewinding and reproducing. BugReel serves
  the receiving developer.
- Stack: Node.js backend (user's strength), Python for the verification script. No Streamlit.
- Demo target: the user's own repos were considered but need databases/servers; building a fresh demo app
  before the event could break the "demo code written during the hackathon" rule. **Decision: use the public
  open-source TodoMVC vanilla-JS example and introduce one bug on the day.**

---

## 4. Product: BugReel

**One-liner:** BugReel turns a screen-recorded bug report into a failing reproduction test and a verified fix,
ready for a developer to approve.

**Tagline:** Reporters send a video. Developers just approve.

### Users
| Role | Who | Does | Gets |
|---|---|---|---|
| Reporter | QA, support, planners, end users | Uploads a screen recording + one-line note | No need to write repro steps |
| Developer | Maintainer of the repo | Reviews diff + test results, clicks Approve | Skips rewinding, reproducing, writing the test |

### What makes it different (keep this true in the code)
1. Input is a **video**, not a text instruction.
2. **No fix without a failing reproduction test first.** If the test does not fail, the bug is "not reproduced"
   and BugReel stops — it never guesses a fix.
3. Done only when the reproduction test **and** existing tests pass.
4. **Human approval gate:** the agent pushes a branch; a pull request is opened only when the developer clicks
   Approve.

### MVP scope
| Feature | Status |
|---|---|
| Upload video + note + target repo URL | In |
| Video analysis → bug timestamp + steps | In |
| Reproduction test written and confirmed failing | In |
| Fix loop until tests pass, progress visible | In |
| Approve → pull request (fallback: diff download) | In |
| Ask the reporter a follow-up when not reproduced | Only if time remains |
| Issue-tracker webhooks, mobile apps, auth, database, multi-user | **Out** |

---

## 5. Architecture

### 5.1 Flow
```
Reporter: video + note + repo URL ──► POST /api/reports
   │
   ▼
[A] Video analysis — gemini-4-argon
    → AnalysisResult (5.4)
   │
   ▼
[B] Reproduce — managed agent call #1 (antigravity-preview-09-2026, model gemini-4-argon)
    clone → serve → write tests/repro.spec.js → run → must FAIL
    ├─ not_reproduced → stop, show to user
    └─ reproduced (RED) ─┐
                         ▼
[C] Fix — managed agent call #2
    fix app code → run all tests → loop until pass (max 5)
    → push branch bugreel/fix-<id>, return diff (GREEN)
   │
   ▼
[D] Developer review page → [Approve] → POST /api/reports/:id/approve → GitHub API opens PR
```
Splitting reproduce and fix into **two agent calls** gives the demo a guaranteed visible RED moment before GREEN.
If sandbox state does not persist between calls, pass the repro test file content into call #2.

### 5.2 Components
| Component | Choice |
|---|---|
| Server | Node.js 20+, Express, `multer` for uploads, `@google/genai` **≥ 2.3.0** (Interactions API) |
| UI | Static HTML + vanilla JS served by Express (two views). No framework needed |
| Live progress | Server-Sent Events; fallback: poll every 2 s |
| State | In-memory `Map<reportId, Report>` — **no database** |
| Video storage | Gemini Files API or a private Cloud Storage bucket — check the `gemini-api-dev` skill for the correct way to pass video to the Interactions API |
| Verification script | `verify.py` (Python 3, stdlib only) — see 5.7 |
| GitHub | REST API with a token from Secret Manager (`GITHUB_TOKEN`) |
| Deploy | Cloud Run, HTTPS default URL, secrets via Secret Manager env vars |

### 5.3 HTTP API
| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Reporter upload page |
| GET | `/review/:id` | Developer review page |
| POST | `/api/reports` | multipart: `video` (mp4/webm/mov, ≤ 50 MB), `note`, `repoUrl` → `{ id }`, starts the pipeline |
| GET | `/api/reports/:id` | Full report JSON |
| GET | `/api/reports/:id/events` | SSE stream of `ReportEvent` |
| POST | `/api/reports/:id/approve` | Opens the PR → `{ prUrl }` |
| GET | `/healthz` | `ok` |

### 5.4 Data contracts
```ts
type Stage =
  | "uploaded" | "analyzing" | "analyzed"
  | "reproducing" | "reproduced" | "not_reproduced"
  | "fixing" | "fixed" | "fix_failed"
  | "approved" | "pr_opened" | "error";

interface AnalysisResult {
  bug_timestamp: string;            // "0:07"
  steps: { t: string; action: "type" | "click" | "press" | "reload" | "navigate";
           target: string; value?: string }[];
  expected: string;                 // "counter shows '2 items left'"
  actual: string;                   // "counter still shows '3 items left'"
  confidence: "high" | "medium" | "low";
}

interface ReproduceResult {
  status: "reproduced" | "not_reproduced" | "error";
  repro_test: string;               // full content of tests/repro.spec.js
  tests: { passed: number; total: number };
  failure?: string;                 // assertion message
  notes?: string;
}

interface FixResult {
  status: "fixed" | "failed";
  attempts: number;
  tests: { passed: number; total: number };
  branch: string;                   // bugreel/fix-<id>
  diff: string;                     // unified diff
  test_files_changed: boolean;      // true if anything under tests/ other than adding repro.spec.js changed
  summary: string;
}

interface Report {
  id: string; createdAt: string; stage: Stage;
  note: string; repoUrl: string; videoRef: string;
  analysis?: AnalysisResult; reproduce?: ReproduceResult; fix?: FixResult;
  prUrl?: string; error?: string;
}

type ReportEvent =
  | { type: "stage"; stage: Stage; message: string }
  | { type: "analysis"; analysis: AnalysisResult }
  | { type: "tests"; passed: number; total: number }
  | { type: "result"; report: Report }
  | { type: "error"; message: string };
```
Ask Argon for JSON output and validate it; on invalid JSON retry once, then surface an error.
Server-side guard: if the diff touches files under `tests/` other than adding `tests/repro.spec.js`,
set `test_files_changed = true` and show a warning badge on the review page.

### 5.5 Managed agent task prompts (fill the `{}` placeholders)

**Call #1 — reproduce**
```
Repository: {repoUrl} (branch main). It is a static web app. Serve it with: npx --yes serve -l 4173 .
A non-developer reported a bug with a screen recording. Video analysis:
{analysisJson}
Reporter note: "{note}"

1. Clone the repository. Install @playwright/test and Chromium.
2. Start the static server in the background.
3. Write tests/repro.spec.js that performs the steps exactly and asserts the EXPECTED behaviour
   (not the actual one). Use stable selectors.
4. Create verify.py with the content below, run the test with the JSON reporter
   (npx playwright test tests/repro.spec.js --reporter=json > report.json), then run: python3 verify.py report.json
5. Do NOT modify application code.
The bug counts as reproduced only if the test FAILS on the assertion of the expected behaviour.

verify.py:
{verifyPyContent}

Return ONLY a JSON object:
{"status":"reproduced"|"not_reproduced"|"error","repro_test":"<file content>","tests":{"passed":n,"total":m},"failure":"<assertion message>","notes":"<short>"}
```

**Call #2 — fix**
```
Repository: {repoUrl} (branch main). Serve with: npx --yes serve -l 4173 .
This test reproduces a reported bug and currently fails:
--- tests/repro.spec.js ---
{reproTest}
---
Fix the APPLICATION code so that this test and any existing tests pass.
Never edit, weaken, skip or delete tests. Keep the change minimal.
Loop: run tests → read failures → fix → re-run, until everything passes or 5 attempts.
Use verify.py (content below) on the Playwright JSON report as the pass/fail signal.
When everything passes: create branch bugreel/fix-{id}, commit the fix and tests/repro.spec.js,
push using the provided GitHub credential. Do NOT open a pull request.

verify.py:
{verifyPyContent}

Return ONLY a JSON object:
{"status":"fixed"|"failed","attempts":n,"tests":{"passed":n,"total":m},"branch":"bugreel/fix-{id}","diff":"<unified diff>","test_files_changed":false,"summary":"<one paragraph>"}
```

Sandbox settings: `environment` remote with a **network allowlist** (github.com, registry.npmjs.org, and the
Playwright browser download host — add hosts from failure logs if downloads are blocked). Register the GitHub
token with the **Credentials API** so it never enters the model context.

### 5.6 Calling Gemini — notes from the organizer's builder guide
- The **Interactions API** is the recommended endpoint; one API covers models and managed agents, supports
  server-side state (`previous_interaction_id`) and background execution.
- Node SDK: `@google/genai` ≥ 2.3.0. **Use the `gemini-api-dev` skill for exact JS syntax.** The examples below
  are the guide's Python examples, for reference only.
- `thinking_level`: `"low" | "medium" (default) | "high"`. Use `"high"` for the fix call, `"medium"` for video
  analysis.
- Default output limit 65,536 tokens. For longer runs use `background=True` and poll.
- **Do not send** `temperature`, `top_p`, `top_k`, `thinking_budget` or explicit `cached_content` to
  `gemini-4-argon` (deprecated / ignored).
- Raise HTTP client timeouts to 15–20 minutes for `"high"` calls, or use `background=True` and poll.
  Never block a Cloud Run request on an agent run — start it in the background and stream progress.

```python
# Model call (reference)
from google import genai
client = genai.Client()
interaction = client.interactions.create(
    model="gemini-4-argon",
    input="...",
    generation_config={"thinking_level": "medium"},
)
print(interaction.output_text)
```
```python
# Background run + polling (reference)
import time
interaction = client.interactions.create(
    model="gemini-4-argon", input="...", background=True,
    generation_config={"max_output_tokens": 262144, "thinking_level": "high"},
)
while interaction.status in ("in_progress", "queued"):
    time.sleep(5)
    interaction = client.interactions.get(id=interaction.id)
```
```python
# Managed agent (reference)
interaction = client.interactions.create(
    agent="antigravity-preview-09-2026",
    agent_config={"type": "antigravity", "model": "gemini-4-argon"},
    input="...",
    environment="remote",
)
# Secrets: client.credentials.create(...)
# Network: environment={"type": "remote", "network": {"allowlist": [...]}}
```

Companion models if needed: `gemini-3.8-flash` (fast parallel subtasks), `gemini-3.5-flash-lite`
(cheap routing / validation).

### 5.7 verify.py (write on the day, stdlib only)
- Input: path to a Playwright JSON report.
- Output (stdout, one line): `{"passed": n, "total": m, "failed": ["<test title>", ...]}`
- Exit code `0` only if `passed == total` and `total > 0`; otherwise `1`.

### 5.8 UI spec
**Reporter page (`/`)**: video picker with preview, note input, repo URL (pre-filled with the demo repo),
Submit → redirect to `/review/:id`.

**Review page (`/review/:id`)** — must read well on a projector (large type, high contrast):
- Video player with a **red marker on the timeline at `bug_timestamp`**; clicking the marker seeks there.
- Extracted steps list, each with its timestamp (clicking seeks).
- Stage tracker: `Analyze → Write repro test → Reproduced (RED) → Fixing → Passed (GREEN)`.
- Big test counter: `passed n / total m`, red then green.
- Diff view (monospace, added/removed lines coloured), warning badge if `test_files_changed`.
- **Approve and open PR** button (enabled only at `fixed`), then the PR link.
- If `not_reproduced`: clear message "Could not reproduce — no fix attempted" plus the agent's notes.

### 5.9 Pull request
Title from `FixResult.summary` (first sentence). Body: bug timestamp, steps, expected vs actual, test results,
"Reported via BugReel video", link back to the review page. Base `main`, head `bugreel/fix-<id>`.

---

## 6. Demo target repo (prepared on the day with the user)

- Copy the **vanilla JavaScript example** from TodoMVC (github.com/tastejs/todomvc, MIT) into a new **public**
  repo `bugreel-demo-todo` under the user's GitHub account. **Not a fork.**
- Introduce **bug A** with a minimal change and make it part of the **first commit** (no git history revealing
  the fix). **No comments or names hinting at the bug.**
- README of that repo: "Based on TodoMVC (MIT). One bug was introduced for the BugReel demo."

| Bug | Symptom | Steps | Expected | Actual |
|---|---|---|---|---|
| **A (main)** | Checking an item does not reduce the counter | Add 3 todos → check the 2nd | "2 items left" | "3 items left" |
| B (backup) | Clear completed also removes one active item | Add 3 → check the 1st → Clear completed | 2 remain | 1 remains |
| C (backup) | Completed state lost after reload | Add 2 → check the 1st → reload | still checked | unchecked |

The user records a 10–15 s video of bug A (`demo/bug.mp4`), note: "체크했는데 숫자가 그대로예요"
("I checked it but the number didn't change").

---

## 7. Build order (time-boxed)

Do one step at a time. After each step: show the result, commit, and tell the user in Korean what is done and
what is next. **Push to the user's personal GitHub at least every 30 minutes** (the event account is deleted).

| # | Window | Step | Done when |
|---|---|---|---|
| 0 | 11:20–11:35 | Read this file, summarise in Korean, list questions and risks, confirm project ID | User confirms |
| 1 | 11:35–11:50 | Express scaffold (all routes stubbed, `/healthz`), Dockerfile, deploy to Cloud Run, secrets wiring | `curl https://<url>/healthz` → `ok` |
| 2 | 11:50–12:05 | Help the user create `bugreel-demo-todo` with bug A (section 6) | Public repo exists, video recorded |
| 3 | 12:05–12:35 | [A] Video analysis endpoint | `demo/bug.mp4` → valid `AnalysisResult`, timestamp near the bug |
| 4 | 12:35–13:15 | [B] + [C] managed agent calls, background + polling, state updates | **One full RED → GREEN run** with a pushed branch |
| 5 | 13:15–13:50 | Review page + SSE | Whole run visible in the browser |
| 6 | 13:50–14:10 | [D] Approve → PR | PR link appears |
| 7 | 14:10–14:20 | Final deploy, full run on the deployed URL | Works on Cloud Run |
| 8 | 14:50–15:10 | English README, project description, interactive HTML architecture diagram, secret scan | Done |

(14:20–14:50 the user records the demo video; 15:10–15:20 submission. **No new features after 14:20.**)

### Cut rules
- 13:15 and no full run yet → drop SSE and the video marker; show results only.
- 14:10 and PR not working → replace with "Download diff".
- If Argon's video analysis is unreliable → also send the reporter's note; if still bad, switch to bug B or C.

---

## 8. Working agreements

1. **Align before long runs:** before any multi-file build, state the plan and open questions; then execute to
   completion instead of asking turn by turn.
2. **Verify your own work** with a concrete pass/fail signal: curl the endpoint, run the pipeline end to end,
   load the page. Never claim something works without running it.
3. Keep it minimal. No auth, no database, no extra services, no framework migrations.
4. Never commit secrets. `.env`, keys and tokens stay out of git; check before every push.
5. Use the `gemini-api-dev` skill (and `gemini-live-api-dev` only if voice is ever added) for current SDK syntax;
   do not rely on memory of older Gemini SDKs.
6. Prefer readable over clever; the code is shown to judges in a public repo.
7. When you solve a non-obvious setup quirk, add it to **Lessons** (section 12).

---

## 9. Security checklist (before every deploy)
- [ ] Only the Cloud Run HTTPS URL is exposed; no extra ports
- [ ] No database, nothing publicly writable except the upload endpoint (size and type limited)
- [ ] `GITHUB_TOKEN`, API keys in Secret Manager; none in code, logs or client JS
- [ ] Untrusted repo code runs **only** inside the managed agent sandbox, never on Cloud Run
- [ ] No PHP anywhere

---

## 10. Plan B (if managed agents are not allowed or not working)
Run the loop ourselves inside a Cloud Run **Job** built from the official Playwright Docker image:
clone → serve → run repro test → send failing output + relevant files to `gemini-4-argon` (`thinking_level: "high"`)
→ apply its patch → re-run → repeat (max 5). Keep the same contracts (5.4) so the UI does not change.
Warn the user this runs untrusted code on our infrastructure; limit it to the demo repo.

---

## 11. Definition of done (submission)
- [ ] Deployed Cloud Run URL runs the full flow on the demo video
- [ ] Public GitHub repo with English README
- [ ] English project description
- [ ] Demo video (≤ 3 min) recorded on the deployed URL
- [ ] No secrets in the repo history

---

## 12. Lessons (append during the day)
- _empty_
