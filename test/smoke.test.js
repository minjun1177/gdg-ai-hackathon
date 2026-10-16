import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  GITHUB_API_CREDENTIAL_ID,
  GITHUB_GIT_CREDENTIAL_ID,
  buildAgentEnvironment,
  buildFixPrompt,
  buildReproducePrompt,
  detectTestFilesChanged,
  extractJsonObject,
  runBugReelPipeline,
  validateAnalysisResult,
  validateFixResult,
  validateReproduceResult,
} from "../pipeline.js";
import { app, isValidGithubRepoUrl, reports } from "../server.js";

test("isValidGithubRepoUrl validates github.com owner/repo URLs", () => {
  assert.equal(
    isValidGithubRepoUrl("https://github.com/minjun1177/bugreel-demo-todo"),
    true
  );
  assert.equal(isValidGithubRepoUrl("https://github.com/only-owner"), false);
  assert.equal(isValidGithubRepoUrl("https://evil.com/a/b"), false);
  assert.equal(isValidGithubRepoUrl("javascript:alert(1)"), false);
});

test("buildAgentEnvironment uses explicit allowlist (no wildcard '*') and credential IDs (no inline transform)", () => {
  process.env.GITHUB_TOKEN = "ghp_secret_should_never_appear_in_env_payload";
  try {
    const envWithCreds = buildAgentEnvironment({
      apiCredentialId: GITHUB_API_CREDENTIAL_ID,
      gitCredentialId: GITHUB_GIT_CREDENTIAL_ID,
    });
    const allowlist = envWithCreds.network.allowlist;
    assert.ok(Array.isArray(allowlist) && allowlist.length > 0);

    // Must not contain wildcard "*" or inline transform headers
    for (const rule of allowlist) {
      assert.notEqual(rule.domain, "*", "Wildcard domain '*' must not be in allowlist");
      assert.equal(rule.transform, undefined, "Inline transform headers must not be used");
    }

    const serialized = JSON.stringify(envWithCreds);
    assert.equal(
      serialized.includes("ghp_secret_should_never_appear_in_env_payload"),
      false,
      "Raw GITHUB_TOKEN must never be serialized into environment config"
    );

    const githubRule = allowlist.find((r) => r.domain === "github.com");
    const apiGithubRule = allowlist.find((r) => r.domain === "api.github.com");
    assert.equal(githubRule?.credential, GITHUB_GIT_CREDENTIAL_ID);
    assert.equal(apiGithubRule?.credential, GITHUB_API_CREDENTIAL_ID);
  } finally {
    delete process.env.GITHUB_TOKEN;
  }
});

test("server health endpoints and Multer error handling return JSON", async () => {
  process.env.BUGREEL_DISABLE_AUTO_RUN = "1";
  const server = app.listen(0);
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    for (const p of ["/healthz", "/health", "/api/healthz"]) {
      const res = await fetch(`${baseUrl}${p}`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), "ok");
    }

    // Missing video returns 400 JSON
    const formMissing = new FormData();
    formMissing.append(
      "repoUrl",
      "https://github.com/minjun1177/bugreel-demo-todo"
    );
    const resMissing = await fetch(`${baseUrl}/api/reports`, {
      method: "POST",
      body: formMissing,
    });
    assert.equal(resMissing.status, 400);
    const missingJson = await resMissing.json();
    assert.ok(missingJson.error);

    // Disallowed file extension returns 400 JSON (not 500 HTML)
    const formBadType = new FormData();
    formBadType.append(
      "video",
      new Blob(["not a video"], { type: "text/plain" }),
      "bad.txt"
    );
    formBadType.append(
      "repoUrl",
      "https://github.com/minjun1177/bugreel-demo-todo"
    );
    const resBadType = await fetch(`${baseUrl}/api/reports`, {
      method: "POST",
      body: formBadType,
    });
    assert.equal(resBadType.status, 400);
    const badTypeJson = await resBadType.json();
    assert.match(badTypeJson.error, /Only mp4, webm, and mov/i);
  } finally {
    server.close();
  }
});

test("detectTestFilesChanged server-side guard detects changes outside tests/repro.spec.js", () => {
  const safeDiff = [
    "diff --git a/js/controller.js b/js/controller.js",
    "--- a/js/controller.js",
    "+++ b/js/controller.js",
    "@@ -10,1 +10,1 @@",
    "-this.view.setItemsLeft(total);",
    "+this.view.setItemsLeft(active);",
    "diff --git a/tests/repro.spec.js b/tests/repro.spec.js",
    "--- /dev/null",
    "+++ b/tests/repro.spec.js",
  ].join("\n");
  assert.equal(detectTestFilesChanged(safeDiff), false);

  const unsafeDiff = [
    "diff --git a/tests/existing.spec.js b/tests/existing.spec.js",
    "--- a/tests/existing.spec.js",
    "+++ b/tests/existing.spec.js",
  ].join("\n");
  assert.equal(detectTestFilesChanged(unsafeDiff), true);

  const fixResult = validateFixResult(
    {
      status: "fixed",
      attempts: 2,
      tests: { passed: 2, total: 2 },
      branch: "bugreel/fix-1234",
      diff: unsafeDiff,
      test_files_changed: false,
      summary: "Fixed counter update.",
    },
    "1234"
  );
  assert.equal(fixResult.test_files_changed, true);
});

test("validateReproduceResult and validateFixResult cross-check test counts against status", () => {
  // Claiming "reproduced" when 1/1 passed must become "not_reproduced"
  const falseRepro = validateReproduceResult({
    status: "reproduced",
    repro_test: "test('x', () => {})",
    tests: { passed: 1, total: 1 },
  });
  assert.equal(falseRepro.status, "not_reproduced");

  // Claiming "reproduced" when 0/0 ran must become "error"
  const zeroRepro = validateReproduceResult({
    status: "reproduced",
    repro_test: "",
    tests: { passed: 0, total: 0 },
  });
  assert.equal(zeroRepro.status, "error");

  // Claiming "fixed" when 0/1 passed must become "failed"
  const falseFix = validateFixResult(
    {
      status: "fixed",
      attempts: 2,
      tests: { passed: 0, total: 1 },
      branch: "bugreel/fix-9999",
      diff: "",
      test_files_changed: false,
      summary: "Claimed fixed but failed test",
    },
    "9999"
  );
  assert.equal(falseFix.status, "failed");
});

test("pipeline stops at not_reproduced without attempting fix, and runs RED -> GREEN when reproduced", async () => {
  const mockAnalysis = validateAnalysisResult(
    extractJsonObject(`\`\`\`json
    {
      "bug_timestamp": "0:07",
      "steps": [
        { "t": "0:02", "action": "type", "target": ".new-todo", "value": "Buy milk" },
        { "t": "0:07", "action": "click", "target": ".toggle" }
      ],
      "expected": "counter shows '2 items left'",
      "actual": "counter still shows '3 items left'",
      "confidence": "high"
    }
    \`\`\``)
  );

  // Case 1: Not reproduced (or contradictory status: "reproduced" with passed: 1, total: 1) -> fixBug must NOT be called
  let fixCalled = false;
  const reportNotRepro = {
    id: "aa11bb22",
    stage: "uploaded",
    note: "I checked it",
    repoUrl: "https://github.com/minjun1177/bugreel-demo-todo",
  };
  await runBugReelPipeline(
    reportNotRepro,
    () => {},
    {
      analyzeVideo: async () => mockAnalysis,
      reproduceBug: async () => ({
        reproduceResult: {
          status: "reproduced", // contradictory! 1/1 passed
          repro_test: "test('repro', async () => {});",
          tests: { passed: 1, total: 1 },
          notes: "Test passed on first run",
        },
        environmentId: "env_1",
        interactionId: "int_1",
      }),
      fixBug: async () => {
        fixCalled = true;
        throw new Error("Should not be called");
      },
    }
  );
  assert.equal(reportNotRepro.stage, "not_reproduced");
  assert.equal(fixCalled, false);

  // Case 2: Reproduced (RED) -> Fixed (GREEN)
  const stagesSeen = [];
  const reportFixed = {
    id: "cc33dd44",
    stage: "uploaded",
    note: "체크했는데 숫자가 그대로예요",
    repoUrl: "https://github.com/minjun1177/bugreel-demo-todo",
  };
  await runBugReelPipeline(
    reportFixed,
    (_id, evt) => {
      if (evt.type === "stage") stagesSeen.push(evt.stage);
    },
    {
      analyzeVideo: async () => mockAnalysis,
      reproduceBug: async () => ({
        reproduceResult: {
          status: "reproduced",
          repro_test: "test('counter decreases', async () => {});",
          tests: { passed: 0, total: 1 },
          failure: "Expected '2 items left', received '3 items left'",
        },
        environmentId: "env_2",
        interactionId: "int_2",
      }),
      fixBug: async () => ({
        status: "fixed",
        attempts: 1,
        tests: { passed: 1, total: 1 },
        branch: "bugreel/fix-cc33dd44",
        diff: "--- a/js/controller.js\n+++ b/js/controller.js\n-bad\n+good",
        test_files_changed: false,
        summary: "Update remaining item counter to use active count.",
      }),
    }
  );
  assert.equal(reportFixed.stage, "fixed");
  assert.deepEqual(stagesSeen, [
    "analyzing",
    "analyzed",
    "reproducing",
    "reproduced",
    "fixing",
    "fixed",
  ]);

  // Verify prompts include verify.py and required placeholders
  const reproPrompt = buildReproducePrompt({
    repoUrl: reportFixed.repoUrl,
    analysis: mockAnalysis,
    note: reportFixed.note,
  });
  assert.match(reproPrompt, /verify\.py/);
  const fixPrompt = buildFixPrompt({
    repoUrl: reportFixed.repoUrl,
    reproTest: reportFixed.reproduce.repro_test,
    reportId: reportFixed.id,
  });
  assert.match(fixPrompt, /bugreel\/fix-cc33dd44/);
});

test("verify.py exits 0 on all passed, 1 on failure or top-level runner error", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "bugreel-verify-"));
  const passFile = path.join(tmpDir, "pass.json");
  const failFile = path.join(tmpDir, "fail.json");
  const errFile = path.join(tmpDir, "err.json");

  fs.writeFileSync(
    passFile,
    JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: "counter decreases",
              tests: [
                {
                  expectedStatus: "passed",
                  results: [{ status: "passed" }],
                },
              ],
            },
          ],
        },
      ],
    })
  );

  fs.writeFileSync(
    failFile,
    JSON.stringify({
      suites: [
        {
          specs: [
            {
              title: "counter decreases",
              tests: [
                {
                  expectedStatus: "passed",
                  results: [{ status: "failed" }],
                },
              ],
            },
          ],
        },
      ],
    })
  );

  fs.writeFileSync(
    errFile,
    JSON.stringify({
      suites: [],
      errors: [{ message: "SyntaxError in spec" }],
    })
  );

  const rPass = spawnSync("python", ["verify.py", passFile], {
    encoding: "utf-8",
  });
  assert.equal(rPass.status, 0);
  assert.deepEqual(JSON.parse(rPass.stdout.trim()), {
    passed: 1,
    total: 1,
    failed: [],
  });

  const rFail = spawnSync("python", ["verify.py", failFile], {
    encoding: "utf-8",
  });
  assert.equal(rFail.status, 1);
  assert.deepEqual(JSON.parse(rFail.stdout.trim()), {
    passed: 0,
    total: 1,
    failed: ["counter decreases"],
  });

  const rErr = spawnSync("python", ["verify.py", errFile], {
    encoding: "utf-8",
  });
  assert.equal(rErr.status, 1);
  const errOut = JSON.parse(rErr.stdout.trim());
  assert.equal(errOut.passed, 0);
  assert.equal(errOut.total, 1);

  fs.rmSync(tmpDir, { recursive: true, force: true });
});
