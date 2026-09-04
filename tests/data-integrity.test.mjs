import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { detectIndustry, withDetectedIndustry } from "../lib/industry.ts";
import { toSheetSafeText } from "../lib/sheetSafety.ts";
import { normalizePhoneNumbers } from "../lib/phone.ts";
import { FIELD_NAMES } from "../lib/types.ts";
import {
  OCR_CONFIDENCE_THRESHOLD,
  isOcrCandidateUsable,
  selectBestOcrCandidate,
} from "../lib/enhancement/ocrPolicy.ts";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

test("formula-leading values are escaped before Google Sheets storage", () => {
  assert.equal(toSheetSafeText("+91 98765 43210"), "'+91 98765 43210");
  assert.equal(toSheetSafeText("-9403647461"), "'-9403647461");
  assert.equal(toSheetSafeText("=IMPORTXML(\"https://example.com\")"), "'=IMPORTXML(\"https://example.com\")");
  assert.equal(toSheetSafeText("@handle"), "'@handle");
});

test("ordinary phone text stays unchanged and values are bounded", () => {
  assert.equal(toSheetSafeText("020-25573367 / 98603 88823"), "020-25573367 / 98603 88823");
  assert.equal(toSheetSafeText("x".repeat(6000)).length, 5000);
});

test("phone numbers preserve printed formatting and explicit country codes", () => {
  assert.equal(
    normalizePhoneNumbers("+91 98765-43210 / 020-25573367 / +91 98765 43210"),
    "+91 98765-43210 / 020-25573367"
  );
  assert.equal(normalizePhoneNumbers("0044 20 7946 0958"), "0044 20 7946 0958");
  assert.equal(normalizePhoneNumbers("(020) 2557 3367"), "(020) 2557 3367");
});

test("the card schema includes extraction provenance", () => {
  assert.equal(FIELD_NAMES.at(-1), "Extraction Engine");
});

test("offline industry detection classifies common business-card signals", () => {
  assert.equal(
    detectIndustry({ Company: "HDFC Bank Ltd.", Website: "hdfcbank.com", Email: "", Designation: "" }),
    "Banking & Financial Services"
  );
  assert.equal(
    detectIndustry({ Company: "GEDIA India Automotive Components", Website: "gedia.com", Email: "", Designation: "" }),
    "Automotive & Mobility"
  );
  assert.equal(
    detectIndustry({ Company: "EcoTantra LLP", Website: "ecotantra.in", Email: "", Designation: "" }),
    "Environment, Energy & Circular Economy"
  );
  assert.equal(
    detectIndustry({ Company: "", Website: "", Email: "", Designation: "" }),
    "Unclassified"
  );
});

test("a model-provided industry is preserved", () => {
  const fields = {
    Name: "Ria Deshpande",
    Company: "Jinsei Bioscience",
    Industry: "Biotechnology",
    Designation: "Founder",
    Phone: "",
    Email: "ria@example.com",
    Website: "",
    Address: "",
  };

  assert.equal(withDetectedIndustry(fields).Industry, "Biotechnology");
});

test("both local OCR engines use the same 70 percent confidence gate", () => {
  assert.equal(OCR_CONFIDENCE_THRESHOLD, 70);
  assert.equal(
    isOcrCandidateUsable({
      engine: "tesseract",
      confidence: 70,
      text: "Ria Deshpande\nFounder\nria@example.com",
    }),
    true
  );
  assert.equal(
    isOcrCandidateUsable({
      engine: "rapidocr",
      confidence: 69.9,
      text: "Ria Deshpande\nFounder\nria@example.com",
    }),
    false
  );
});

test("the strongest OCR text is selected for Gemini text fallback", () => {
  const selected = selectBestOcrCandidate([
    { engine: "tesseract", confidence: 64, text: "Tesseract readable contact text" },
    { engine: "rapidocr", confidence: 82, text: "RapidOCR readable contact text" },
  ]);

  assert.equal(selected?.engine, "rapidocr");
});

test("Apps Script contains the shared organizational abuse limits", () => {
  const source = readFileSync(resolve(projectRoot, "apps-script", "Code.gs"), "utf8");

  assert.match(source, /NORMAL_BROWSER_LIMIT_PER_MINUTE = 10/);
  assert.match(source, /NORMAL_IP_LIMIT_PER_MINUTE = 30/);
  assert.match(source, /GLOBAL_HARD_LIMIT_PER_MINUTE = 120/);
  assert.match(source, /BULK_BROWSER_LIMIT_PER_TEN_MINUTES = 5/);
  assert.match(source, /GLOBAL_CONCURRENT_BULK_LIMIT = 3/);
  assert.match(source, /'Address', 'Extraction Engine'/);
  assert.doesNotMatch(source, /MailApp|MONITORING_|disableScanning|enableScanning/);
});

test("the OCR pipeline assigns a sheet-visible engine for every success path", () => {
  const smartSource = readFileSync(
    resolve(projectRoot, "lib", "enhancement", "smartExtractor.ts"),
    "utf8"
  );
  const finalSource = readFileSync(resolve(projectRoot, "lib", "extractCard.ts"), "utf8");

  assert.match(smartSource, /engine: "Tesseract OCR"/);
  assert.match(smartSource, /engine: "RapidOCR"/);
  assert.match(smartSource, /Gemini Text fallback/);
  assert.match(finalSource, /"Gemini Vision fallback"/);
});

test("RapidOCR is opt-in and makes no localhost request when unconfigured", () => {
  const source = readFileSync(
    resolve(projectRoot, "lib", "enhancement", "rapidOcrClient.ts"),
    "utf8"
  );

  assert.match(source, /if \(!OCR_SERVICE_URL\) return false/);
  assert.doesNotMatch(source, /\|\|\s*["']http:\/\/127\.0\.0\.1:8000/);
});

test("all scan routes use the shared abuse-control boundary without monitoring", () => {
  for (const mode of ["single", "double", "bulk"]) {
    const source = readFileSync(
      resolve(projectRoot, "app", "api", "scan", mode, "route.ts"),
      "utf8"
    );
    assert.match(source, new RegExp(`beginScanRequest\\(req, ["']${mode}["']\\)`));
    assert.match(source, /rateLimitedResponse/);
    assert.doesNotMatch(source, /recordScanMonitoring|ScanMonitoringEvent/);
  }

  const bulkSource = readFileSync(
    resolve(projectRoot, "app", "api", "scan", "bulk", "route.ts"),
    "utf8"
  );
  assert.match(bulkSource, /MAX_BULK_CARDS = 50/);
  assert.match(bulkSource, /releaseBulkPermit/);
});
