/** Extract useful error text, not Google's large inline scripts or styles. */
export function readableGoogleError(html: string): string {
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(amp|lt|gt|quot|apos|nbsp);/gi, (entity) => {
      const entities: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'", "&nbsp;": " " };
      return entities[entity.toLowerCase()] || entity;
    })
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code: string) => {
      const value = code.toLowerCase().startsWith("x") ? parseInt(code.slice(1), 16) : parseInt(code, 10);
      return value > 0 && value <= 0x10ffff ? String.fromCodePoint(value) : " ";
    })
    .replace(/\s+/g, " ").trim();
  return text.slice(0, 1000) || "Google returned an HTML page without readable error details.";
}

export function assertAppsScriptSaved(body: string, httpStatus: number): void {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    const detail = /<\s*(?:!doctype|html|head|body)\b/i.test(body)
      ? readableGoogleError(body)
      : "The endpoint did not return valid JSON.";
    throw new Error(`Google did not confirm the save (HTTP ${httpStatus}): ${detail} Check the sheet before retrying to avoid duplicates.`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Apps Script returned an invalid save response. Check the sheet before retrying.");
  }
  const result = data as { status?: unknown; message?: unknown; stage?: unknown };
  if (httpStatus < 200 || httpStatus >= 300 || result.status !== "ok") {
    const stage = typeof result.stage === "string" ? ` [${result.stage.slice(0, 80)}]` : "";
    const message = typeof result.message === "string" ? result.message.slice(0, 1000) : "Invalid or unsuccessful save response.";
    throw new Error(`Apps Script${stage}: ${message} Check the sheet before retrying.`);
  }
}
