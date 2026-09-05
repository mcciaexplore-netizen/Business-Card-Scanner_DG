import { getGeminiClient, GEMINI_MODEL } from "../geminiClient";
import { EXTRACTED_FIELD_NAMES, CardFields, emptyFields } from "../types";

const RESPONSE_SCHEMA = {
  type: "object",
  properties: Object.fromEntries(EXTRACTED_FIELD_NAMES.map((n) => [n, { type: "string" }])),
  required: [...EXTRACTED_FIELD_NAMES],
};

const TEXT_EXTRACTION_PROMPT = `You are an expert business card field parser. Analyze the following raw OCR text extracted from a business card and parse it into JSON contact fields according to the schema.

Field Identification & Correction Rules:
- "Name": Identify the primary contact person's full name. Ignore generic headings like "Services", "Products", "Branch Office", "Contact Us", "ISO Certified".
- "Email": Fix OCR typos in email addresses (e.g. spaces around "@", "gma1l" -> "gmail", "c0m" -> "com").
- "Website": Clean domain names (e.g., "www . example . com" -> "www.example.com").
- "Phone": Capture EVERY phone number printed in the text (mobile, office, direct line, fax). Preserve country codes (+91, +1), area codes, and original formatting. Separate multiple numbers with " / ".
- "Company": Detect company/organization name. Look for entity suffixes ("Pvt Ltd", "Limited", "Inc", "LLC", "Corp", "Group", "Technologies", "Solutions", "Services", "Industries", etc.) or brand titles.
- "Industry": Return one concise, high-level business sector inferred from the company name, website/email domain, and any products or services in the OCR text. A person's job title is not the company's sector. Generic names containing Technologies, Solutions, or Ventures are insufficient on their own. If there is not enough business evidence, return "Unclassified"; unresolved industries are researched separately after extraction.
- "Designation": Identify job titles across all levels (CEO, MD, Director, Manager, Lead, Engineer, Consultant, Executive, Architect, Founder, Partner, Level 1-3).
- "Address": Combine multi-line street address, building/floor/plot details, colony/nagar/sector/city/state/country, and 5-6 digit PIN/ZIP codes into a single line separated by commas.
- For contact fields not present in the text, return an empty string "". Do not invent contact data. Industry may only be inferred using the evidence described above.

RAW OCR TEXT:
`;

/**
 * Sends raw OCR text string (instead of image bytes) to Gemini Text API.
 * Costs ~150 input tokens ($0.000035 / ~0.003 INR) - 100x cheaper than vision calls.
 */
export async function extractFieldsFromOcrText(rawText: string): Promise<CardFields> {
  const ai = getGeminiClient();

  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [
      { text: `${TEXT_EXTRACTION_PROMPT}\n"${rawText}"` },
    ],
    config: {
      responseMimeType: "application/json",
      responseSchema: RESPONSE_SCHEMA,
    },
  });

  const text = response.text ?? "";
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Could not parse Gemini Text API response: ${text}`);
  }

  const result = emptyFields();
  for (const name of EXTRACTED_FIELD_NAMES) {
    result[name] = String(data[name] ?? "").trim();
  }
  return result;
}
