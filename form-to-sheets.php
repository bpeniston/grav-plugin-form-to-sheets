<?php
declare(strict_types=1);

namespace Grav\Plugin;

use Grav\Common\Plugin;
use RocketTheme\Toolbox\Event\Event;

/**
 * Adds a `sheets:` form process action that POSTs a submission to a Google
 * Apps Script web app, which appends it as a row to a Google Sheet AND sends
 * the team's notification email from the team's own Google account.
 *
 * The email lives at that end, not here, because the live server cannot send
 * mail at all: DigitalOcean blocks every outbound SMTP port and the droplet
 * has no MTA. So this action carries both jobs.
 *
 * Deliberately fail-soft: an outage at the far end must never cost the visitor
 * their submission or show them an error — it is logged instead. List `sheets:`
 * AFTER `save:` so the local CSV backup, the only leg that does not depend on
 * the network, has already been written.
 */
class FormToSheetsPlugin extends Plugin
{
    public static function getSubscribedEvents(): array
    {
        return [
            'onPluginsInitialized' => ['onPluginsInitialized', 0],
        ];
    }

    public function onPluginsInitialized(): void
    {
        if ($this->isAdmin()) {
            return;
        }

        $this->enable([
            'onFormProcessed' => ['onFormProcessed', 0],
        ]);
    }

    public function onFormProcessed(Event $event): void
    {
        if (($event['action'] ?? null) !== 'sheets') {
            return;
        }

        $log = $this->grav['log'];
        $form = $event['form'];
        $formName = $form->getName();

        try {
            $config = (array) $this->config->get('plugins.form-to-sheets', []);

            if (empty($config['enabled'])) {
                $log->warning(sprintf('form-to-sheets: skipped "%s" — plugin disabled.', $formName));
                return;
            }

            $endpoint = trim((string) ($config['endpoint'] ?? ''));
            if ($endpoint === '') {
                $log->error(sprintf('form-to-sheets: skipped "%s" — no endpoint configured.', $formName));
                return;
            }

            $data = $form->getData()->toArray();

            // Never forward spam-trap or captcha fields to the sheet.
            foreach (['website', 'basic-captcha', 'g-recaptcha-response', 'cf-turnstile-response'] as $strip) {
                unset($data[$strip]);
            }

            $payload = json_encode([
                'secret'    => (string) ($config['secret'] ?? ''),
                'form'      => $formName,
                // So the notification says whether it came from staging or
                // live — both post to the same endpoint.
                'site'      => $this->grav['uri']->rootUrl(true),
                'submitted' => gmdate('c'),
                'data'      => $data,
            ], JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);

            if ($payload === false) {
                $log->error(sprintf('form-to-sheets: could not encode "%s": %s', $formName, json_last_error_msg()));
                return;
            }

            $this->post($endpoint, $payload, (int) ($config['timeout'] ?? 10), $formName);
        } catch (\Throwable $e) {
            // Swallow everything: the submission is already in the local CSV.
            $log->error(sprintf('form-to-sheets: unexpected failure on "%s": %s', $formName, $e->getMessage()));
        }
    }

    private function post(string $endpoint, string $payload, int $timeout, string $formName): void
    {
        $log = $this->grav['log'];
        $ch = curl_init($endpoint);

        curl_setopt_array($ch, [
            CURLOPT_POST           => true,
            CURLOPT_POSTFIELDS     => $payload,
            CURLOPT_RETURNTRANSFER => true,
            // Apps Script web apps 302 to script.googleusercontent.com to serve the response.
            CURLOPT_FOLLOWLOCATION => true,
            CURLOPT_MAXREDIRS      => 5,
            CURLOPT_TIMEOUT        => max(3, $timeout),
            CURLOPT_CONNECTTIMEOUT => 10,
            CURLOPT_HTTPHEADER     => ['Content-Type: application/json'],
        ]);

        $body   = curl_exec($ch);
        $errNo  = curl_errno($ch);
        $errMsg = curl_error($ch);
        $status = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($errNo !== 0) {
            $log->error(sprintf('form-to-sheets: transport error on "%s": %s', $formName, $errMsg));
            return;
        }

        if ($status < 200 || $status >= 300) {
            $log->error(sprintf('form-to-sheets: endpoint returned HTTP %d for "%s". Body: %s', $status, $formName, substr((string) $body, 0, 500)));
            return;
        }

        // An Apps Script web app answers 200 even when it refused the request
        // (bad secret, missing tab), so HTTP status alone proves nothing —
        // the endpoint reports the real outcome in the JSON body's `ok`.
        $decoded = json_decode((string) $body, true);

        if (!is_array($decoded) || !array_key_exists('ok', $decoded)) {
            $log->error(sprintf(
                'form-to-sheets: unrecognized response for "%s" (is the URL the /exec deployment?). Body: %s',
                $formName,
                substr((string) $body, 0, 500)
            ));
            return;
        }

        if (empty($decoded['ok'])) {
            $log->error(sprintf(
                'form-to-sheets: endpoint rejected "%s": %s',
                $formName,
                (string) ($decoded['message'] ?? 'no reason given')
            ));
            return;
        }

        // The endpoint also sends the team's notification email, and reports
        // that separately: the row can be saved while the mail fails (quota,
        // bad address). Anything but an explicit false means it went out.
        if (array_key_exists('mailed', $decoded) && $decoded['mailed'] === false) {
            $log->error(sprintf(
                'form-to-sheets: appended "%s" to the sheet, but the endpoint could NOT send the notification email: %s',
                $formName,
                (string) ($decoded['message'] ?? 'no reason given')
            ));
            return;
        }

        // Log the endpoint's own message verbatim rather than a fixed success
        // string. The endpoint runs several steps after the row is saved — the
        // team notification, the requester's confirmation, Basecamp — and any
        // of them can fail while the request still counts as succeeded. Those
        // partial failures ride in `message`, and discarding it here would hide
        // them until the weekly heartbeat a week later.
        $log->info(sprintf(
            'form-to-sheets: "%s" — %s',
            $formName,
            (string) ($decoded['message'] ?? 'appended')
        ));
    }
}
