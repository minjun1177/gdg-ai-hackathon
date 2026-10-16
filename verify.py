#!/usr/bin/env python3
"""
verify.py — Parse a Playwright JSON report and output pass/fail summary.
Input: path to a Playwright JSON report file.
Output (stdout, one line): {"passed": n, "total": m, "failed": ["<test title>", ...]}
Exit code: 0 only if passed == total and total > 0; otherwise 1.
"""
import json
import sys


def walk_suites(suites, passed_list, failed_list):
    for suite in suites or []:
        for spec in suite.get("specs", []):
            title = spec.get("title", "untitled")
            tests = spec.get("tests", [])
            if not tests:
                continue
            spec_ok = True
            for t in tests:
                results = t.get("results", [])
                if not results:
                    spec_ok = False
                else:
                    last_status = results[-1].get("status")
                    expected_status = t.get("expectedStatus", "passed")
                    if last_status != expected_status:
                        spec_ok = False
            if spec_ok:
                passed_list.append(title)
            else:
                failed_list.append(title)
        walk_suites(suite.get("suites", []), passed_list, failed_list)


def main():
    if len(sys.argv) < 2:
        print(json.dumps({"passed": 0, "total": 0, "failed": ["missing report path"]}))
        sys.exit(1)

    report_path = sys.argv[1]
    try:
        with open(report_path, "r", encoding="utf-8") as f:
            raw = f.read()
        start = raw.find("{")
        end = raw.rfind("}")
        if start == -1 or end == -1:
            raise ValueError("No JSON object found in report")
        data = json.loads(raw[start : end + 1])
    except Exception as exc:
        print(json.dumps({"passed": 0, "total": 0, "failed": [f"report parse error: {exc}"]}))
        sys.exit(1)

    passed_list = []
    failed_list = []
    walk_suites(data.get("suites", []), passed_list, failed_list)

    for top_err in data.get("errors", []) or []:
        msg = top_err.get("message") if isinstance(top_err, dict) else str(top_err)
        failed_list.append(f"runner error: {msg[:120]}")

    passed = len(passed_list)
    total = passed + len(failed_list)
    output = {"passed": passed, "total": total, "failed": failed_list}
    print(json.dumps(output))

    if total > 0 and passed == total and not data.get("errors"):
        sys.exit(0)
    sys.exit(1)


if __name__ == "__main__":
    main()
