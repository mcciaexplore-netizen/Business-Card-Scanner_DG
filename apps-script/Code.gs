/**
 * AuraScan storage and shared traffic-control endpoint.
 *
 * Deploy this as a Web App (Deploy > New deployment > Web app) with:
 *   Execute as:      Me
 *   Who has access:  Anyone
 *
 * "Execute as: Me" is what makes this work with zero login for end
 * users - the script always runs with YOUR Google permissions, so the
 * spreadsheet it creates lives in YOUR Drive, fully owned by you. Anyone
 * who calls the resulting Web App URL never needs to authenticate with
 * Google at all; they just need SHARED_SECRET below.
 *
 * Setup:
 * 1. Go to https://script.google.com -> New project.
 * 2. Delete the default code and paste this whole file in.
 * 3. Change SHARED_SECRET below to a long random string.
 * 4. Deploy > New deployment > select type "Web app" > Execute as "Me",
 *    Who has access "Anyone" > Deploy. Authorize it when prompted (this
 *    is the one-time consent - only you, the owner, ever see it).
 * 5. Copy the Web App URL it gives you into the backend's .env as
 *    APPS_SCRIPT_URL, and put the same SHARED_SECRET value into the
 *    backend's .env as APPS_SCRIPT_SECRET.
 *
 * The spreadsheet ("Business Card Scanner", tab "Business Cards") is
 * created automatically the first time this script runs, and its ID is
 * remembered in this script's own Properties store - every future call,
 * from anyone, appends to that same spreadsheet. It's never recreated.
 */

var SHARED_SECRET = 'CHANGE-THIS-TO-A-LONG-RANDOM-SECRET';

var SPREADSHEET_TITLE = 'Business Card Scanner - DG';
var SHEET_NAME = 'Business Cards';
var HEADERS = [
  'Name', 'Company', 'Industry', 'Designation', 'Phone', 'Email', 'Website',
  'Extraction Engine', 'Address', 'Department', 'Industry Source', 'Industry Sources'
];
var METADATA_COLUMN_LAYOUT = [
  { header: 'Department', column: 10 },
  { header: 'Industry Source', column: 11 },
  { header: 'Industry Sources', column: 12 }
];
var MAX_FIELD_LENGTH = 5000;
var SCRIPT_REVISION = 'metadata-columns-jkl-4';

// Generous organizational abuse ceilings. These are shared across every
// serverless instance because Apps Script owns the counters.
var NORMAL_BROWSER_LIMIT_PER_MINUTE = 10;
var NORMAL_IP_LIMIT_PER_MINUTE = 30;
var GLOBAL_HARD_LIMIT_PER_MINUTE = 120;
var BULK_BROWSER_LIMIT_PER_TEN_MINUTES = 5;
var GLOBAL_CONCURRENT_BULK_LIMIT = 3;
// Slightly longer than the bulk route's 300-second Fluid Compute duration so
// a live job retains its global concurrency permit until it finishes.
var BULK_LEASE_MS = 330000;

function doPost(e) {
  var stage = 'parse_request';
  try {
    var body = JSON.parse(e.postData.contents);

    if (body.secret !== SHARED_SECRET) {
      return jsonResponse({ status: 'error', message: 'Invalid secret.' });
    }

    var action = body.action || 'append_card';
    stage = action;
    if (action === 'diagnose_storage') {
      // Authenticated and read-only: checks the deployed owner's sheet access.
      return jsonResponse({ status: 'ok', revision: SCRIPT_REVISION, report: inspectScanSheet() });
    }
    if (action === 'rate_check') {
      return jsonResponse(checkRateLimits_(body));
    }
    if (action === 'release_bulk') {
      releaseBulkLease_(body.bulkLeaseId);
      return jsonResponse({ status: 'ok' });
    }
    if (action !== 'append_card') {
      return jsonResponse({ status: 'error', message: 'Unknown action.' });
    }

    // Serialize migration and row allocation: concurrent scans must not share
    // the same lastRow + 1 or add the same new column twice.
    var writeLock = LockService.getScriptLock();
    if (!writeLock.tryLock(10000)) {
      return jsonResponse({ status: 'error', message: 'Sheet is busy. Please try saving again.' });
    }
    try {
      var fields = body.fields || {};
      stage = 'open_sheet_and_check_headers';
      var sheet = getOrCreateSheet_();
      stage = 'map_columns';
      var actualHeaders = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getDisplayValues()[0];
      var row = actualHeaders.map(function (h) {
        var field = canonicalHeader_(h);
        return field ? toSheetSafeText_(fields[field]) : '';
      });
      var targetRow = sheet.getLastRow() + 1;
      var target = sheet.getRange(targetRow, 1, 1, row.length);
      stage = 'format_scanner_columns';
      // Google Sheets tables reject column-level formatting across multiple
      // columns. Format individual scanner cells, leaving custom/blank columns
      // and existing rows alone.
      actualHeaders.forEach(function (header, index) {
        if (canonicalHeader_(header)) {
          sheet.getRange(targetRow, index + 1, 1, 1).setNumberFormat('@');
        }
      });
      // Surface formatting failures before submitting the new card values.
      stage = 'commit_column_formats';
      SpreadsheetApp.flush();
      stage = 'write_row';
      target.setValues([row]);
      // Apps Script may defer spreadsheet operations. Commit while the lock
      // is held and the error handler can still return a JSON failure.
      stage = 'commit_sheet_changes';
      SpreadsheetApp.flush();
    } finally {
      writeLock.releaseLock();
    }

    return jsonResponse({ status: 'ok', revision: SCRIPT_REVISION });
  } catch (err) {
    // Log the operation and exception, never request bodies or credentials.
    console.error('AuraScan ' + SCRIPT_REVISION + ' failed at ' + stage + ': ' + String(err));
    return jsonResponse({ status: 'error', message: String(err), stage: stage, revision: SCRIPT_REVISION });
  }
}

function doGet() {
  // Simple health check so the backend can confirm this endpoint is
  // reachable at startup without writing anything.
  return jsonResponse({ status: 'ok', message: 'AuraScan Apps Script endpoint is running.', revision: SCRIPT_REVISION });
}

function getOrCreateSheet_() {
  var props = PropertiesService.getScriptProperties();
  var spreadsheetId = props.getProperty('SPREADSHEET_ID');
  var spreadsheet = null;

  if (spreadsheetId) {
    try {
      spreadsheet = SpreadsheetApp.openById(spreadsheetId);
    } catch (e) {
      // The stored ID no longer points to a real/accessible spreadsheet
      // (e.g. it was deleted) - fall through and create a new one.
      spreadsheetId = null;
    }
  }

  if (!spreadsheetId) {
    spreadsheet = SpreadsheetApp.create(SPREADSHEET_TITLE);
    spreadsheetId = spreadsheet.getId();
    props.setProperty('SPREADSHEET_ID', spreadsheetId);

    var defaultSheet = spreadsheet.getSheets()[0];
    defaultSheet.setName(SHEET_NAME);
    defaultSheet.appendRow(HEADERS);
    defaultSheet.setFrozenRows(1);
  }

  var sheet = spreadsheet.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = spreadsheet.insertSheet(SHEET_NAME);
    sheet.appendRow(HEADERS);
    sheet.setFrozenRows(1);
  }

  ensureHeaders_(sheet);
  return sheet;
}

/**
 * Append missing headers without moving or relabelling historical columns.
 * Writes use header names, so reordered and custom columns remain intact.
 */
function ensureHeaders_(sheet) {
  var lastColumn = sheet.getLastColumn();
  var currentHeaders = lastColumn ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0] : [];
  var mappedHeaders = currentHeaders.map(canonicalHeader_);
  HEADERS.forEach(function (header) {
    if (mappedHeaders.indexOf(header) !== mappedHeaders.lastIndexOf(header)) {
      throw new Error('Duplicate sheet header: ' + header + '. No card was written. Run inspectScanSheet in the Apps Script editor and verify existing data before renaming any columns.');
    }
  });
  var missing = HEADERS.filter(function (header) { return mappedHeaders.indexOf(header) === -1; });
  if (missing.length) {
    var requiredColumns = lastColumn + missing.length;
    if (requiredColumns > sheet.getMaxColumns()) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), requiredColumns - sheet.getMaxColumns());
    }
    sheet.getRange(1, lastColumn + 1, 1, missing.length).setValues([missing]);
  }
  sheet.setFrozenRows(1);
}

/** Match harmless case/spacing variations without changing the user's headers. */
function canonicalHeader_(value) {
  var normalized = String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
  for (var i = 0; i < HEADERS.length; i++) {
    if (HEADERS[i].toLowerCase() === normalized) return HEADERS[i];
  }
  return '';
}

/** Run manually in the editor: reports ONLY headers, never changes sheet data. */
function inspectScanSheet() {
  var spreadsheetId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
  if (!spreadsheetId) throw new Error('No SPREADSHEET_ID is saved in this Apps Script project. Open the existing project used by the scanner.');
  var sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('Scanner tab not found: ' + SHEET_NAME);
  var lastColumn = sheet.getLastColumn();
  var headers = lastColumn ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0] : [];
  var mapped = headers.map(canonicalHeader_);
  var report = {
    tab: SHEET_NAME,
    columns: headers.map(function (header, index) {
      return { column: index + 1, header: header, scannerField: mapped[index] || '(custom/unrecognized)' };
    }),
    duplicates: HEADERS.filter(function (header) { return mapped.indexOf(header) !== mapped.lastIndexOf(header); }),
    missing: HEADERS.filter(function (header) { return mapped.indexOf(header) === -1; })
  };
  Logger.log(JSON.stringify(report, null, 2));
  return report;
}

/**
 * Run once from the Apps Script editor to place scanner metadata beside
 * Address: J=Department, K=Industry Source, L=Industry Sources.
 *
 * The function copies complete columns (headers and historical values), then
 * clears their old locations. It refuses to overwrite any content in J:L.
 */
function placeMetadataColumnsAtJToL() {
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) {
    throw new Error('Sheet is busy. Wait for active scans to finish and try again.');
  }

  try {
    var spreadsheetId = PropertiesService.getScriptProperties().getProperty('SPREADSHEET_ID');
    if (!spreadsheetId) throw new Error('No SPREADSHEET_ID is saved in this Apps Script project.');
    var sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error('Scanner tab not found: ' + SHEET_NAME);

    var lastRow = Math.max(sheet.getLastRow(), 1);
    if (sheet.getMaxColumns() < 12) {
      sheet.insertColumnsAfter(sheet.getMaxColumns(), 12 - sheet.getMaxColumns());
    }

    var lastColumn = sheet.getLastColumn();
    var headers = lastColumn ? sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0] : [];
    var mapped = headers.map(canonicalHeader_);
    var plans = METADATA_COLUMN_LAYOUT.map(function (item) {
      var matches = [];
      mapped.forEach(function (header, index) {
        if (header === item.header) matches.push(index + 1);
      });
      if (matches.length > 1) {
        throw new Error('Duplicate sheet header: ' + item.header + '. No columns were moved.');
      }

      var sourceColumn = matches.length ? matches[0] : 0;
      if (sourceColumn !== item.column) {
        var targetValues = sheet.getRange(1, item.column, lastRow, 1).getDisplayValues();
        var occupied = targetValues.some(function (row) { return String(row[0] || '').trim() !== ''; });
        if (occupied) {
          throw new Error('Column ' + item.column + ' must be empty before placing ' + item.header + '. No columns were moved.');
        }
      }

      var values = sourceColumn
        ? sheet.getRange(1, sourceColumn, lastRow, 1).getValues()
        : Array.from({ length: lastRow }, function (_, index) { return [index === 0 ? item.header : '']; });
      return { header: item.header, sourceColumn: sourceColumn, targetColumn: item.column, values: values };
    });

    plans.forEach(function (plan) {
      if (plan.sourceColumn !== plan.targetColumn) {
        sheet.getRange(1, plan.targetColumn, lastRow, 1).setValues(plan.values);
      }
    });
    SpreadsheetApp.flush();

    plans.forEach(function (plan) {
      if (plan.sourceColumn && plan.sourceColumn !== plan.targetColumn) {
        sheet.getRange(1, plan.sourceColumn, lastRow, 1).clearContent();
      }
    });
    SpreadsheetApp.flush();
    ensureHeaders_(sheet);
    SpreadsheetApp.flush();

    var result = { status: 'ok', message: 'Metadata columns placed at J:L.', revision: SCRIPT_REVISION };
    Logger.log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    lock.releaseLock();
  }
}

/** Store untrusted OCR/model output as bounded text, never as a formula. */
function toSheetSafeText_(value) {
  var text = value == null ? '' : String(value);
  text = text.substring(0, MAX_FIELD_LENGTH);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function checkRateLimits_(body) {
  var mode = String(body.mode || 'single');
  var clientId = stableKey_(body.clientId || 'unknown-client');
  var ipHash = stableKey_(body.ipHash || 'unknown-ip');
  var now = Date.now();
  var lock = LockService.getScriptLock();

  // Rate-limit infrastructure must not prevent ordinary scanning when Google
  // is briefly busy. The caller also fails open on network errors.
  if (!lock.tryLock(3000)) {
    return { status: 'ok' };
  }

  var props = PropertiesService.getScriptProperties();
  var cache = CacheService.getScriptCache();
  var result;

  try {
    var rules = [
      { key: 'RATE_GLOBAL', windowMs: 60000, limit: GLOBAL_HARD_LIMIT_PER_MINUTE }
    ];

    if (mode === 'bulk') {
      rules.push({
        key: 'RATE_BULK_BROWSER_' + clientId,
        windowMs: 600000,
        limit: BULK_BROWSER_LIMIT_PER_TEN_MINUTES
      });
    } else {
      rules.push({
        key: 'RATE_NORMAL_BROWSER_' + clientId,
        windowMs: 60000,
        limit: NORMAL_BROWSER_LIMIT_PER_MINUTE
      });
      rules.push({
        key: 'RATE_NORMAL_IP_' + ipHash,
        windowMs: 60000,
        limit: NORMAL_IP_LIMIT_PER_MINUTE
      });
    }

    var states = rules.map(function (rule) {
      return {
        rule: rule,
        state: getWindowState_(cache, rule.key, now, rule.windowMs)
      };
    });

    var blocked = states.filter(function (entry) {
      return entry.state.count >= entry.rule.limit;
    });

    if (blocked.length > 0) {
      var retryAfterMs = Math.max.apply(null, blocked.map(function (entry) {
        return Math.max(1000, entry.state.startedAt + entry.rule.windowMs - now);
      }));
      return {
        status: 'limited',
        retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
        message: 'The scanner is receiving unusually high traffic. Please try again shortly.'
      };
    }

    var bulkLeaseId = '';
    if (mode === 'bulk') {
      var leases = getActiveBulkLeases_(props, now);
      if (leases.length >= GLOBAL_CONCURRENT_BULK_LIMIT) {
        return {
          status: 'limited',
          retryAfterSeconds: 30,
          message: 'Three bulk scans are already running. Please try again shortly.'
        };
      }
      bulkLeaseId = Utilities.getUuid();
      leases.push({ id: bulkLeaseId, expiresAt: now + BULK_LEASE_MS });
      props.setProperty('ACTIVE_BULK_LEASES', JSON.stringify(leases));
    }

    states.forEach(function (entry) {
      entry.state.count += 1;
      cache.put(
        entry.rule.key,
        JSON.stringify(entry.state),
        Math.ceil(entry.rule.windowMs / 1000) + 5
      );
    });

    result = { status: 'ok', bulkLeaseId: bulkLeaseId || undefined };
  } finally {
    lock.releaseLock();
  }

  return result;
}

function getWindowState_(cache, key, now, windowMs) {
  var raw = cache.get(key);
  if (raw) {
    try {
      var state = JSON.parse(raw);
      if (state.startedAt && now - Number(state.startedAt) < windowMs) {
        return { startedAt: Number(state.startedAt), count: Number(state.count) || 0 };
      }
    } catch (ignored) {}
  }
  return { startedAt: now, count: 0 };
}

function stableKey_(value) {
  var digest = Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    String(value),
    Utilities.Charset.UTF_8
  );
  return digest.map(function (byte) {
    var normalized = byte < 0 ? byte + 256 : byte;
    return ('0' + normalized.toString(16)).slice(-2);
  }).join('').substring(0, 24);
}

function getActiveBulkLeases_(props, now) {
  try {
    var leases = JSON.parse(props.getProperty('ACTIVE_BULK_LEASES') || '[]');
    return leases.filter(function (lease) { return Number(lease.expiresAt) > now; });
  } catch (ignored) {
    return [];
  }
}

function releaseBulkLease_(leaseId) {
  if (!leaseId) return;
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(3000)) return;
  try {
    var props = PropertiesService.getScriptProperties();
    var leases = getActiveBulkLeases_(props, Date.now()).filter(function (lease) {
      return lease.id !== String(leaseId);
    });
    props.setProperty('ACTIVE_BULK_LEASES', JSON.stringify(leases));
  } finally {
    lock.releaseLock();
  }
}

function jsonResponse(obj) {
  // Apps Script Web Apps can't set custom HTTP status codes on
  // ContentService output - success/error is always encoded in the JSON
  // body itself (HTTP status is always 200 for a script that ran
  // without throwing). The backend checks the "status" field, not the
  // HTTP status code.
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
