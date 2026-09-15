# Changelog

## [0.1.0] — 2026-09-06

Initial version, written for the FRC Team 449 site because no Grav plugin for Google Sheets exists in GPM (all 491 plugins in the catalog were checked at the time; re-checked at 524 on 2026-09-15, still none).

- Adds a `sheets:` form process action that POSTs a submission to a Google Apps Script web app.
- Strips `website`, `basic-captcha`, `g-recaptcha-response` and `cf-turnstile-response` from the payload so spam-trap and captcha fields never reach the spreadsheet.
- Sends the originating `site` in the payload, so staging and production can share one endpoint and still be distinguished in a notification.
- Fail-soft throughout: no outage at the far end can cost a submission or show the visitor an error.
- Decides success by reading `ok` from the JSON body rather than trusting the HTTP status, because an Apps Script web app answers `200` even when it refuses the request.
- Reports `mailed: false` distinctly, so "row saved but the notification email failed" is not logged as plain success.
- Logs the endpoint's own `message` verbatim rather than a fixed success string — with several post-persist steps at the far end, a fixed string would hide a partial failure until the next heartbeat.

### Notes for anyone reading the history

Two behaviors here look like over-engineering and are not:

**Reading `ok` instead of the status code.** An Apps Script web app returns HTTP 200 for a request it has refused outright — a bad secret, a missing tab. Trusting the status means silently losing every rejected submission.

**Logging the endpoint's message verbatim.** An earlier draft logged a fixed success string and discarded the response's `message`. That was harmless while the endpoint did one thing, but once it also sent a notification and an autoresponse, a partial failure logged as plain success. Fixed the same day it was found, by testing rather than by reading.
