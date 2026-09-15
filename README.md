# Form to Sheets Plugin

The **Form to Sheets** plugin for [Grav CMS](https://getgrav.org) adds a `sheets:` form process action that hands each submission to a [Google Apps Script](https://developers.google.com/apps-script) web app, which appends it as a row to a Google Sheet — and, if you want, sends the notification email from the same Google account.

It is deliberately small: one process action, one outbound POST, no dependencies beyond Grav's own Form plugin.

## Why

Two problems, one solution.

**Form submissions have to land somewhere people can read.** Grav's built-in `save:` action writes each submission to a file under `user/data/`, which is correct but not reachable: that folder is blocked from the web, and Grav's admin has no file browser for it. On a typical setup you need SSH to read a submission — which is fine for a developer and useless for everyone else on the team. A Google Sheet is somewhere non-technical people can actually look.

**Some servers cannot send email at all.** The site this was written for runs on a host that blocks every outbound SMTP port, with no MTA installed — so Grav's `email:` action can never work there, by any configuration. Because an Apps Script already runs inside a Google account, it can send mail with no SMTP server, no API key, and no DNS records. Moving the notification to that end sidesteps the problem entirely.

If your server *can* send mail, you can ignore the second half and use this purely to get rows into a spreadsheet.

## Prior art

There is no Google Sheets plugin in GPM — all 506 plugins in the catalog were checked by name and slug (September 2026), and a GitHub search outside GPM turned up nothing either.

The one functional overlap is **[rest-form](https://github.com/andreaschiona/grav-plugin-rest-form)**, which adds a `rest:` action that POSTs form contents to a URL. It wasn't usable here, and the reasons are worth stating because they're the requirements this plugin exists to meet:

- **It calls `die()` on failure** — twice. A non-2xx response or an error status kills the request mid-flight, so the visitor gets a broken page *and* every process action listed after it is abandoned. If `save:` is listed after it, a remote outage costs you the local backup too. This plugin instead swallows every failure and logs it.
- **It reads `$_POST['data']` directly** rather than the validated form data, so honeypot and captcha fields are forwarded to the destination along with everything else.
- **No shared secret** — the endpoint's URL is its only protection.
- **No timeout** — a hanging endpoint hangs the submission.
- Last commit November 2017, declares Grav 1.7 compatibility only.

Adapting it would have meant rewriting the failure handling, the payload construction, and the auth model — which is most of the plugin.

## Requirements

- Grav 1.7+
- The [Form](https://github.com/getgrav/grav-plugin-form) plugin, 7.0+
- PHP with cURL
- Outbound HTTPS from the web server (Apps Script is reached over HTTPS)

## Install

There is no GPM package. Copy the plugin folder into `user/plugins/form-to-sheets/`:

```
user/plugins/form-to-sheets/
├── blueprints.yaml
├── form-to-sheets.php
└── form-to-sheets.yaml
```

Make sure the files are readable by the web server user. On a setup where Grav's files are owned by a separate user, that usually means something like:

```bash
sudo install -d -o <grav-user> -g <grav-group> -m 755 user/plugins/form-to-sheets
sudo install -o <grav-user> -g <grav-group> -m 644 <source>/* user/plugins/form-to-sheets/
```

## Configure

In **Admin → Plugins → Form to Sheets**, or in `user/config/plugins/form-to-sheets.yaml`:

| Setting | Meaning |
|---|---|
| `enabled` | Turn the plugin on or off. |
| `endpoint` | The Apps Script web app's `/exec` URL. |
| `secret` | A shared string sent with every POST. Your script should reject anything that doesn't match. |
| `timeout` | Seconds to wait for the endpoint. Minimum 3, default 10. |

**Both values are secrets.** Keep them in config, never in page front matter — the plugin reads them server-side and they never appear in the rendered page.

## Use

Add `sheets: true` to the form's `process:` block:

```yaml
form:
  name: my-form
  fields:
    # ...
  process:
    - basic-captcha: true
    - save:
        filename: my-form.csv
        operation: add
        body: '...'
    - sheets: true
    - message: 'Thanks — we got it.'
    - reset: true
```

**Put `sheets:` after `save:`.** `save:` writes to local disk and depends on nothing external, so letting it run first means a network problem at the Google end can never cost you the submission. Keep the local copy even once the Sheet is working — it's the only leg with no third-party dependency.

## The endpoint contract

The plugin POSTs a JSON body with `Content-Type: application/json`:

```json
{
  "secret":    "<your shared secret>",
  "form":      "my-form",
  "site":      "https://example.org",
  "submitted": "2026-09-15T04:32:24+00:00",
  "data":      { "email": "...", "name": "..." }
}
```

- `site` is the originating site's root URL, so **several sites can share one endpoint** and still be told apart in a notification.
- `submitted` is UTC ISO-8601. If you also write a timestamp locally, use UTC there too, or the same submission will appear to be two records dated differently.
- `data` is the submitted values, with **`website`, `basic-captcha`, `g-recaptcha-response` and `cf-turnstile-response` removed** — spam-trap and captcha fields never reach your spreadsheet.

Your script must reply with JSON containing at least `ok`:

```json
{ "ok": true, "mailed": true, "message": "appended and notified" }
```

| Field | Meaning |
|---|---|
| `ok` | **Required, boolean.** Whether the submission was stored. |
| `mailed` | Optional. Send `false` to report that the row was saved but the notification email failed — logged distinctly. |
| `message` | Optional. Logged verbatim, so use it to report partial failures. |

**Why `ok` rather than the HTTP status:** an Apps Script web app answers `200` even when it refuses a request, so the status code proves nothing. The plugin decides success by reading `ok` out of the body, and logs an explicit error if the response isn't JSON with an `ok` key at all — which is usually the sign that `endpoint` points at the editor rather than the `/exec` deployment.

## Failure behavior

The action is **fail-soft by design**: it is wrapped so that no failure at the Google end can cost the visitor their submission or show them an error. Every outcome is written to `grav.log` instead, prefixed `form-to-sheets`:

- plugin disabled, or no endpoint configured — logged, skipped
- transport error, non-2xx, or unparseable response — logged as an error
- endpoint returned `ok: false` — logged with the endpoint's own message
- `ok: true` but `mailed: false` — logged as "row saved, email did not go out"
- success — logs the endpoint's `message` verbatim rather than a fixed string, so partial failures downstream still surface

That last point matters when the script does several things after storing the row. A fixed success string would hide a failed autoresponse behind a cheerful log line.

## A note on testing the endpoint by hand

Testing an Apps Script `/exec` URL with `curl -L` returns a misleading **HTTP 405 / "Sorry, unable to open the file at this time"** even when the deployment is perfectly healthy — Apps Script answers with a 302 to `script.googleusercontent.com` and command-line redirect handling mangles the follow-up. Two things tell you it's actually fine:

- A **GET** that returns an Apps Script error page with HTTP 200 (`Script function not found: doGet`) means reachable and public — a *good* sign if your script only defines `doPost`.
- PHP's `CURLOPT_FOLLOWLOCATION`, which this plugin uses, handles the redirect correctly.

To check a deployment end to end without writing a junk row, POST with a **deliberately wrong secret**. A healthy endpoint replies `{"ok":false,"message":"bad secret"}` and stores nothing — which proves reachability, redirect handling, JSON parsing and the secret gate in one call.

## Security

- The endpoint URL and secret are read server-side and are never rendered into the page, so neither appears in page source.
- The secret is what actually protects the spreadsheet: an Apps Script web app deployed with "Anyone" access has no other gate, because the site posts without a Google login.
- Captcha and honeypot fields are stripped before the payload is built.
- The plugin only ever sends data outward. It does not act on the response beyond logging it.

## License

MIT — see [LICENSE](LICENSE).
