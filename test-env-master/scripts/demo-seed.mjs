#!/usr/bin/env node
/**
 * Seeds a rich demo dataset via the running API.
 */
const API = process.env.API_URL ?? "http://localhost:3001/api";

async function req(path, init) {
  const res = await fetch(`${API}${path}`, {
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
    ...init,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} → ${res.status}: ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function waitHealthy(retries = 40) {
  for (let i = 0; i < retries; i++) {
    try {
      const h = await req("/health");
      if (h.services?.find((s) => s.name === "postgres")?.status === "ok") {
        console.log("[demo-seed] API + Postgres OK");
        return;
      }
      console.log(`[demo-seed] waiting for postgres… (${h.status})`);
    } catch {
      console.log("[demo-seed] waiting for API…");
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error("API/Postgres not ready");
}

async function main() {
  await waitHealthy();

  const issue = await req("/jira/demo-import", { method: "POST", body: "{}" });
  console.log(`[demo-seed] Issue ${issue.key}`);

  // The analysis is done by the configured AI service, in the background.
  try {
    await req(`/analysis/${issue.id}/run`, { method: "POST", body: JSON.stringify({ scope: "all", locale: process.env.DEMO_LOCALE ?? "fa" }) });
    console.log("[demo-seed] AI analysis started — this can take a while on a local model");
    for (;;) {
      await new Promise((r) => setTimeout(r, 5000));
      const status = await req(`/analysis/${issue.id}/run`);
      const running = Object.entries(status.job?.stages ?? {}).find(([, stage]) => stage.state === "running");
      if (status.job?.state !== "running") {
        console.log(`[demo-seed] analysis ${status.job?.state}${status.job?.error ? `: ${status.job.error}` : ""}`);
        break;
      }
      if (running) console.log(`[demo-seed]   … ${running[0]} ${running[1].detail ?? ""}`);
    }
  } catch (error) {
    console.log(`[demo-seed] AI analysis skipped (${error.message}). Set up an AI service under Settings → AI.`);
  }

  const cases = await req(`/test-cases?jiraIssueId=${issue.id}`);
  console.log(`[demo-seed] ${cases.length} test cases`);

  if (cases[0]) {
    await req("/test-runs", {
      method: "POST",
      body: JSON.stringify({
        testCaseId: cases[0].id,
        status: "PASSED",
        notes: "Demo happy-path pass",
      }),
    });
  }
  if (cases[1]) {
    const fail = await req("/test-runs", {
      method: "POST",
      body: JSON.stringify({
        testCaseId: cases[1].id,
        status: "FAILED",
        notes: "Refund not triggered in demo failure",
        evidence: "logs/demo-refund.txt",
      }),
    });
    await req(`/bugs/from-run/${fail.id}`, { method: "POST", body: "{}" });
  }
  if (cases[2]) {
    await req("/test-runs", {
      method: "POST",
      body: JSON.stringify({
        testCaseId: cases[2].id,
        status: "BLOCKED",
        notes: "Waiting on payment sandbox",
      }),
    });
  }

  const suite = await req("/test-suites", {
    method: "POST",
    body: JSON.stringify({
      name: "Demo Smoke",
      kind: "SMOKE",
      testCaseIds: cases.slice(0, 2).map((c) => c.id),
    }),
  });
  console.log(`[demo-seed] Suite ${suite.name}`);

  const env = await req("/environments", {
    method: "POST",
    body: JSON.stringify({ name: "Demo Local", description: "Embedded demo env" }),
  });
  await req("/environments/variables", {
    method: "POST",
    body: JSON.stringify({
      environmentId: env.id,
      key: "base_url",
      value: "https://httpbin.org",
      type: "NORMAL",
    }),
  });
  await req("/environments/variables", {
    method: "POST",
    body: JSON.stringify({
      environmentId: env.id,
      key: "token",
      value: "demo-secret-token",
      type: "SECRET",
    }),
  });

  const scenario = await req("/scenarios", {
    method: "POST",
    body: JSON.stringify({
      name: "Demo HTTP health",
      environmentId: env.id,
      stopOnFailure: true,
    }),
  });
  await req(`/scenarios/${scenario.id}/steps`, {
    method: "POST",
    body: JSON.stringify({
      name: "GET httpbin",
      type: "HTTP_REQUEST",
      config: {
        method: "GET",
        url: "{{base_url}}/get",
        headers: { Authorization: "Bearer {{token}}" },
      },
    }),
  });
  await req(`/scenarios/${scenario.id}/steps`, {
    method: "POST",
    body: JSON.stringify({
      name: "Assert 200",
      type: "ASSERTION",
      config: { kind: "status_code", expected: 200 },
    }),
  });
  const run = await req(`/scenarios/${scenario.id}/run/sync`, {
    method: "POST",
    body: "{}",
  });
  console.log(`[demo-seed] Scenario run → ${run.status}`);

  const metrics = await req("/dashboard/metrics");
  console.log(
    `[demo-seed] Dashboard: ${metrics.totalTests} tests, passRate ${metrics.passRate}%, coverage ${metrics.requirementCoverage}%`,
  );
  console.log("\nOpen http://localhost:3000");
  console.log("Try: Dashboard · Jira (QA-DEMO) · Workspace · Suites · Scenarios · Bugs");
}

main().catch((err) => {
  console.error("[demo-seed] Failed:", err.message);
  process.exit(1);
});
