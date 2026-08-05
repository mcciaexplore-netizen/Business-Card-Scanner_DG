export const FIELD_NAMES = [
  "Name",
  "Company",
  "Designation",
  "Phone",
  "Email",
  "Website",
  "Address",
] as const;

export type FieldName = (typeof FIELD_NAMES)[number];

export type CardFields = Record<FieldName, string>;

export function emptyFields(): CardFields {
  return Object.fromEntries(FIELD_NAMES.map((n) => [n, ""])) as CardFields;
}

export interface SingleScanResult {
  detected: number;
  saved: number;
  failed: number;
  message: string;
  card: CardFields | null;
}

export interface BulkCardResult extends CardFields {
  _status: string;
}

export interface BulkScanResult {
  detected: number;
  saved: number;
  failed: number;
  message: string;
  cards: BulkCardResult[];
}
