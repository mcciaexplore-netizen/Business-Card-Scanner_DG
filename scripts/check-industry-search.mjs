import nextEnv from "@next/env";
import { loadTypeScript } from "../tests/load-typescript.mjs";

nextEnv.loadEnvConfig(process.cwd(), false, { info() {}, error() {} });
const industry = loadTypeScript("lib/industry.ts");
const { searchCompanyIndustry } = loadTypeScript("lib/industrySearch.ts", {
  "./industry": {
    parseIndustryLookup(text, grounding) {
      if (process.argv.includes("--debug")) console.log(JSON.stringify({ text, grounding }));
      return industry.parseIndustryLookup(text, grounding);
    },
  },
});
// Public company only: this smoke test neither uploads a card nor writes a sheet.
const result = await searchCompanyIndustry("Atlassian", "atlassian.com", 10000);
if (!result) {
  throw new Error("Search returned no sufficiently grounded company/industry match.");
}
console.log(JSON.stringify({ industry: result.industry, sourceCount: result.sources.length, hasSearchSuggestions: Boolean(result.searchHtml) }));
