/**
 * AuraScan storage endpoint.
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
var HEADERS = ['Name', 'Company', 'Designation', 'Phone', 'Email', 'Website', 'Address'];

function doPost(e) {
  try {
    var body = JSON.parse(e.postData.contents);

    if (body.secret !== SHARED_SECRET) {
      return jsonResponse({ status: 'error', message: 'Invalid secret.' });
    }

    var fields = body.fields || {};
    var sheet = getOrCreateSheet_();
    var row = HEADERS.map(function (h) { return fields[h] || ''; });
    sheet.appendRow(row);

    return jsonResponse({ status: 'ok' });
  } catch (err) {
    return jsonResponse({ status: 'error', message: String(err) });
  }
}

function doGet(e) {
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

  return sheet;
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
