import type { CardFields } from "./types";
import { mergeCardSides } from "./mergeCardFields";

const NAME_PREFIXES = new Set([
  "mr", "mrs", "ms", "miss", "dr", "prof", "shri", "smt", "adv", "ca", "cs", "er",
]);

function words(value: string): string[] {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function normalizedName(value: string): string {
  const tokens = words(value);
  while (tokens.length > 1 && NAME_PREFIXES.has(tokens[0])) tokens.shift();
  return tokens.join(" ");
}

function normalizedCompany(value: string): string {
  const suffixes = new Set(["pvt", "private", "ltd", "limited", "llp", "inc", "corp", "corporation", "co", "company"]);
  return words(value).filter((token) => !suffixes.has(token)).join(" ");
}

function normalizedEmail(value: string): string {
  return value.trim().toLocaleLowerCase();
}

function normalizedWebsite(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#]/)[0]
    .replace(/\.$/, "");
}

function phoneKeys(value: string): Set<string> {
  return new Set(
    value
      .split(/\s*\/\s*|\s*,\s*/)
      .map((phone) => phone.replace(/\D/g, ""))
      .filter((phone) => phone.length >= 7)
      .map((phone) => phone.slice(-10))
  );
}

function overlaps(left: Set<string>, right: Set<string>): boolean {
  return [...left].some((value) => right.has(value));
}

/** Conservative duplicate test: a matching name also needs matching identity/contact evidence. */
export function areLikelySameCard(left: CardFields, right: CardFields): boolean {
  const leftName = normalizedName(left.Name);
  const rightName = normalizedName(right.Name);
  const namesMatch = Boolean(leftName && rightName && leftName === rightName);

  const emailsMatch = Boolean(
    normalizedEmail(left.Email) && normalizedEmail(left.Email) === normalizedEmail(right.Email)
  );
  const phonesMatch = overlaps(phoneKeys(left.Phone), phoneKeys(right.Phone));
  const websitesMatch = Boolean(
    normalizedWebsite(left.Website) && normalizedWebsite(left.Website) === normalizedWebsite(right.Website)
  );
  const companiesMatch = Boolean(
    normalizedCompany(left.Company) && normalizedCompany(left.Company) === normalizedCompany(right.Company)
  );

  if (namesMatch && (emailsMatch || phonesMatch || websitesMatch || companiesMatch)) return true;
  // A missing/misread name is allowed only when two strong contact identifiers agree.
  return (emailsMatch && phonesMatch) || (emailsMatch && websitesMatch) || (phonesMatch && websitesMatch);
}

export interface IndexedCard {
  index: number;
  fields: CardFields;
}

export function deduplicateExtractedCards(cards: IndexedCard[]): {
  unique: IndexedCard[];
  duplicates: Array<{ index: number; duplicateOf: number; fields: CardFields }>;
} {
  const unique: IndexedCard[] = [];
  const duplicates: Array<{ index: number; duplicateOf: number; fields: CardFields }> = [];

  for (const card of cards) {
    const existing = unique.find((candidate) => areLikelySameCard(candidate.fields, card.fields));
    if (!existing) {
      unique.push({ ...card, fields: { ...card.fields } });
      continue;
    }

    existing.fields = mergeCardSides(existing.fields, card.fields);
    duplicates.push({ index: card.index, duplicateOf: existing.index, fields: card.fields });
  }

  return { unique, duplicates };
}
