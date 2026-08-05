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
// Deployment: add this as a new function (Advanced I/O, Node.js) inside the
// same Catalyst project as `whatsappProxy` (Project-Rainfall), or as its own
// project - whichever matches how the existing proxy is organized. Copy this
// file in as the function's index.js, deploy, then copy the resulting
// function URL into Engati's "External Webhook URL" field once External Live
// Chat is enabled on the new bot (Customer ID 126125 / Bot Key
// cce5df75e8bb4d41).

const catalyst = require('zcatalyst-sdk-node');

module.exports = async (req, res) => {
  const catalystApp = catalyst.initialize(req);

  // Optional shared-secret check: if you set an Inbound API key when
  // configuring External Live Chat in Engati, it's sent back to us as an
  // Authorization header on every call here. Uncomment and set the expected
  // value (e.g. via a Catalyst environment variable) once you've decided to
  // use one.
  //
  // const expected = 'Basic ' + process.env.ENGATI_INBOUND_API_KEY;
  // if (req.headers['authorization'] !== expected) {
  //   res.status(401).send({ error: 'unauthorized' });
  //   return;
  // }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  // Engati's own validation ping on Save is an empty-body POST - just ack it.
  if (!body.externalPacketType) {
    res.status(200).send({ ok: true, note: 'no externalPacketType - treated as validation ping' });
    return;
  }

  const packetType = body.externalPacketType;
  const eventBody = body.body || {};
  const userId = body.userId || '';
  const botKey = body.botKey || '';
  const platform = body.platform || '';

  console.log('[liveChatWebhook] packetType=' + packetType + ' userId=' + userId + ' botKey=' + botKey);

  try {
    const table = catalystApp.datastore().table('LiveChatEvents');
    await table.insertRow({
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
    });
  } catch (e) {
    // Don't fail the response over a storage hiccup - Engati only needs 2xx.
    console.error('[liveChatWebhook] LiveChatEvents insert failed: ' + (e && e.message));
  }

  res.status(200).send({ ok: true });
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
