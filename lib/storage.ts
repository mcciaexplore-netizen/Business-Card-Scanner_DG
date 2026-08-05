import { CardFields } from "./types";

/**
 * Storage is the same Google Apps Script Web App as the Python version -
 * running under the sheet owner's own Google account, so there's zero
 * login for scanning users and zero Google credential of any kind on
 * this side, just a plain HTTP POST with a shared secret.
 */

const REQUEST_TIMEOUT_MS = 20000;

export async function checkReachable(): Promise<boolean> {
  const url = process.env.APPS_SCRIPT_URL;
  if (!url) return false;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    clearTimeout(timeout);
    if (!res.ok) return false;
    const data = await res.json();
    return data?.status === "ok";
  } catch {
    return false;
  }
}

export async function appendRow(fields: CardFields): Promise<void> {
  const url = process.env.APPS_SCRIPT_URL;
  const secret = process.env.APPS_SCRIPT_SECRET;

  if (!url) {
    throw new Error(
      "APPS_SCRIPT_URL is not set. Deploy apps-script/Code.gs as a Web App and put its URL in the environment."
    );
  }
  if (!secret) {
    throw new Error(
      "APPS_SCRIPT_SECRET is not set. It must match the SHARED_SECRET value inside apps-script/Code.gs."
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, fields }),
      signal: controller.signal,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    throw new Error(`Could not reach the Apps Script endpoint: ${message}`);
  } finally {
    clearTimeout(timeout);
  }

  const responseText = await response.text();

  if (!response.ok) {
    throw new Error(`Apps Script endpoint returned HTTP ${response.status}: ${responseText.slice(0, 300)}`);
  }

  let data: { status?: string; message?: string };
  try {
    data = JSON.parse(responseText);
  } catch {
    throw new Error(
      `Apps Script endpoint returned a non-JSON response (check that it's deployed with access 'Anyone'): ${responseText.slice(0, 300)}`
    );
  }

  if (data.status !== "ok") {
    throw new Error(`Apps Script reported an error: ${data.message ?? "unknown error"}`);
  }
}
