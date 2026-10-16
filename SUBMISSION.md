# BugReel — from a bug video to a verified fix

**Tagline:** Reporters send a video. Developers just approve.

## Problem
Bug reports from QA, support teams and users often arrive as a screen recording and a one-line note.
Developers then spend their first hour rewinding the video and reproducing the steps by hand.

## What it does
Upload a screen recording. Gemini 4 Argon watches it, pins the moment the bug appears and extracts
the user's steps. An Antigravity managed agent turns those steps into a Playwright test and confirms
it fails — proof the bug is reproduced. It then patches the code and re-runs the reproduction test and
the existing suite until everything passes. A developer reviews the diff and approves before a pull
request is opened.

## How it uses Google AI
- `gemini-4-argon`: video understanding (`thinking_level: "medium"`) and code fixing across the repository (`thinking_level: "high"`) via the Interactions API (`@google/genai`)
- `antigravity-preview-09-2026` managed agent: sandboxed clone, test, fix, verify loop (`verify.py`) split into two calls to guarantee a visible RED → GREEN transition
- Deployed on Google Cloud Run (`asia-northeast3`) with secrets stored in Google Cloud Secret Manager

## Verification and safety
- No fix without a failing reproduction test first; done only when all tests pass (`verify.py` on Playwright JSON reports)
- Server-side `detectTestFilesChanged` guard verifies that existing tests were not weakened or deleted
- Untrusted repository code runs only in the managed remote sandbox with an explicit network allowlist (never on Cloud Run)
- Credentials injected via the Gemini Credentials API, never in model context
- Human approval required before any pull request is opened

## Who it's for
Developers who receive bug reports from non-developers (QA, support, planners, end users).

## What's next
Issue tracker webhooks (GitHub Issues, Jira, Slack), mobile app recordings, and automated follow-up questions to the reporter when a bug cannot be reproduced.

**Demo target:** [`bugreel-demo-todo`](https://github.com/minjun1177/bugreel-demo-todo) — TodoMVC (vanilla JS example, MIT) with one bug introduced for the demo.

---

## Links
- **Live Cloud Run App:** https://bugreel-806839438168.asia-northeast3.run.app
- **Verified Demo Run (RED → GREEN → PR #1):** https://bugreel-806839438168.asia-northeast3.run.app/review/6f680035
- **Interactive Architecture Diagram:** https://bugreel-806839438168.asia-northeast3.run.app/architecture.html
- **GitHub Repository (BugReel):** https://github.com/minjun1177/gdg-ai-hackathon
- **Demo Target Repository (`bugreel-demo-todo`):** https://github.com/minjun1177/bugreel-demo-todo
- **Opened Pull Request (#1):** https://github.com/minjun1177/bugreel-demo-todo/pull/1
