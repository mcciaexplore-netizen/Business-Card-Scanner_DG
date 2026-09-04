function phoneIdentity(value: string): string {
  const extension = value.match(/(?:ext(?:ension)?\.?|x)\s*[:.-]?\s*(\d{1,6})\b/i)?.[1] || "";
  return `${value.replace(/\D/g, "")}:${extension}`;
}

/**
 * Preserves phone formatting printed on the card while making the multi-number
 * separator consistent. Country/area codes are never guessed or discarded.
 */
export function normalizePhoneNumbers(value: string): string {
  const parts = String(value || "")
    .split(/\s*(?:\/|;|\||\r?\n|\s+(?:and|or)\s+)\s*/i)
    .map((phone) => phone.replace(/\s+/g, " ").trim())
    .filter((phone) => (phone.match(/\d/g) || []).length >= 5);

  const seen = new Set<string>();
  return parts
    .filter((phone) => {
      const key = phoneIdentity(phone);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(" / ");
}
