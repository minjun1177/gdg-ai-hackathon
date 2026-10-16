import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { app, isValidGithubRepoUrl } from "../server.js";

test("isValidGithubRepoUrl validates github.com owner/repo URLs", () => {
  assert.equal(
    isValidGithubRepoUrl("https://github.com/minjun1177/bugreel-demo-todo"),
    true
  );
  assert.equal(isValidGithubRepoUrl("https://github.com/only-owner"), false);
  assert.equal(isValidGithubRepoUrl("https://evil.com/a/b"), false);
  assert.equal(isValidGithubRepoUrl("javascript:alert(1)"), false);
});

test("server health endpoints and Multer error handling return JSON", async () => {
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
