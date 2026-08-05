// liveChatSender
//
// Sends AGENT_MESSAGE and RESOLVE_LIVE_CHAT packets to Engati's "Inbound
// Message Webhook URL" - the system-generated URL Engati shows in
// Configure > External Live Chat once the feature is enabled. This is the
// mechanism for an agent (our widget) to actually send replies once
// External Live Chat is on - it replaces the old direct call to Engati's
// /broadcast endpoint, which is permanently blocked without this add-on.
//
// MULTI-TENANT: this function is shared across all customers/Zoho orgs -
// it does NOT hardcode any one customer's Engati credentials. Every
// customer's Inbound Message Webhook URL, bot key, and optional inbound API
// key are passed in on each request (sourced from that org's own Zoho CRM
// Variables, same place ENGATI_CUSTOMER_ID/BOT_ID/API_KEY already live).
// Widget-side wiring: app.js loadConfigFromVariables() reads
// ENGATI_INBOUND_MESSAGE_WEBHOOK_URL (and ENGATI_INBOUND_API_KEY if set)
// alongside the existing three variables, and sendFreeTextMessage() passes
// them through on every call.
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
//   {
//     action: "sendAgentMessage" | "resolveLiveChat",
//     phone,                            // channel-user id, see normalizePhone() in app.js
//     inboundMessageWebhookUrl,         // REQUIRED - this org's Engati Inbound Message Webhook URL
//     botKey,                           // REQUIRED - this org's Engati bot key
//     inboundApiKey,                    // optional - this org's Inbound API key, if configured in Engati
//     platform, botIdentifier,          // optional, default 'whatsapp' / ''
//     text,                             // for sendAgentMessage: plain text
//     media                             // for sendAgentMessage: { value: <url>, mimeType }
//   }
//
// whatsappProxy still hardcodes its one customer's credentials as of this
// writing - revisit that separately if/when a second customer needs
// template sending too. Don't assume it's already multi-tenant.

const https = require('https');

function readBody(req) {
  return new Promise(function (resolve) {
    var data = '';
    req.on('data', function (chunk) { data += chunk; });
    req.on('end', function () { resolve(data); });
    req.on('error', function () { resolve(''); });
  });
}

function engatiPost(urlString, payload, inboundApiKey) {
  return new Promise(function (resolve) {
    var body = JSON.stringify(payload);
    var url = new URL(urlString);
    var headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body)
    };
    if (inboundApiKey) {
      headers['Authorization'] = 'Basic ' + inboundApiKey;
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
    var inboundMessageWebhookUrl = input.inboundMessageWebhookUrl;
    var botKey = input.botKey;
    var inboundApiKey = input.inboundApiKey || '';

    if (!inboundMessageWebhookUrl) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({
        statusCode: 400,
        body: JSON.stringify({ error: 'inboundMessageWebhookUrl required - External Live Chat not configured for this org' })
      }));
      return;
    }

    if (!botKey) {
      res.writeHead(200, headers);
      res.end(JSON.stringify({ statusCode: 400, body: JSON.stringify({ error: 'botKey required' }) }));
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
        botKey: botKey,
        botIdentifier: input.botIdentifier || ''
      };
    } else if (action === 'resolveLiveChat') {
      enginePacket = {
        externalPacketType: 'RESOLVE_LIVE_CHAT',
        platform: input.platform || 'whatsapp',
        userId: phone,
        botKey: botKey,
        botIdentifier: input.botIdentifier || ''
      };
    } else {
      res.writeHead(400, headers);
      res.end(JSON.stringify({ error: 'unknown action' }));
      return;
    }

    engatiPost(inboundMessageWebhookUrl, enginePacket, inboundApiKey).then(function (result) {
      res.writeHead(200, headers);
      res.end(JSON.stringify(result));
    });
  });
};
