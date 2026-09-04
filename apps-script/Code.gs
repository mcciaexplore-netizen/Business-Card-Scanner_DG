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
  'Address', 'Extraction Engine'
];
var MAX_FIELD_LENGTH = 5000;

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
  try {
    var body = JSON.parse(e.postData.contents);

    if (body.secret !== SHARED_SECRET) {
      return jsonResponse({ status: 'error', message: 'Invalid secret.' });
    }

    var action = body.action || 'append_card';
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

    var fields = body.fields || {};
    var sheet = getOrCreateSheet_();
    var row = HEADERS.map(function (h) { return toSheetSafeText_(fields[h]); });
    var target = sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length);
    target.setNumberFormat('@');
    target.setValues([row]);

    return jsonResponse({ status: 'ok' });
  } catch (err) {
    return jsonResponse({ status: 'error', message: String(err) });
  }
}

function doGet() {
  // Simple health check so the backend can confirm this endpoint is
  // reachable at startup without writing anything.
  return jsonResponse({ status: 'ok', message: 'AuraScan Apps Script endpoint is running.' });
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
 * Adds newly introduced columns to sheets created by older deployments.
 * Existing historical rows remain aligned and receive blank values in the new
 * columns; only newly scanned cards contain the added metadata.
 */
function ensureHeaders_(sheet) {
  var lastColumn = Math.max(sheet.getLastColumn(), 1);
  var currentHeaders = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];

  if (currentHeaders.indexOf('Industry') === -1) {
    var companyIndex = currentHeaders.indexOf('Company');
    if (companyIndex >= 0) {
      sheet.insertColumnAfter(companyIndex + 1);
    }
  }

  lastColumn = Math.max(sheet.getLastColumn(), 1);
  currentHeaders = sheet.getRange(1, 1, 1, lastColumn).getDisplayValues()[0];
  if (currentHeaders.indexOf('Extraction Engine') === -1) {
    var addressIndex = currentHeaders.indexOf('Address');
    if (addressIndex >= 0) {
      sheet.insertColumnAfter(addressIndex + 1);
    }
  }

  sheet.getRange(1, 1, 1, HEADERS.length).setValues([HEADERS]);
  sheet.setFrozenRows(1);
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
