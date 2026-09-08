import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createContext, runInContext } from "node:vm";
import { loadTypeScript } from "./load-typescript.mjs";
import { readableGoogleError, assertAppsScriptSaved } from "../lib/appsScriptResponse.ts";

import { detectIndustry, withDetectedIndustry, enrichIndustry, parseIndustryLookup } from "../lib/industry.ts";
import { OTHER_PERSON_VALUE, PEOPLE, readScannedBy } from "../lib/people.ts";
import { toSheetSafeText } from "../lib/sheetSafety.ts";
import { normalizePhoneNumbers } from "../lib/phone.ts";
import { assertMeaningfulCardData, hasMeaningfulCardData } from "../lib/cardValidation.ts";
import { FIELD_NAMES, EXTRACTED_FIELD_NAMES, emptyFields } from "../lib/types.ts";
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
  assert.ok(FIELD_NAMES.includes("Extraction Engine"));
  assert.ok(FIELD_NAMES.includes("Scanned By"));
  assert.ok(FIELD_NAMES.includes("Industry Source"));
  assert.ok(FIELD_NAMES.includes("Industry Sources"));
  assert.equal(new Set(FIELD_NAMES).size, FIELD_NAMES.length);
  assert.ok(!EXTRACTED_FIELD_NAMES.includes("Scanned By"));
});

test("metadata-only extraction results are rejected before sheet storage", () => {
  const emptyResult = {
    ...emptyFields(),
    Industry: "Unclassified",
    "Extraction Engine": "Gemini Vision fallback",
    "Industry Source": "Unresolved (company missing)",
  };
  assert.equal(hasMeaningfulCardData(emptyResult), false);
  assert.throws(() => assertMeaningfulCardData(emptyResult), /No name, company, phone, email, or website/);
  assert.equal(hasMeaningfulCardData({ ...emptyResult, Company: "Example Ltd" }), true);
});

test("scanner names are optional, normalized, bounded, and accept Other entries", () => {
  assert.deepEqual(PEOPLE, [
    "Aniruddha Brahma",
    "Chintamani Shrotri",
    "Ganesh Mate",
    "Mangesh Kulkarni",
    "Neeraj Thakur",
    "Nikhil Jain",
    "Prashant Jogalekar",
    "Rajnikant Gaikwad",
    "S H Kopardekar",
    "Satavisha Natu",
    "Shantanu Jagtap",
    "Sudhanwa Kopardekar",
  ]);
  assert.equal(new Set(PEOPLE.map((person) => person.toLowerCase())).size, PEOPLE.length);
  const data = new FormData();
  assert.equal(readScannedBy(data), "");
  data.set("scanned_by", "");
  assert.equal(readScannedBy(data), "");
  data.set("scanned_by", OTHER_PERSON_VALUE);
  assert.equal(readScannedBy(data), "");
  data.set("scanned_by", "  New   Person  ");
  assert.equal(readScannedBy(data), "New Person");
  data.set("scanned_by", "x".repeat(101));
  assert.throws(() => readScannedBy(data), /100 characters/);
});

test("bulk duplicate matching ignores name prefixes but requires matching card evidence", () => {
  const { areLikelySameCard, deduplicateExtractedCards } = loadTypeScript("lib/cardDeduplication.ts");
  const first = {
    ...emptyFields(),
    Name: "Dr. Nikhil Jain",
    Company: "Example Private Limited",
    Email: "nikhil@example.com",
    Phone: "+91 98765 43210",
  };
  const repeated = {
    ...emptyFields(),
    Name: "NIKHIL JAIN",
    Company: "Example Pvt Ltd",
    Email: "NIKHIL@EXAMPLE.COM",
    Phone: "98765-43210",
    Address: "Pune",
  };
  const differentPerson = {
    ...repeated,
    Company: "Different Company",
    Email: "other@example.com",
    Phone: "91234 56789",
  };
  assert.equal(areLikelySameCard(first, repeated), true);
  assert.equal(areLikelySameCard(first, differentPerson), false);
  const result = deduplicateExtractedCards([
    { index: 0, fields: first },
    { index: 1, fields: repeated },
    { index: 2, fields: differentPerson },
  ]);
  assert.equal(result.unique.length, 2);
  assert.equal(result.duplicates.length, 1);
  assert.equal(result.unique[0].fields.Address, "Pune");
});

test("bulk box deduplication removes overlapping detections before OCR", () => {
  const { deduplicateDetectedBoxes } = loadTypeScript("lib/detectCards.ts", {
    jimp: {},
    "./geminiClient": {},
    "./enhancement/rapidOcrClient": {},
  });
  const boxes = deduplicateDetectedBoxes([
    { ymin: 100, xmin: 100, ymax: 400, xmax: 600 },
    { ymin: 105, xmin: 110, ymax: 395, xmax: 595 },
    { ymin: 500, xmin: 100, ymax: 800, xmax: 600 },
  ]);
  assert.equal(boxes.length, 2);
});

test("two-sided merge keeps a classified back-side industry when front is unresolved", () => {
  const { mergeCardSides } = loadTypeScript("lib/mergeCardFields.ts");
  const result = mergeCardSides(
    { ...emptyFields(), Industry: "Unclassified", "Extraction Engine": "Tesseract OCR" },
    { ...emptyFields(), Industry: "Healthcare", "Industry Source": "Card text", "Extraction Engine": "RapidOCR" }
  );
  assert.equal(result.Industry, "Healthcare");
  assert.equal(result["Industry Source"], "Card text");
  assert.match(result["Extraction Engine"], /Tesseract OCR.*RapidOCR/);
});

test("all scan routes carry the scanner's name into saved rows and results", async () => {
  const peopleModule = loadTypeScript("lib/people.ts");
  const testPerson = "Test Person";
  for (const mode of ["single", "double", "bulk"]) {
    const saved = [];
    const overrides = {
      "next/server": { NextResponse: { json: (body) => body }, after: (callback) => callback() },
      "@/lib/people": peopleModule,
      "@/lib/scanControl": {
        beginScanRequest: async () => ({ allowed: true }),
        withScanClientCookie: (response) => response,
        rateLimitedResponse: () => assert.fail("Not limited"),
        releaseBulkPermit: async () => {},
        releaseScanImages: async () => {},
        claimScanImages: async () => ({ allowed: true }),
      },
      "@/lib/extractCard": { extractCard: async () => ({ ...emptyFields(), Name: "Test", Industry: "Healthcare" }) },
      "@/lib/storage": { appendRow: async (fields) => saved.push(fields) },
      "@/lib/industrySearch": { searchCompanyIndustry: async () => assert.fail("Industry already known") },
      "@/lib/detectCards": { detectCardBoxes: async () => [{}, {}], cropCard: async () => Buffer.from("test") },
    };
    const { POST } = loadTypeScript(`app/api/scan/${mode}/route.ts`, overrides);
    const data = new FormData();
    data.set("scanned_by", testPerson);
    data.set(mode === "double" ? "file_front" : "file", new Blob(["test"]), "card.png");
    if (mode === "double") data.set("file_back", new Blob(["back"]), "back.png");
    const response = await POST({ formData: async () => data });
    assert.equal(saved.length, mode === "bulk" ? 2 : 1);
    assert.ok(saved.every((fields) => fields["Scanned By"] === testPerson));
    assert.equal((response.card || response.cards[0])["Scanned By"], testPerson);
    data.set("scanned_by", OTHER_PERSON_VALUE);
    const optional = await POST({ formData: async () => data });
    assert.equal(optional.saved, mode === "bulk" ? 2 : 1);
    assert.equal(saved.length, mode === "bulk" ? 4 : 2);
    assert.equal((optional.card || optional.cards[0])["Scanned By"], "");
  }
});

test("all scan routes reject metadata-only cards before enrichment and storage", async () => {
  for (const mode of ["single", "double", "bulk"]) {
    let saved = 0;
    let released = 0;
    const overrides = {
      "next/server": { NextResponse: { json: (body) => body }, after: (callback) => callback() },
      "@/lib/people": loadTypeScript("lib/people.ts"),
      "@/lib/scanControl": {
        beginScanRequest: async () => ({ allowed: true }),
        withScanClientCookie: (response) => response,
        rateLimitedResponse: () => assert.fail("Not limited"),
        releaseBulkPermit: async () => {},
        releaseScanImages: async () => { released += 1; },
        claimScanImages: async () => ({ allowed: true }),
      },
      "@/lib/extractCard": {
        extractCard: async () => ({
          ...emptyFields(),
          Industry: "Unclassified",
          "Extraction Engine": "Gemini Vision fallback",
          "Industry Source": "Unresolved (company missing)",
        }),
      },
      "@/lib/storage": { appendRow: async () => { saved += 1; } },
      "@/lib/industry": { enrichIndustry: async () => assert.fail("Empty cards must not be enriched") },
      "@/lib/industrySearch": { searchCompanyIndustry: async () => assert.fail("Empty cards must not be searched") },
      "@/lib/detectCards": { detectCardBoxes: async () => [{}], cropCard: async () => Buffer.from("crop") },
    };
    const { POST } = loadTypeScript(`app/api/scan/${mode}/route.ts`, overrides);
    const data = new FormData();
    data.set("scanned_by", "Test Person");
    data.set(mode === "double" ? "file_front" : "file", new Blob([`${mode}-empty`]), "card.png");
    if (mode === "double") data.set("file_back", new Blob(["back-empty"]), "back.png");
    const response = await POST({ formData: async () => data });
    assert.equal(saved, 0);
    assert.equal(response.saved, 0);
    assert.equal(response.failed, 1);
    assert.equal(released, 1);
  }
});

function scriptFixture(rows) {
  const data = rows.map((row) => [...row]);
  const formatRanges = [];
  const cacheData = new Map();
  let maxColumns = Math.max(1, ...data.map((row) => row.length));
  let locked = false;
  const lock = { tryLock: () => { assert.equal(locked, false); locked = true; return true; }, releaseLock: () => { locked = false; } };
  const sheet = {
    getLastColumn: () => Math.max(0, ...data.map((row) => row.length)),
    getLastRow: () => { assert.equal(locked, true); return data.length; },
    getMaxColumns: () => maxColumns,
    insertColumnsAfter: (_column, count) => { maxColumns += count; },
    setFrozenRows() {},
    getRange(row, column, height, width) {
      return {
        getDisplayValues: () => Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => String(data[row - 1 + r]?.[column - 1 + c] ?? ""))),
        getValues: () => Array.from({ length: height }, (_, r) => Array.from({ length: width }, (_, c) => data[row - 1 + r]?.[column - 1 + c] ?? "")),
        setNumberFormat(format) {
          if (width !== 1) throw new Error("Please make a selection within a single column to perform column-level actions.");
          formatRanges.push({ row, column, height, width, format });
        },
        setValues(values) {
          values.forEach((valuesRow, r) => {
            data[row - 1 + r] ||= [];
            valuesRow.forEach((value, c) => { data[row - 1 + r][column - 1 + c] = value; });
          });
        },
        clearContent() {
          for (let r = 0; r < height; r++) {
            data[row - 1 + r] ||= [];
            for (let c = 0; c < width; c++) data[row - 1 + r][column - 1 + c] = "";
          }
        },
      };
    },
  };
  const context = createContext({
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => "existing-sheet" }) },
    CacheService: { getScriptCache: () => ({
      get: (key) => cacheData.get(key) ?? null,
      put: (key, value) => cacheData.set(key, value),
      remove: (key) => cacheData.delete(key),
    }) },
    Utilities: {
      DigestAlgorithm: { SHA_256: "sha256" },
      Charset: { UTF_8: "utf8" },
      computeDigest: (_algorithm, value) => Array.from({ length: 32 }, (_, index) => (String(value).charCodeAt(index % String(value).length) || index) & 255),
    },
    SpreadsheetApp: { openById: () => ({ getSheetByName: () => sheet }), create: () => assert.fail("Must reuse existing sheet"), flush: () => assert.equal(locked, true) },
    LockService: { getScriptLock: () => lock },
    Logger: { log() {} },
  });
  runInContext(readFileSync(resolve(projectRoot, "apps-script/Code.gs"), "utf8"), context);
  context.jsonResponse = (value) => value;
  return { data, sheet, context, formatRanges, isLocked: () => locked };
}

test("sheet upgrades append missing headers without relabelling or moving old data", () => {
  const headers = ["Name", "Company", "Designation", "Phone", "Email", "Website", "Address"];
  const oldRow = ["Old Person", "Old Company", "Manager", "00123", "old@example.com", "", "Old Address"];
  const { data, sheet, context } = scriptFixture([headers, oldRow]);
  context.ensureHeaders_(sheet);
  assert.deepEqual(data[0].slice(0, headers.length), headers);
  assert.deepEqual(data[1], oldRow);
  assert.ok(FIELD_NAMES.every((field) => data[0].includes(field)));
  const width = data[0].length;
  context.ensureHeaders_(sheet);
  assert.equal(data[0].length, width);
});

test("sheet writes follow reordered headers, preserve custom columns and release the write lock", () => {
  const headers = ["Company", "My Notes", "Name", "Phone"];
  const oldRow = ["Old Company", "Keep this note", "Old Person", "00123"];
  const { data, context, isLocked } = scriptFixture([headers, oldRow]);
  for (let index = 0; index < 2; index++) {
    const response = context.doPost({ postData: { contents: JSON.stringify({ secret: context.SHARED_SECRET, fields: { Company: "New Company", Name: "New Person", Phone: "+91 1234567890", "Scanned By": "Test Person", Industry: "Healthcare" } }) } });
    assert.equal(response.status, "ok");
    assert.equal(isLocked(), false);
  }
  assert.equal(data.length, 4);
  assert.deepEqual(data[1], oldRow);
  assert.equal(data[2][0], "New Company");
  assert.equal(data[2][1], "");
  assert.equal(data[2][data[0].indexOf("Scanned By")], "Test Person");
  assert.equal(data[2][3], "'+91 1234567890");
});

test("Apps Script refuses metadata-only rows even if called directly", () => {
  const rows = [["Name", "Company", "Industry", "Extraction Engine"]];
  const { data, context } = scriptFixture(rows);
  const response = context.doPost({ postData: { contents: JSON.stringify({
    secret: context.SHARED_SECRET,
    fields: { Industry: "Unclassified", "Extraction Engine": "Gemini Vision fallback" },
  }) } });
  assert.equal(response.status, "error");
  assert.equal(response.stage, "validate_card");
  assert.deepEqual(data, rows);
});

test("Apps Script duplicate claims block the same fingerprint for ten minutes", () => {
  const { context } = scriptFixture([["Name"]]);
  const request = { postData: { contents: JSON.stringify({
    secret: context.SHARED_SECRET,
    action: "duplicate_check",
    imageHash: "a".repeat(64),
    windowSeconds: 600,
  }) } };
  assert.equal(context.doPost(request).status, "ok");
  const duplicate = context.doPost(request);
  assert.equal(duplicate.status, "duplicate");
  assert.ok(duplicate.retryAfterSeconds > 0);
});

test("Apps Script releases a failed scan fingerprint for immediate retry", () => {
  const { context } = scriptFixture([["Name"]]);
  const imageHash = "b".repeat(64);
  const request = { postData: { contents: JSON.stringify({
    secret: context.SHARED_SECRET,
    action: "duplicate_check",
    imageHash,
    windowSeconds: 600,
  }) } };
  assert.equal(context.doPost(request).status, "ok");
  assert.equal(context.doPost(request).status, "duplicate");
  const released = context.doPost({ postData: { contents: JSON.stringify({
    secret: context.SHARED_SECRET,
    action: "duplicate_release",
    imageHash,
  }) } });
  assert.equal(released.status, "ok");
  assert.equal(context.doPost(request).status, "ok");
});

test("duplicate recognized headers stop a write instead of corrupting old data", () => {
  const { data, context, isLocked } = scriptFixture([["Name", "Name"], ["One", "Two"]]);
  const response = context.doPost({ postData: { contents: JSON.stringify({ secret: context.SHARED_SECRET, fields: { Name: "Three" } }) } });
  assert.equal(response.status, "error");
  assert.match(response.message, /Duplicate sheet header/);
  assert.deepEqual(data, [["Name", "Name"], ["One", "Two"]]);
  assert.equal(isLocked(), false);
});

test("deferred spreadsheet errors are caught before releasing the write lock", () => {
  const { context, isLocked } = scriptFixture([["Name"], ["Existing Person"]]);
  let flushCount = 0;
  context.SpreadsheetApp.flush = () => { assert.equal(isLocked(), true); if (++flushCount === 2) throw new Error("Spreadsheet operation failed"); };
  const response = context.doPost({ postData: { contents: JSON.stringify({ secret: context.SHARED_SECRET, fields: { Name: "Test Person" } }) } });
  assert.equal(response.status, "error");
  assert.equal(response.stage, "commit_sheet_changes");
  assert.match(response.message, /Spreadsheet operation failed/);
  assert.equal(isLocked(), false);
});

test("authenticated deployed storage diagnostic never writes rows or headers", () => {
  const rows = [["Name", "Company"], ["Existing Person", "Existing Company"]];
  const { data, context, isLocked } = scriptFixture(rows);
  context.Logger = { log() {} };
  const response = context.doPost({ postData: { contents: JSON.stringify({ secret: context.SHARED_SECRET, action: "diagnose_storage" }) } });
  assert.equal(response.status, "ok");
  assert.equal(response.revision, "retry-safe-duplicate-guard-7");
  assert.deepEqual(data, rows);
  assert.equal(isLocked(), false);
});

test("metadata migration places scanner and industry evidence at J:L without losing rows", () => {
  const headers = Array(31).fill("");
  ["Name", "Company", "Industry", "Designation", "Phone", "Email", "Website", "Extraction Engine", "Address"].forEach((header, index) => { headers[index] = header; });
  headers[28] = "Department";
  headers[29] = "Industry Source";
  headers[30] = "Industry Sources";
  const existing = Array(31).fill("");
  existing.splice(0, 9, "Person", "Company", "Healthcare", "Manager", "+91 12345 67890", "person@example.com", "example.com", "Tesseract OCR", "Pune");
  existing[28] = "Sales";
  existing[29] = "Card text";
  existing[30] = "https://example.com/about";
  const { data, context, isLocked } = scriptFixture([headers, existing]);

  const response = context.placePeopleColumnsAtJToL();
  assert.equal(response.status, "ok");
  assert.equal(isLocked(), false);
  assert.deepEqual(data[0].slice(9, 12), ["Scanned By", "Industry Source", "Industry Sources"]);
  assert.deepEqual(data[1].slice(9, 12), ["", "Card text", "https://example.com/about"]);
  assert.deepEqual(data[0].slice(28, 31), ["Department", "", ""]);
  assert.deepEqual(data[1].slice(28, 31), ["Sales", "", ""]);
  assert.deepEqual(data[1].slice(0, 9), existing.slice(0, 9));
});

test("metadata migration preserves a legacy Department in a backup column when J is reused", () => {
  const headers = [
    "Name", "Company", "Industry", "Designation", "Phone", "Email", "Website",
    "Extraction Engine", "Address", "Department", "Industry Source", "Industry Sources",
  ];
  const existing = [
    "Person", "Company", "Healthcare", "Manager", "+91 12345 67890", "person@example.com",
    "example.com", "Tesseract OCR", "Pune", "Sales", "Card text", "",
  ];
  const { data, context } = scriptFixture([headers, existing]);
  context.placePeopleColumnsAtJToL();
  assert.equal(data[0][9], "Scanned By");
  assert.equal(data[1][9], "");
  assert.equal(data[0][12], "Legacy Department");
  assert.equal(data[1][12], "Sales");
});

test("people metadata migration refuses to overwrite existing J:L content", () => {
  const headers = Array(31).fill("");
  headers[9] = "Existing notes";
  headers[28] = "Department";
  headers[29] = "Industry Source";
  headers[30] = "Industry Sources";
  const rows = [headers, Array(31).fill("")];
  const { data, context, isLocked } = scriptFixture(rows);
  assert.throws(() => context.placePeopleColumnsAtJToL(), /Column 10 must be empty/);
  assert.equal(isLocked(), false);
  assert.deepEqual(data, rows);
});

test("table formatting targets individual scanner columns, not custom columns or old rows", () => {
  const { data, context, formatRanges } = scriptFixture([["Company", "My Notes", "Name", ""], ["Original Co", "Keep note", "Original Person", "Keep data"]]);
  const response = context.doPost({ postData: { contents: JSON.stringify({ secret: context.SHARED_SECRET, fields: { Name: "New Person", Company: "New Co" } }) } });
  assert.equal(response.status, "ok");
  assert.equal(formatRanges.length, FIELD_NAMES.length);
  assert.ok(formatRanges.every((range) => range.width === 1 && range.height === 1 && range.row === 3 && range.format === "@"));
  assert.ok(formatRanges.every((range) => range.column !== 2 && range.column !== 4));
  assert.deepEqual(data[1], ["Original Co", "Keep note", "Original Person", "Keep data"]);
});

test("deferred formatting failure returns a stage before submitting card values", () => {
  const { data, context, isLocked } = scriptFixture([Array.from(FIELD_NAMES), Array(FIELD_NAMES.length).fill("Existing")]);
  context.SpreadsheetApp.flush = () => { throw new Error("Table formatting restricted"); };
  const response = context.doPost({ postData: { contents: JSON.stringify({ secret: context.SHARED_SECRET, fields: { Name: "Must not be written" } }) } });
  assert.equal(response.status, "error");
  assert.equal(response.stage, "commit_column_formats");
  assert.equal(data.length, 2);
  assert.equal(isLocked(), false);
});

test("Google HTML errors show readable content instead of inline script noise", () => {
  const html = '<!DOCTYPE html><html><head><script nonce="x">window.ppConfig={secretNoise:1}</script><style>body { color: red }</style></head><body>Authorization required. Can&#39;t access the sheet &amp; file.</body></html>';
  assert.equal(readableGoogleError(html), "Authorization required. Can't access the sheet & file.");
  assert.throws(() => assertAppsScriptSaved(html, 200), /Authorization required/);
  assert.throws(() => assertAppsScriptSaved(html, 200), /Check the sheet before retrying/);
  assert.doesNotMatch(readableGoogleError(html), /ppConfig|secretNoise|color/);
});

test("save confirmation rejects malformed JSON and surfaces Apps Script failure stages", () => {
  for (const body of ['null', '[]', '{}', '{"status":"error","message":"Permission denied","stage":"write_row"}']) {
    assert.throws(() => assertAppsScriptSaved(body, 200));
  }
  assert.throws(() => assertAppsScriptSaved('{"status":"error","message":"Permission denied","stage":"write_row"}', 200), /\[write_row\]: Permission denied/);
  assert.throws(() => assertAppsScriptSaved('{"status":"ok"}', 500));
  assert.doesNotThrow(() => assertAppsScriptSaved('{"status":"ok"}', 200));
});

test("header matching tolerates case and whitespace without duplicating or relabelling columns", () => {
  const { data, context } = scriptFixture([[" name ", "EMAIL", "Scanned By", "Industry  Source"], ["Old Person", "old@example.com", "Old Scanner", "Old source"]]);
  const response = context.doPost({ postData: { contents: JSON.stringify({ secret: context.SHARED_SECRET, fields: { Name: "New Person", Email: "new@example.com", "Scanned By": "New Scanner", "Industry Source": "Card text" } }) } });
  assert.equal(response.status, "ok");
  assert.deepEqual(data[0].slice(0, 4), [" name ", "EMAIL", "Scanned By", "Industry  Source"]);
  assert.deepEqual(data[2].slice(0, 4), ["New Person", "new@example.com", "New Scanner", "Card text"]);
  assert.equal(data[0].filter((header) => header.trim().toLowerCase() === "email").length, 1);
});

test("case-variant duplicate headers are rejected and inspection leaves data untouched", () => {
  const rows = [["Name", "Email", " email "], ["Person", "one@example.com", "two@example.com"]];
  const { data, context } = scriptFixture(rows);
  let logged = "";
  context.Logger = { log: (text) => { logged = text; } };
  const report = context.inspectScanSheet();
  assert.equal(report.duplicates[0], "Email");
  assert.doesNotMatch(logged, /one@example|two@example|Person/);
  assert.deepEqual(data, rows);
  const response = context.doPost({ postData: { contents: JSON.stringify({ secret: context.SHARED_SECRET, fields: { Name: "New" } }) } });
  assert.equal(response.status, "error");
  assert.match(response.message, /Duplicate sheet header: Email/);
  assert.deepEqual(data, rows);
});

test("industry uses card business descriptions, not the contact's job title", () => {
  const fields = { ...emptyFields(), Company: "Acme", Designation: "Software Engineer" };
  assert.equal(detectIndustry(fields), "Unclassified");
  assert.equal(detectIndustry(fields, "Acme\nSoftware Engineer"), "Unclassified");
  assert.equal(detectIndustry(fields, "Acme\nManufacturing precision valves"), "Industrial Engineering & Manufacturing");
  assert.equal(detectIndustry({ ...fields, Company: "Acme Technologies" }), "Unclassified");
});

const researchCard = () => ({ ...emptyFields(), Name: "Private Person", Company: "Acme", Industry: "Unclassified", Phone: "0123456789", Email: "private@example.com", Website: "acme.example", "Scanned By": "Chosen Scanner", "Extraction Engine": "Tesseract OCR" });

test("known card industries avoid web search", async () => {
  const result = await enrichIndustry({ ...researchCard(), Industry: "Biotechnology" }, async () => { throw new Error("Must not search"); });
  assert.equal(result.Industry, "Biotechnology");
  assert.equal(result["Industry Source"], "Card text");
});

test("web enrichment changes only industry metadata and passes only company identity", async () => {
  const original = researchCard();
  const result = await enrichIndustry(original, async (...args) => {
    assert.deepEqual(args, ["Acme", "acme.example", 10000]);
    return { industry: "Healthcare", sources: ["https://acme.example/about"], searchHtml: "<p>Search suggestions</p>" };
  });
  assert.equal(result.Industry, "Healthcare");
  assert.equal(result["Scanned By"], original["Scanned By"]);
  assert.equal(result.Phone, original.Phone);
  assert.equal(result["Extraction Engine"], "Tesseract OCR");
  assert.equal(result["Industry Sources"], "https://acme.example/about");
  assert.equal(original.Industry, "Unclassified");
});

test("ambiguous, failed, missing-company and timed-out searches never lose card data", async () => {
  for (const search of [async () => null, async () => { throw new Error("Timeout"); }, async () => ({ industry: "Healthcare", sources: [] })]) {
    const result = await enrichIndustry(researchCard(), search);
    assert.equal(result.Industry, "Unclassified");
    assert.equal(result.Phone, "0123456789");
    assert.match(result["Industry Source"], /^Unresolved/);
  }
  const noSearch = async () => { assert.fail("Search should be skipped"); };
  assert.match((await enrichIndustry(researchCard(), noSearch, 0))["Industry Source"], /time budget/);
  assert.match((await enrichIndustry({ ...researchCard(), Company: "" }, noSearch))["Industry Source"], /company missing/);
});

test("web sectors require an unambiguous match and relevant provider-grounded citations", () => {
  const text = JSON.stringify({ companyMatched: true, industry: "Healthcare" });
  const grounding = {
    webSearchQueries: ["Acme industry"],
    groundingChunks: [{ web: { uri: "https://acme.example/about" } }],
    groundingSupports: [{ segment: { text }, groundingChunkIndices: [0] }],
    searchEntryPoint: { renderedContent: "<p>Search</p>" },
  };
  assert.equal(parseIndustryLookup(text, grounding)?.industry, "Healthcare");
  const prose = "Company matched: yes\nIndustry: Healthcare\nEvidence: Acme operates in the Healthcare sector.";
  assert.equal(parseIndustryLookup(prose, { ...grounding, groundingSupports: [{ segment: { text: "Acme operates in the Healthcare sector." }, groundingChunkIndices: [0] }] })?.industry, "Healthcare");
  assert.equal(parseIndustryLookup(prose.replace("matched: yes", "matched: no"), grounding), null);
  assert.equal(parseIndustryLookup("```json\n" + text + "\n```", grounding)?.sources[0], "https://acme.example/about");
  assert.equal(parseIndustryLookup(text), null);
  assert.equal(parseIndustryLookup("null", grounding), null);
  assert.equal(parseIndustryLookup("not JSON", grounding), null);
  assert.equal(parseIndustryLookup(text.replace("true", "false"), grounding), null);
  assert.equal(parseIndustryLookup(text, { ...grounding, groundingSupports: [] }), null);
  assert.equal(parseIndustryLookup(text, { ...grounding, webSearchQueries: [] }), null);
  assert.equal(parseIndustryLookup(text, { ...grounding, groundingChunks: [{ web: { uri: "javascript:alert(1)" } }] }), null);
});

test("the web provider uses search grounding and a bounded deadline without JSON mode", async () => {
  const text = "Company matched: yes\nIndustry: Healthcare\nEvidence: Acme operates in the Healthcare sector.";
  const { searchCompanyIndustry } = loadTypeScript("lib/industrySearch.ts", {
    "./geminiClient": {
      GEMINI_MODEL: "test-model",
      getGeminiClient: () => ({ models: { generateContent: async (request) => {
        assert.deepEqual(JSON.parse(request.contents), { company: "Acme", website: "acme.example" });
        assert.deepEqual(request.config.tools, [{ googleSearch: {} }]);
        assert.equal(request.config.httpOptions.timeout, 2500);
        assert.ok(request.config.abortSignal instanceof AbortSignal);
        assert.equal(request.config.responseSchema, undefined);
        assert.equal(request.config.responseMimeType, undefined);
        return { text, candidates: [{ groundingMetadata: {
          webSearchQueries: ["Acme industry"],
          groundingChunks: [{ web: { uri: "https://acme.example/about" } }],
          groundingSupports: [{ segment: { text }, groundingChunkIndices: [0] }],
        } }] };
      } } }),
    },
  });
  assert.equal((await searchCompanyIndustry("Acme", "acme.example", 2500)).industry, "Healthcare");
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

test("all OCR engines use the same 70 percent confidence gate", () => {
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
  assert.equal(
    isOcrCandidateUsable({
      engine: "paddleocr-browser",
      confidence: 70,
      text: "Ria Deshpande\nFounder\nria@example.com",
    }),
    true
  );
});

test("the strongest OCR text is selected for Gemini text fallback", () => {
  const selected = selectBestOcrCandidate([
    { engine: "tesseract", confidence: 64, text: "Tesseract readable contact text" },
    { engine: "rapidocr", confidence: 82, text: "RapidOCR readable contact text" },
  ]);

  assert.equal(selected?.engine, "rapidocr");
});

test("browser PaddleOCR payloads are validated and mapped to bulk card boxes", () => {
  const { readBrowserOcrPayload, browserOcrCandidate, browserOcrCandidateForBox } =
    loadTypeScript("lib/browserOcrPayload.ts");
  const data = new FormData();
  data.set("paddle_ocr", JSON.stringify({
    width: 1000,
    height: 1000,
    items: [
      { poly: [[100, 100], [300, 100], [300, 140], [100, 140]], text: "Ria Deshpande", score: 0.9 },
      { poly: [[100, 160], [340, 160], [340, 200], [100, 200]], text: "ria@example.com", score: 0.8 },
      { poly: [[600, 600], [800, 600], [800, 640], [600, 640]], text: "Other card", score: 0.95 },
    ],
  }));
  const payload = readBrowserOcrPayload(data, "paddle_ocr");
  assert.equal(browserOcrCandidate(payload).engine, "paddleocr-browser");
  const firstCard = browserOcrCandidateForBox(payload, {
    ymin: 50, xmin: 50, ymax: 300, xmax: 400,
  });
  assert.match(firstCard.text, /Ria Deshpande/);
  assert.doesNotMatch(firstCard.text, /Other card/);

  data.set("invalid", "{not-json");
  assert.equal(readBrowserOcrPayload(data, "invalid"), null);
});

test("Apps Script contains the shared organizational abuse limits", () => {
  const source = readFileSync(resolve(projectRoot, "apps-script", "Code.gs"), "utf8");

  assert.match(source, /NORMAL_BROWSER_LIMIT_PER_MINUTE = 10/);
  assert.match(source, /NORMAL_IP_LIMIT_PER_MINUTE = 30/);
  assert.match(source, /GLOBAL_HARD_LIMIT_PER_MINUTE = 120/);
  assert.match(source, /BULK_BROWSER_LIMIT_PER_TEN_MINUTES = 5/);
  assert.match(source, /GLOBAL_CONCURRENT_BULK_LIMIT = 3/);
  assert.match(source, /'Extraction Engine', 'Address', 'Scanned By'/);
  assert.doesNotMatch(source, /MailApp|MONITORING_|disableScanning|enableScanning/);
});

test("the OCR pipeline assigns a sheet-visible engine for every success path", () => {
  const smartSource = readFileSync(
    resolve(projectRoot, "lib", "enhancement", "smartExtractor.ts"),
    "utf8"
  );
  const finalSource = readFileSync(resolve(projectRoot, "lib", "extractCard.ts"), "utf8");

  assert.match(smartSource, /return "Tesseract OCR"/);
  assert.match(smartSource, /return "RapidOCR"/);
  assert.match(smartSource, /return "PaddleOCR\.js"/);
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
