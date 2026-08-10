# Catalyst functions for Engati External Live Chat

Two new functions, written ahead of Engati enabling External Live Chat on
the new bot (Customer ID `126125`, Bot Key `cce5df75e8bb4d41`). **Not yet
deployed or tested** — Engati hasn't confirmed the feature is on yet, so
none of this can be exercised end-to-end. Written now so it's ready to wire
up the moment they confirm.

Neither of these lives in `Project-Rainfall`/`whatsappProxy` directly —
that project isn't checked out in this repo, so these are written as
standalone functions following the same request/response conventions
`whatsappProxy` already uses (JSON body with an `action` field, response
shaped `{statusCode, body}`). Merge them into that project or deploy as
siblings, whichever fits the existing setup better.

## `liveChatWebhook/`

Engati's **External Webhook URL** target. Receives `START_CHAT` and
`USER_MESSAGE` POSTs from Engati whenever a bot user requests/is in live
chat. Must return 2xx — Engati validates this with an empty-body POST when
you save the URL in Engati's Configure screen, and won't save the setup on
a non-2xx response.

Stores events in a Catalyst Data Store table `LiveChatEvents` (needs
creating in the Catalyst console before this runs — insert will otherwise
fail silently, though the function still returns 200 to Engati regardless).

## `liveChatSender/`

Sends `AGENT_MESSAGE` (agent replies, text or media) and `RESOLVE_LIVE_CHAT`
(hand back to bot) to Engati's **Inbound Message Webhook URL** — a
different, Engati-generated URL you get once External Live Chat is enabled
(shown in the same Configure screen, format looks like
`https://agents.engati.ai/livechat/webhook/<id>`). Currently reads it from
`ENGATI_INBOUND_MESSAGE_WEBHOOK_URL`, which is **unset** — fill it in once
Engati confirms and that URL exists.

## Not yet resolved — needs Engati's confirmation reply, not guessable now

1. **Does an Inbound API key apply to both directions?** The doc shows it
   on requests *to* our webhook (`liveChatWebhook`); unclear whether Engati
   also expects it on packets *we* send to their Inbound Message Webhook
   URL. Confirm once testing live.
2. **Does the widget's existing `/conversations` polling still show
   live-chat messages?** Engati's doc says live chat requests "stop
   routing to the internal Engati Messages inbox" once External Live Chat
   is on — if that also means the `/conversations` GET API (which
   `app.js` `fetchConversation()` polls today) stops including live-chat
   messages, the widget needs a second source of truth for the live-chat
   window: reading back from the `LiveChatEvents` table `liveChatWebhook`
   writes to. Not built. Flagged as a likely follow-up, not assumed.
3. **All-or-nothing on the bot.** Enabling External Live Chat routes *all*
   live chat for that bot through this webhook — no partial rollout.
4. **Attachments still need file hosting.** `liveChatSender`'s
   `sendAgentMessage` action accepts a `media: {value, mimeType}` per the
   Engati spec — `value` must already be a public URL. Nothing here
   uploads files or produces that URL; that's a separate decision (Catalyst
   file storage vs. Zoho's own attachment APIs vs. a CDN), not started.

## Once Engati confirms

1. Get the External Webhook URL / Inbound Message Webhook URL / optional
   Inbound API key from Engati's Configure screen.
2. Deploy `liveChatWebhook`, set its resulting Catalyst function URL as
   Engati's "External Webhook URL," save — this triggers Engati's
   validation POST, confirm it gets a 2xx.
3. Create the `LiveChatEvents` Data Store table.
4. Set `ENGATI_INBOUND_MESSAGE_WEBHOOK_URL` (and the API key, if needed)
   as env vars on `liveChatSender`, deploy it.
5. Wire `app.js` to call `liveChatSender` (mirroring
   `sendTemplateViaProxy()`) instead of the current, permanently-blocked
   `sendFreeTextMessage()` → `/broadcast` call.
6. Resolve open question #2 above before assuming incoming live-chat
   messages will just show up in the widget.
