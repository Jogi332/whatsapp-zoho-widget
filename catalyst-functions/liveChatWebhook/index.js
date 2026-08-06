// liveChatWebhook
//
// This is the "External Webhook URL" target for Engati's External Live Chat
// feature (Configure > External Live Chat > External Webhook URL). Engati
// POSTs two event types here:
//   - START_CHAT    : a bot user requested a human agent
//   - USER_MESSAGE  : a bot user sent a message while in live chat
//
// Contract (from Engati's "External Live Chat V2" developer doc):
//   - MUST return a 2xx status. Engati validates this endpoint with an
//     empty-body POST when the External Webhook URL is saved in Configure;
//     a non-2xx response there means Engati won't save the setup at all.
//   - Response body is ignored by Engati - respond fast, don't block on
//     anything slow (e.g. don't wait on a downstream call before responding
//     if you can avoid it).
//
// What this function does:
//   1. Validates the packet shape.
//   2. Stores the event in a Catalyst Data Store table (`LiveChatEvents`)
//      keyed by userId, so the widget (or another function) can read recent
//      live-chat activity. This exists because once External Live Chat is
//      on, Engati says these conversations stop routing to its own
//      Messages inbox - meaning the widget's current polling of Engati's
//      /conversations GET API may NOT include live-chat messages during an
//      active live-chat session. Storing them here is the fallback so nothing
//      gets lost; how the widget actually surfaces this is a follow-up (see
//      NOTE at the bottom of this file).
//   3. Always responds 200 quickly, even on storage errors (Engati only
//      cares about receiving 2xx; log failures instead of failing the
//      response).
//
// IMPORTANT: this is an Advanced I/O function, same as whatsappProxy and
// liveChatSender - `req`/`res` are raw Node http objects, NOT Express-style.
// No req.body (must read the stream manually), no res.status().send() (must
// use res.writeHead()/res.end()). An earlier version of this file assumed
// Express conventions and crashed every invocation with
// "TypeError: res.status is not a function" - confirmed via direct curl
// test before this ever got wired into Engati's Configure screen.

const catalyst = require('zcatalyst-sdk-node');

function readBody(req) {
  return new Promise(function (resolve) {
    var data = '';
    req.on('data', function (chunk) { data += chunk; });
    req.on('end', function () { resolve(data); });
    req.on('error', function () { resolve(''); });
  });
}

module.exports = function (req, res) {
  var headers = { 'Content-Type': 'application/json' };

  readBody(req).then(function (raw) {
    var body;
    try { body = JSON.parse(raw || '{}'); } catch (e) { body = {}; }

    // Optional shared-secret check: if you set an Inbound API key when
    // configuring External Live Chat in Engati, it's sent back to us as an
    // Authorization header on every call here. Uncomment and set the
    // expected value once you've decided to use one.
    //
    // var expected = 'Basic ' + process.env.ENGATI_INBOUND_API_KEY;
    // if (req.headers['authorization'] !== expected) {
    //   res.writeHead(401, headers);
    //   res.end(JSON.stringify({ error: 'unauthorized' }));
    //   return;
    // }

    // Engati's own validation ping on Save is an empty-body POST - just ack it.
    if (!body.externalPacketType) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true, note: 'no externalPacketType - treated as validation ping' }));
      return;
    }

    var packetType = body.externalPacketType;
    var eventBody = body.body || {};
    var userId = body.userId || '';
    var botKey = body.botKey || '';
    var platform = body.platform || '';

    console.log('[liveChatWebhook] packetType=' + packetType + ' userId=' + userId + ' botKey=' + botKey);

    var catalystApp = catalyst.initialize(req);
    var table = catalystApp.datastore().table('LiveChatEvents');
    table.insertRow({
      packet_type: packetType,
      user_id: userId,
      bot_key: botKey,
      platform: platform,
      message_type: eventBody.packetType || null,
      text_value: (eventBody.text && eventBody.text.value) || null,
      media_value: (eventBody.media && eventBody.media.value) || null,
      media_mime_type: (eventBody.media && eventBody.media.mimeType) || null,
      livechat_category: eventBody.livechatCategoryName || null,
      raw_payload: JSON.stringify(body).slice(0, 5000),
      received_at: new Date().toISOString()
    }).catch(function (e) {
      // Don't fail the response over a storage hiccup - Engati only needs 2xx.
      console.error('[liveChatWebhook] LiveChatEvents insert failed: ' + (e && e.message));
    }).then(function () {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ ok: true }));
    });
  });
};

// NOTE - follow-up not covered by this function:
// The widget (app.js `fetchConversation`) currently polls Engati's
// /conversations GET endpoint directly. Once External Live Chat is enabled,
// confirm with Engati whether that endpoint still includes live-chat-window
// messages, or only bot/template messages outside live chat. If it doesn't,
// the widget (or a new proxy action) will need to also read from the
// `LiveChatEvents` table above and merge those rows into the rendered
// conversation - similar to how `localSentMessages` are merged today in
// `renderMerged()`. Not built yet; flagging so it isn't missed once this
// goes live.
