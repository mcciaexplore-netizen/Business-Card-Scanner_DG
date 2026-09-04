const MAX_FIELD_LENGTH = 5000;

/**
 * Google Sheets treats leading =, +, -, and @ characters as formula input.
 * Prefix them with an apostrophe and cap their length before storage.
 */
export function toSheetSafeText(value: unknown): string {
  const text = String(value ?? "").slice(0, MAX_FIELD_LENGTH);
  return /^[=+\-@]/.test(text) ? `'${text}` : text;
}
