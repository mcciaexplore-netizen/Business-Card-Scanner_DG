import type { CardFields } from "./types";

const MEANINGFUL_CARD_FIELDS = ["Name", "Company", "Phone", "Email", "Website"] as const;

/**
 * Metadata such as Industry or Extraction Engine does not prove that a card
 * was read. At least one contact-identifying field must contain real text.
 */
export function hasMeaningfulCardData(fields: CardFields): boolean {
  return MEANINGFUL_CARD_FIELDS.some((field) => fields[field].trim().length > 0);
}

export function assertMeaningfulCardData(fields: CardFields): void {
  if (!hasMeaningfulCardData(fields)) {
    throw new Error(
      "No name, company, phone, email, or website was detected. Retake the photo with the card in focus and try again."
    );
  }
}
