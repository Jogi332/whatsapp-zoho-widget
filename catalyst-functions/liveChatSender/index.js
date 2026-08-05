// liveChatSender
//
// Sends AGENT_MESSAGE and RESOLVE_LIVE_CHAT packets to Engati's "Inbound
// Message Webhook URL" - the system-generated URL Engati shows in
// Configure > External Live Chat once the feature is enabled (it looks
// like https://agents.engati.ai/livechat/webhook/<id>). This is the
// mechanism for an agent (our widget) to actually send replies once
// External Live Chat is on - it replaces the old direct call to Engati's
// /broadcast endpoint, which is permanently blocked without this add-on.
//
// This follows the same request/response shape as the existing
// `whatsappProxy` function's `sendTemplate` action (widget calls this via
// fetch with a JSON body naming an `action`), so the widget's
// `sendTemplateViaProxy()` pattern in app.js can be copied for these new
// actions once this is deployed and wired up. Either merge this file's
// logic into `whatsappProxy` as two new actions, or deploy it as a sibling
// function - whichever matches your existing project layout.
//
// Expected POST body from the widget:
//   { action: "sendAgentMessage", phone, text, media, platform, botKey, botIdentifier }
//   { action: "resolveLiveChat", phone, platform, botKey, botIdentifier }
//
// `phone`/`userId`: Engati's packets use `userId`, which for a WhatsApp
// channel-user is the same identifier already used elsewhere in this
// project (see `normalizePhone()` in app.js and the `/channel-user/<id>/`
// path segment used by `fetchConversation()`).
//
// ENGATI_INBOUND_MESSAGE_WEBHOOK_URL is NOT known yet - External Live Chat
// isn't enabled on the new bot (Customer ID 126125 / Bot Key
// cce5df75e8bb4d41) as of writing this. Fill it in as a Catalyst
// environment variable (or CRM Variable, matching the existing
// ENGATI_CUSTOMER_ID/BOT_ID/API_KEY pattern) once Engati provides it.

const fetch = require('node-fetch'); // or global fetch if your Catalyst Node runtime supports it

const INBOUND_MESSAGE_WEBHOOK_URL = process.env.ENGATI_INBOUND_MESSAGE_WEBHOOK_URL || '';

module.exports = async (req, res) => {
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const action = body.action;

  if (!INBOUND_MESSAGE_WEBHOOK_URL) {
    res.status(200).send({
      statusCode: 400,
      body: JSON.stringify({ error: 'ENGATI_INBOUND_MESSAGE_WEBHOOK_URL not configured yet - External Live Chat not enabled' })
    });
    return;
  }

  if (action === 'sendAgentMessage') {
    await handleAgentMessage(body, res);
    return;
  }

  if (action === 'resolveLiveChat') {
    await handleResolveLiveChat(body, res);
    return;
  }

  res.status(200).send({ statusCode: 400, body: JSON.stringify({ error: 'unknown action: ' + action }) });
};

async function handleAgentMessage(body, res) {
  const phone = body.phone;
  const text = body.text; // plain string, for TEXT messages
  const media = body.media; // { value: <url>, mimeType: <string> }, for IMAGE/AUDIO/VIDEO

  if (!phone) {
    res.status(200).send({ statusCode: 400, body: JSON.stringify({ error: 'phone required' }) });
    return;
  }

  const packetType = media ? inferPacketType(media.mimeType) : 'TEXT';

  const enginePacket = {
    externalPacketType: 'AGENT_MESSAGE',
    body: {
      packetType: packetType,
      text: text ? { value: text } : undefined,
      media: media ? { value: media.value, mimeType: media.mimeType } : undefined,
      timestamp: new Date().toISOString()
    },
    platform: body.platform || 'whatsapp',
    userId: phone,
    botKey: body.botKey || 'cce5df75e8bb4d41',
    botIdentifier: body.botIdentifier || ''
  };

  await forwardToEngati(enginePacket, res);
}

async function handleResolveLiveChat(body, res) {
  const phone = body.phone;
  if (!phone) {
    res.status(200).send({ statusCode: 400, body: JSON.stringify({ error: 'phone required' }) });
    return;
  }

  const enginePacket = {
    externalPacketType: 'RESOLVE_LIVE_CHAT',
    platform: body.platform || 'whatsapp',
    userId: phone,
    botKey: body.botKey || 'cce5df75e8bb4d41',
    botIdentifier: body.botIdentifier || ''
  };

  await forwardToEngati(enginePacket, res);
}

async function forwardToEngati(enginePacket, res) {
  try {
    const headers = { 'Content-Type': 'application/json' };
    // If an Inbound API key was set up in Engati's External Live Chat
    // config, it needs to go here too, same as the check on the receiving
    // side in liveChatWebhook - the doc's samples show it on the receiving
    // side, but confirm whether Engati also expects it on packets we send
    // to their Inbound Message Webhook URL once we're testing this live.
    // if (process.env.ENGATI_INBOUND_API_KEY) {
    //   headers['Authorization'] = 'Basic ' + process.env.ENGATI_INBOUND_API_KEY;
    // }

    const response = await fetch(INBOUND_MESSAGE_WEBHOOK_URL, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(enginePacket)
    });
    const text = await response.text();
    res.status(200).send({ statusCode: response.status, body: text });
  } catch (e) {
    console.error('[liveChatSender] forwardToEngati failed: ' + (e && e.message));
    res.status(200).send({ statusCode: 500, body: JSON.stringify({ error: (e && e.message) || 'unknown error' }) });
  }
}

function inferPacketType(mimeType) {
  if (!mimeType) return 'IMAGE';
  if (mimeType.indexOf('video') === 0) return 'VIDEO';
  if (mimeType.indexOf('audio') === 0) return 'AUDIO';
  return 'IMAGE';
}
