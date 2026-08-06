const catalyst = require('zcatalyst-sdk-node');

module.exports = async (req, res) => {
const catalystApp = catalyst.initialize(req);

let body = req.body;
if (typeof body === 'string') {
try { body = JSON.parse(body); } catch (e) { body = {}; }
}
body = body || {};

// ConnectPanels validation ping — empty body POST
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
console.error('[liveChatWebhook] LiveChatEvents insert failed: ' + (e && e.message));
}

res.status(200).send({ ok: true });
};