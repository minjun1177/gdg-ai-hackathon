# BugReel — Hackathon Submission Description

## Project Title
**BugReel** — Turn Screen-Recorded Bug Reports into Failing Reproduction Tests and Verified Fixes

## One-Liner / Tagline
**One-liner:** BugReel turns a screen-recorded bug report into a failing reproduction test and a verified fix, ready for a developer to approve.  
**Tagline:** *Reporters send a video. Developers just approve.*

## Track
**Track 4 — Open Innovation: Autonomous Agents and Developer Tools**

## Links
- **Live Cloud Run URL:** https://bugreel-806839438168.asia-northeast3.run.app
- **Interactive Architecture Diagram:** https://bugreel-806839438168.asia-northeast3.run.app/architecture.html
- **Public GitHub Repository:** https://github.com/minjun1177/gdg-ai-hackathon
- **Demo Target Repository:** https://github.com/minjun1177/bugreel-demo-todo *(Based on TodoMVC under the MIT license, with one bug introduced for the BugReel live demo)*
- **Sample Pull Request Opened by BugReel:** https://github.com/minjun1177/bugreel-demo-todo/pull/1

---

## Problem & Impact
Non-developers—QA engineers, customer support (CS) specialists, product managers, and end users—rarely write deterministic reproduction steps. Instead, they send a 10-second screen recording with a one-line message like *"I checked the item, but the number didn't change."*

Developers on the receiving end spend significant time scrubbing through videos frame-by-frame, reconstructing clicks and typed inputs, setting up local state, writing a regression test, and hunting down the bug. Existing coding agents take text issues or stack traces as input—not raw user screen recordings.

**BugReel bridges the gap between non-developer video reports and developer code reviews:**
1. **Reporters** simply upload a screen recording + optional note.
2. **Developers** open a single review page showing the video pinned to the exact `bug_timestamp`, the extracted UI steps, a confirmed failing Playwright test (**RED**), and a verified minimal fix (**GREEN**)—and click **Approve & Open PR**.

---

## Why Only Possible with Gemini 4 Argon & Managed Agents (Originality)
BugReel relies on capabilities unique to **`gemini-4-argon`** and the **Google Antigravity Managed Agent (`antigravity-preview-09-2026`)** via the **Interactions API**:
1. **Frame-Accurate Video UI Understanding (`gemini-4-argon`):**
   `gemini-4-argon` (`thinking_level: "medium"`) processes the uploaded screen recording via the Gemini Files API + Interactions API and outputs a strict JSON schema containing the exact `bug_timestamp` (e.g., `"0:07"`), chronological user actions (`type`, `click`, `press`, `reload`, `navigate`), and the discrepancy between `expected` and `actual` UI state.
2. **Two-Phase RED → GREEN Autonomous Sandbox Verification (`antigravity-preview-09-2026`):**
   Rather than guessing a patch blindly, BugReel splits execution into two verifiable managed agent calls inside a remote sandbox (`environment.type = "remote"`):
   - **Call #1 — Reproduce (RED):** Clones the repository, serves the web app, writes `tests/repro.spec.js` asserting the *expected* behavior, and runs Playwright + `verify.py`. **No fix is ever attempted unless this test fails first.** If the test passes, BugReel stops at `not_reproduced`.
   - **Call #2 — Fix (GREEN):** Starting from the confirmed failing test, the agent patches application code (never weakening or editing test files) and loops with Playwright + `verify.py` (up to 5 attempts) until `passed === total && total > 0`.
3. **Server-Side Guardrails & Human Approval Gate:**
   - A server-side diff parser (`detectTestFilesChanged`) verifies that no files under `tests/` other than `tests/repro.spec.js` were modified.
   - A GitHub Pull Request is opened **only** when the developer clicks **Approve & Open PR** on `/review/:id`.

---

## Demo Target (`bugreel-demo-todo`)
- Built from the open-source **TodoMVC Vanilla JS** example (MIT License) at `https://github.com/minjun1177/bugreel-demo-todo` with one bug introduced: checking a todo item calls `updateElementCount` with `todos.total` instead of `todos.active`, leaving the footer stuck at `"3 items left"`.
- Given a 10-second screen recording (`demo/bug.webm`) and the Korean note `"체크했는데 숫자가 그대로예요"`, BugReel identifies the bug at `0:07`, writes `tests/repro.spec.js` (**RED: 0/1 passed**), fixes `src/controller.js` (**GREEN: 1/1 passed**), and opens a Pull Request upon developer approval.
