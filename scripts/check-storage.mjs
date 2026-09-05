import nextEnv from "@next/env";
import { loadTypeScript } from "../tests/load-typescript.mjs";

nextEnv.loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
const { readableGoogleError } = loadTypeScript("lib/appsScriptResponse.ts");
const url = process.env.APPS_SCRIPT_URL;
const secret = process.env.APPS_SCRIPT_SECRET;
if (!url || !secret) throw new Error("Configure APPS_SCRIPT_URL and APPS_SCRIPT_SECRET first.");

async function readResponse(options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
  const body = await response.text();
  let data;
  try { data = JSON.parse(body); } catch { throw new Error(readableGoogleError(body)); }
  if (!response.ok || !data || data.status !== "ok") {
    throw new Error(`Apps Script ${data?.stage || "response"}: ${data?.message || response.status}`);
  }
  return data;
}

const health = await readResponse({ method: "GET" });
if (!["save-diagnostics-2", "save-column-format-3", "metadata-columns-jkl-4"].includes(health.revision)) {
  throw new Error("Deploy metadata-columns-jkl-4 before running this check. No POST was sent.");
}
// Only this known revision supports the read-only diagnostic action. Never
// send fields or fall back to append_card, even against an older deployment.
const result = await readResponse({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ secret, action: "diagnose_storage" }),
});
console.log(JSON.stringify({ revision: result.revision, ...result.report }, null, 2));
