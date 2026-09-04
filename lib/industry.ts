import type { CardFields } from "./types";

type IndustryRule = {
  industry: string;
  pattern: RegExp;
};

const INDUSTRY_RULES: IndustryRule[] = [
  {
    industry: "Government, Diplomacy & Economic Development",
    pattern: /\b(embassy|ubalozi|business france|helsinki partners|development corporation|institution for transformation|government|ministry|authority)\b/i,
  },
  {
    industry: "Export Credit Insurance",
    pattern: /\b(ecgc|export credit guarantee)\b/i,
  },
  {
    industry: "Banking & Financial Services",
    pattern: /\b(bank|banking|finserv|finance|financial|capital|receivables exchange|rxil|nasdaq|bny|carlyle|pfrda|pension fund|sidbi)\b/i,
  },
  {
    industry: "Aerospace, Drones & Propulsion",
    pattern: /\b(aerospace|rocket|propulsion|thrustworks|dynetics|volar alta|drone inspection)\b/i,
  },
  {
    industry: "Automotive & Mobility",
    pattern: /\b(automotive|autocomp|opmobility|gedia|yazaki|nexteer|renault|neuton|vehicle|ev division)\b/i,
  },
  {
    industry: "Biotechnology & Life Sciences",
    pattern: /\b(bioscience|biotech|biotechnology|life sciences|medical devices|diagnostics|pharma)\b/i,
  },
  {
    industry: "Environment, Energy & Circular Economy",
    pattern: /\b(sustainab|bioenergy|recycl|e-?waste|waste management|circular economy|ecotantra|ecomantra|enggauge|sorting swans|stenum|renewable energy|esg)\b/i,
  },
  {
    industry: "Education, Training & Skill Development",
    pattern: /\b(education|school|institute|university|academy|skill|eduplus|kalonedu|enlit kids|fuel for nation|stemium|learning|training)\b/i,
  },
  {
    industry: "Logistics, Ports & Aviation",
    pattern: /\b(logistics|air\s*&\s*sea|airport|port of|dp world|dsv|freight|shipping|supply chain)\b/i,
  },
  {
    industry: "Agriculture & Food Trade",
    pattern: /\b(agro|agri|agriculture|goldstone ag|fruit|vegetable exports|food exports)\b/i,
  },
  {
    industry: "IT, Software, Cloud & AI",
    pattern: /\b(software|technology|technologies|analytics|cloud|cyber|data platform|digital transformation|artificial intelligence|\bai\b|itechseed|leapswitch|left right mind|leftrightmind|nuagecx|orange oranges|users software|eyeshiv|proserrio)\b/i,
  },
  {
    industry: "Professional & Business Services",
    pattern: /\b(consult|advisory|kpmg|pwc|pricewaterhouse|antal|goldratt|accountant|chartered accountant|communications|recruitment|business services)\b/i,
  },
  {
    industry: "Industrial Engineering & Manufacturing",
    pattern: /\b(manufactur|machines?|engineering|valve|boiler|electrode|steel|packaging|mould|mold|shims?|thermax|aquatech|forbes marshall|geomet|autocomp|precision|fabrication|process equipment|genset|diecasting)\b/i,
  },
  {
    industry: "Trade, Import & Export",
    pattern: /\b(trading|traders|\bexim\b|exports?|imports?|ventures)\b/i,
  },
  {
    industry: "Industry Association & Nonprofit",
    pattern: /\b(council|forum|society|foundation|nonprofit|non-profit|industries club)\b/i,
  },
];

/**
 * Provides a direct, offline best-fit industry when the extraction model did
 * not return one. Company and web/email domains are weighted implicitly by
 * placing their text before the noisier designation value.
 */
export function detectIndustry(
  fields: Pick<CardFields, "Company" | "Website" | "Email" | "Designation">
): string {
  const searchable = [
    fields.Company,
    fields.Website,
    fields.Email.split("@").slice(1).join(" "),
    fields.Designation,
  ]
    .filter(Boolean)
    .join(" ")
    .replace(/[_/.-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!searchable) return "Unclassified";

  for (const rule of INDUSTRY_RULES) {
    if (rule.pattern.test(searchable)) return rule.industry;
  }

  return "Unclassified";
}

export function withDetectedIndustry(fields: CardFields): CardFields {
  const extractedIndustry = fields.Industry?.trim();
  if (extractedIndustry && !/^(unknown|n\/?a|none|unclassified)$/i.test(extractedIndustry)) {
    return { ...fields, Industry: extractedIndustry };
  }

  return { ...fields, Industry: detectIndustry(fields) };
}
