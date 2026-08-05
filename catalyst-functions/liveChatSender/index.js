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
// Follows the exact same conventions as the real `whatsappProxy` function
// (confirmed by reading its live source in the Catalyst console):
//   - Advanced I/O, `module.exports = function(req, res) {...}`
//   - raw `https` module for outbound calls - no npm dependencies at all,
//     whatsappProxy's package.json has none, so don't assume fetch/
//     node-fetch/axios are available. If you want them, add to
//     package.json's "dependencies" and redeploy.
//   - CORS headers + OPTIONS preflight handling
//   - body read manually via a data/end listener, then JSON.parse
//   - response shaped {statusCode, body} matching how app.js's
//     safeParse(resp) / data.statusCode checks already expect proxy
//     responses to look (see sendTemplateViaProxy() + templateBtn handler
//     in app.js)
//
// Expected POST body from the widget:
//   { action: "sendAgentMessage", phone, text, media, platform, botKey, botIdentifier }
//   { action: "resolveLiveChat", phone, platform, botKey, botIdentifier }
//
// `phone`: same channel-user identifier used elsewhere in this project
// (see normalizePhone() in app.js and the /channel-user/<id>/ path segment
// in fetchConversation()).
//
// ENGATI_INBOUND_MESSAGE_WEBHOOK_URL is NOT known yet - External Live Chat
// isn't enabled on the new bot (Customer ID 126125 / Bot Key
// cce5df75e8bb4d41) as of writing this. Fill it in once Engati provides it
// - either hardcode here (matching how whatsappProxy currently hardcodes
// its Engati credentials) or read from a Catalyst env var / CRM Variable,
// whichever this project ends up standardizing on.

const https = require('https');

var ENGATI_INBOUND_MESSAGE_WEBHOOK_URL = ''; // fill in once Engati confirms and provides this
var ENGATI_INBOUND_API_KEY = ''; // optional - only if one was set up in Engati's Configure screen
var DEFAULT_BOT_KEY = 'cce5df75e8bb4d41'; // the new bot

function readBody(req) {
  return new Promise(function (resolve) {
    var data = '';
    req.on('data', function (chunk) { data += chunk; });
    req.on('end', function () { resolve(data); });
    req.on('error', function () { resolve(''); });
  });
}

function engatiPost(urlString, payload) {
  return new Promise(function (resolve) {
    var body = JSON.stringify(payload);
    var url = new URL(urlString);
    var headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    };
    if (ENGATI_INBOUND_API_KEY) {
      headers['Authorization'] = 'Basic ' + ENGATI_INBOUND_API_KEY;
    }
    var options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: headers
    };
    var req2 = https.request(options, function (res2) {
      var chunks = '';
      res2.on('data', function (c) { chunks += c; });
      res2.on('end', function () {
        resolve({ statusCode: res2.statusCode, body: chunks });
      });
    });
    req2.on('error', function (err) {
      resolve({ statusCode: 599, body: JSON.stringify({ error: String((err && err.message) || err) }) });
    });
    req2.write(body);
    req2.end();
  });
}

function inferPacketType(mimeType) {
  if (!mimeType) return 'IMAGE';
  if (mimeType.indexOf('video') === 0) return 'VIDEO';
  if (mimeType.indexOf('audio') === 0) return 'AUDIO';
  return 'IMAGE';
}

module.exports = function (req, res) {
  res.writeHead ? null : null;
  var headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (req.method === 'OPTIONS') {
    res.writeHead(204, headers);
    res.end();
    return;
  }

  readBody(req).then(function (raw) {
    var input;
    try { input = JSON.parse(raw || '{}'); } catch (e) { input = {}; }

    var action = input.action;
    var phone = input.phone;

    if (!ENGATI_INBOUND_MESSAGE_WEBHOOK_URL) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        statusCode: 400,
        body: JSON.stringify({ error: 'ENGATI_INBOUND_MESSAGE_WEBHOOK_URL not configured yet - External Live Chat not enabled' })
      }));
      return;
    }

    if (!phone) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ statusCode: 400, body: JSON.stringify({ error: 'phone required' }) }));
      return;
    }

    var enginePacket;

    if (action === 'sendAgentMessage') {
      var text = input.text;
      var media = input.media; // { value: <url>, mimeType: <string> }
      enginePacket = {
        externalPacketType: 'AGENT_MESSAGE',
        body: {
          packetType: media ? inferPacketType(media.mimeType) : 'TEXT',
          text: text ? { value: text } : undefined,
          media: media ? { value: media.value, mimeType: media.mimeType } : undefined,
          timestamp: new Date().toISOString()
        },
        platform: input.platform || 'whatsapp',
        userId: phone,
        botKey: input.botKey || DEFAULT_BOT_KEY,
        botIdentifier: input.botIdentifier || ''
      };
    } else if (action === 'resolveLiveChat') {
      enginePacket = {
        externalPacketType: 'RESOLVE_LIVE_CHAT',
        platform: input.platform || 'whatsapp',
        userId: phone,
        botKey: input.botKey || DEFAULT_BOT_KEY,
        botIdentifier: input.botIdentifier || ''
      };
    } else {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ error: 'unknown action' }));
      return;
    }

    engatiPost(ENGATI_INBOUND_MESSAGE_WEBHOOK_URL, enginePacket).then(function (result) {
      res.writeHead(200, headers);
      res.end(JSON.stringify(result));
    });
  });
};
