function renderStatus(t){document.getElementById('messages').innerHTML='<div class="status">'+t+'</div>';}
function safeParse(r){try{return typeof r==='string'?JSON.parse(r):r;}catch(e){return null;}}
function parseEngatiTimestamp(ts){
if(!ts) return null;
var iso = String(ts).replace(/^(\d{4})\/(\d{2})\/(\d{2})/, '$1-$2-$3').replace(' ', 'T');
iso = iso.replace(/T(\d{2}):(\d{2}):(\d{2}\.\d+)([+-]\d{4})$/, function(_, h, mi, s, tz){
return 'T'+h+':'+mi+':'+s+tz.slice(0,3)+':'+tz.slice(3);
});
var d = new Date(iso);
return isNaN(d.getTime()) ? null : d;
}
function formatTimestamp(d){
if(!d) return '';
var opts = {day:'numeric', month:'short', hour:'2-digit', minute:'2-digit'};
return d.toLocaleString(undefined, opts);
}
function renderMessages(list){
var el=document.getElementById('messages');
el.innerHTML='';
if(!list||!list.length){renderStatus('No messages found.');return;}
list.forEach(function(m){
var d=document.createElement('div');
d.className='bubble '+(m.direction==='out'?'out':'in');
var textEl=document.createElement('div');
textEl.className='bubble-text';
textEl.textContent=m.text||'';
d.appendChild(textEl);
if(m.time){
var timeEl=document.createElement('div');
timeEl.className='bubble-time';
var tickEl=document.createElement('span');
tickEl.className='ticks'+(m.status==='read'?' read':'');
tickEl.textContent=(m.status==='sent'?' \u2713':' \u2713\u2713');
timeEl.textContent=m.time;
timeEl.appendChild(tickEl);
d.appendChild(timeEl);
}
el.appendChild(d);
});
el.scrollTop=el.scrollHeight;
}
function normalizePhone(phone){
var digits = String(phone).replace(/[^0-9]/g, '');
if(digits.length === 10){ digits = '91' + digits; }
return digits;
}
var pollTimer = null;
var lastSignature = null;
var POLL_INTERVAL_MS = 2000;
var currentPhone = null;var lastMappedMessages = [];var localSentMessages = [];
var ENGATI_CUSTOMER_ID = null;
var ENGATI_BOT_ID = null;
var ENGATI_API_KEY = null;
var ENGATI_INBOUND_MESSAGE_WEBHOOK_URL = null; // optional - only needed for free-text/attachments via External Live Chat
var ENGATI_INBOUND_API_KEY = null; // optional - only if this org set one up in Engati's Configure screen
var CATALYST_PROXY_URL = "https://project-rainfall-60081410942.development.catalystserverless.in/server/whatsappProxy/";
var LIVE_CHAT_SENDER_PROXY_URL = "https://project-rainfall-60081410942.development.catalystserverless.in/server/liveChatSender/";
var configReadyPromise = null;

function loadConfigFromVariables(){
  if(configReadyPromise){ return configReadyPromise; }
  configReadyPromise = Promise.all([
    ZOHO.CRM.API.getOrgVariable("ENGATI_CUSTOMER_ID"),
    ZOHO.CRM.API.getOrgVariable("ENGATI_BOT_ID"),
    ZOHO.CRM.API.getOrgVariable("ENGATI_API_KEY"),
    ZOHO.CRM.API.getOrgVariable("ENGATI_INBOUND_MESSAGE_WEBHOOK_URL"),
    ZOHO.CRM.API.getOrgVariable("ENGATI_INBOUND_API_KEY")
  ]).then(function(results){
    showDebug('getOrgVariable raw response[0]: ' + JSON.stringify(results[0]).slice(0,500));
    showDebug('getOrgVariable raw response[1]: ' + JSON.stringify(results[1]).slice(0,500));
    showDebug('getOrgVariable raw response[2]: ' + JSON.stringify(results[2]).slice(0,500));
    ENGATI_CUSTOMER_ID = (results[0] && results[0].Success && results[0].Success.Content) || null;
    ENGATI_BOT_ID = (results[1] && results[1].Success && results[1].Success.Content) || null;
    ENGATI_API_KEY = (results[2] && results[2].Success && results[2].Success.Content) || null;
    // Optional - free-text/attachments simply stay unavailable (not a hard
    // failure) if these aren't set for this org yet.
    ENGATI_INBOUND_MESSAGE_WEBHOOK_URL = (results[3] && results[3].Success && results[3].Success.Content) || null;
    ENGATI_INBOUND_API_KEY = (results[4] && results[4].Success && results[4].Success.Content) || null;
    if(!ENGATI_CUSTOMER_ID || !ENGATI_BOT_ID || !ENGATI_API_KEY){
      renderStatus('WhatsApp integration is not configured. Please set ENGATI_CUSTOMER_ID, ENGATI_BOT_ID and ENGATI_API_KEY under Setup > Developer Hub > Variables.');
      throw new Error('Missing configuration variables');
    }
  }).catch(function(err){
    renderStatus('Could not load WhatsApp configuration. Please check Setup > Developer Hub > Variables.');
    throw err;
  });
  return configReadyPromise;
}

function renderMerged(isInitial){ localSentMessages = localSentMessages.filter(function(lm){ return !lastMappedMessages.some(function(sm){ return sm.direction==='out' && sm.text===lm.text; }); }); var merged = lastMappedMessages.concat(localSentMessages).sort(function(a,b){ return (a.ts||0)-(b.ts||0); }); var signature2 = JSON.stringify(merged); showDebug('renderMerged: mapped='+lastMappedMessages.length+' local='+localSentMessages.length+' merged='+merged.length+' sigChanged='+(signature2!==lastSignature)); if(signature2 === lastSignature){ return; } var el2 = document.getElementById('messages'); var wasNearBottom2 = isInitial || isNearBottom(el2); lastSignature = signature2; renderMessages(merged); if(!wasNearBottom2){ el2.scrollTop = el2.scrollHeight - el2.clientHeight - 60; } } function isNearBottom(el){
return (el.scrollHeight - el.scrollTop - el.clientHeight) < 60;
}

function fetchConversation(phone, isInitial){
var url = "https://api.engati.ai/bot-api/v1.0/customer/" + ENGATI_CUSTOMER_ID + "/bot/" + ENGATI_BOT_ID + "/channel-user/" + phone + "/conversations?page_size=50";
return ZOHO.CRM.HTTP.get({
url: url,
headers: { "Authorization": "Basic " + ENGATI_API_KEY }
}).then(function(resp){
var data = safeParse(resp);
if(!data || data.error){
if(isInitial){ renderStatus('Could not load conversation.'); }
return;
}
var body = data.body || data.details || data;
var bodyParsed = safeParse(body) || body;
var list = (bodyParsed && (bodyParsed.conversations || bodyParsed.messages)) || data.conversations || data.messages || []; showDebug('fetchConversation: server list.length='+list.length+' status_code='+data.status_code);
if(isInitial && list.length){ var lastOut = list.slice().reverse().find(function(m){ return m.sender==='bot'; }); if(lastOut){ showDebug('FULL raw bot message keys: ' + JSON.stringify(lastOut)); console.log('[Whatsyoo] FULL raw bot message keys:', JSON.stringify(lastOut)); } }
var mapped = list.map(function(m){
var d = parseEngatiTimestamp(m.timestamp);
return {
direction: (m.sender === 'bot' ? 'out' : 'in'),
text: m.response || m.text || '',
time: formatTimestamp(d), ts: d ? d.getTime() : 0, status: 'delivered'
};
});
lastMappedMessages = mapped; renderMerged(isInitial); return;
if(signature === lastSignature){ return; }
var el = document.getElementById('messages');
var wasNearBottom = isInitial || isNearBottom(el);
lastSignature = signature;
renderMessages(mapped);
if(!wasNearBottom){
el.scrollTop = el.scrollHeight - el.clientHeight - 60;
}
}).catch(function(){
if(isInitial){ renderStatus('Error loading conversation.'); }
});
}

function loadConversation(phone){
renderStatus('Loading conversation...');
phone = normalizePhone(phone);
currentPhone = phone;
if(pollTimer){ clearInterval(pollTimer); pollTimer = null; }
fetchConversation(phone, true).then(function(){
pollTimer = setInterval(function(){ fetchConversation(phone, false); }, POLL_INTERVAL_MS);
});
}

// NOTE: /broadcast (the old direct-to-Engati free-text call) is permanently
// blocked without Engati's paid External Live Chat add-on - confirmed via
// support ticket ES-58564. This function now goes through the AGENT_MESSAGE
// path instead (see catalyst-functions/liveChatSender/), which is the
// mechanism Engati's docs describe for that feature. It will fail until
// External Live Chat is confirmed enabled for this org's bot AND this org
// has set ENGATI_INBOUND_MESSAGE_WEBHOOK_URL - that's expected, not a bug,
// for orgs that haven't set that up yet.
function sendFreeTextMessage(phone, text, media){
if(!ENGATI_INBOUND_MESSAGE_WEBHOOK_URL){
return Promise.resolve(JSON.stringify({ statusCode: 400, body: JSON.stringify({ error: 'Free-text sending is not configured for this org. Set ENGATI_INBOUND_MESSAGE_WEBHOOK_URL under Setup > Developer Hub > Variables once Engati confirms External Live Chat is enabled.' }) }));
}
// botIdentifier must be this org's ENGATI_CUSTOMER_ID - Engati silently
// drops AGENT_MESSAGE packets without it (confirmed by testing, not
// documented). See catalyst-functions/liveChatSender/index.js.
var body = { action: 'sendAgentMessage', phone: phone, botKey: ENGATI_BOT_ID, botIdentifier: ENGATI_CUSTOMER_ID, inboundMessageWebhookUrl: ENGATI_INBOUND_MESSAGE_WEBHOOK_URL };
if(ENGATI_INBOUND_API_KEY){ body.inboundApiKey = ENGATI_INBOUND_API_KEY; }
if(text){ body.text = text; }
if(media && media.value){ body.media = { value: media.value, mimeType: media.mimeType }; }
showDebug('sendAgentMessage outgoing body: ' + JSON.stringify(body).slice(0,500));
return fetch(LIVE_CHAT_SENDER_PROXY_URL, {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify(body)
}).then(function(r){ return r.text(); });
}
var templatesById = {};

function loadTemplates(){
var select = document.getElementById('templateSelect');
return ZOHO.CRM.API.getAllRecords({Entity:'WhatsApp_Templates', sort_order:'asc', per_page:200}).then(function(res){
var records = (res && res.data) || [];
showDebug('loadTemplates: fetched '+records.length+' record(s)');
templatesById = {};
select.innerHTML = '<option value="">Send a template...</option>';
records.forEach(function(rec){
var active = rec.Is_Active;
if(active === false || active === 'false'){ return; }
if(!rec.Template_Name){ return; }
templatesById[rec.id] = rec;
var opt = document.createElement('option');
opt.value = rec.id;
opt.textContent = rec.Name || rec.Template_Name;
select.appendChild(opt);
});
showDebug('loadTemplates: '+Object.keys(templatesById).length+' active template(s) added to dropdown');
}).catch(function(err){
showDebug('loadTemplates ERROR: '+((err&&(err.message||JSON.stringify(err)))||'unknown'));
select.innerHTML = '<option value="">(templates error: '+((err&&(err.message||JSON.stringify(err)))||'unknown')+')</option>';
});
}

function renderTemplateParams(rec){
var wrap = document.getElementById('templateParams');
wrap.innerHTML = '';
if(!rec){ return; }
var langs = (rec.Available_Languages || '').split(';').map(function(s){return s.trim();}).filter(Boolean);
if(langs.length > 1){
var langSelect = document.createElement('select');
langSelect.id = 'tplLanguageSelect';
langs.forEach(function(code){
var opt = document.createElement('option');
opt.value = code;
opt.textContent = code;
if(code === (rec.Language_Code || '')){ opt.selected = true; }
langSelect.appendChild(opt);
});
wrap.appendChild(langSelect);
}
var headerType = rec.Header_Type;
if(headerType && headerType !== 'None'){
var hInput = document.createElement('input');
hInput.type = 'text';
hInput.id = 'tplHeaderValue';
hInput.placeholder = headerType + ' URL';
hInput.value = rec.Header_Value || '';
wrap.appendChild(hInput);
}
var count = parseInt(rec.Body_Param_Count, 10) || 0;
var labels = (rec.Body_Param_Labels || '').split(',').map(function(s){return s.trim();});
for(var i=0;i<count;i++){
var pInput = document.createElement('input');
pInput.type = 'text';
pInput.className = 'tplBodyParam';
pInput.placeholder = labels[i] || ('Parameter ' + (i+1));
wrap.appendChild(pInput);
}
}

function buildTemplatePayload(rec){
var components = [];
var headerType = rec.Header_Type;
if(headerType && headerType !== 'None'){
var headerVal = (document.getElementById('tplHeaderValue') || {}).value || rec.Header_Value || '';
var headerKey = headerType.toLowerCase();
var headerParam = { type: headerKey };
headerParam[headerKey] = { link: headerVal };
components.push({ type: 'header', parameters: [headerParam] });
}
var count = parseInt(rec.Body_Param_Count, 10) || 0;
if(count > 0){
var paramInputs = document.querySelectorAll('.tplBodyParam');
var bodyParams = [];
for(var i=0;i<count;i++){
bodyParams.push({ type:'text', text: (paramInputs[i] && paramInputs[i].value) || '' });
}
components.push({ type:'body', parameters: bodyParams });
}
var flowKeys = (rec.Button_Flow_Keys || '').split(';').map(function(s){return s.trim();}).filter(Boolean);
var startIdx = parseInt(rec.Button_Start_Index, 10) || 0;
flowKeys.forEach(function(key, idx){
components.push({
index: startIdx + idx,
sub_type: 'quick_reply',
type: 'button',
parameters: [{ type:'payload', payload: key }]
});
});
return {
name: rec.Template_Name,
components: components,
language: { code: (document.getElementById('tplLanguageSelect') || {}).value || rec.Language_Code || 'en', policy: 'deterministic' }
};
}

function sendTemplateMessage(phone, rec){
var url = "https://api.engati.ai/whatsapp-api/v1.0/customer/" + ENGATI_CUSTOMER_ID + "/bot/" + ENGATI_BOT_ID + "/template"; return fetch(CATALYST_PROXY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sendTemplate', phone: phone, templatePayload: buildTemplatePayload(rec) }) }).then(function(r){ return r.text(); });
var body = {
phoneNumber: '+' + phone,
payload: buildTemplatePayload(rec)
};
return ZOHO.CRM.HTTP.post({
url: url,
headers: { "Authorization": "Basic " + ENGATI_API_KEY, "Content-Type": "application/json" },
body: (function(){ showDebug('outgoing body (raw object, with content-type header): ' + JSON.stringify(body).slice(0,500)); return body; })()
});
}

function sendTemplateViaProxy(phone, rec){ return fetch(CATALYST_PROXY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'sendTemplate', phone: phone, templatePayload: buildTemplatePayload(rec) }) }).then(function(r){ return r.text(); }); } document.getElementById('templateSelect').addEventListener('change', function(){
var rec = templatesById[this.value];
renderTemplateParams(rec);
});

document.getElementById('templateBtn').addEventListener('click', function(){
var select = document.getElementById('templateSelect');
var rec = templatesById[select.value];
if(!rec || !currentPhone){ return; }
var btn = document.getElementById('templateBtn');
btn.disabled = true;
var prevLabel = btn.textContent;
btn.textContent = 'Sending...';
pausePolling();
sendTemplateViaProxy(currentPhone, rec).then(function(resp){
var data = safeParse(resp);
var inner = data && safeParse(data.body); var failed = !(data && data.statusCode === 200 && inner && inner.status && inner.status.code === 1000);
btn.disabled = false;
btn.textContent = prevLabel;
resumePolling();
if(failed){
alert('Could not send template. Check the template configuration in the WhatsApp Templates module.');
return;
}
localSentMessages.push({ direction:'out', text: '[Template] ' + (rec.Name || rec.Template_Name || ''), time: formatTimestamp(new Date()), ts: Date.now(), status: 'sent' }); showDebug('templateBtn: pushed local message, count='+localSentMessages.length); renderMerged(false); select.value = '';
document.getElementById('templateParams').innerHTML = '';
fetchConversation(currentPhone, false);
}).catch(function(){
btn.disabled = false;
btn.textContent = prevLabel;
resumePolling();
alert('Could not send template. Check the template configuration in the WhatsApp Templates module.');
});
});

document.getElementById('brandHeader').addEventListener('click', function(){
this.classList.toggle('collapsed');
});

ZOHO.embeddedApp.on('PageLoad',function(data){
var entityId = data && (Array.isArray(data.EntityId)?data.EntityId[0]:data.EntityId);
var entity = (data && data.Entity) || 'Leads';
if(!entityId){renderStatus('No record context found.');return;}
renderStatus('Loading configuration...');
loadConfigFromVariables().then(function(){
loadTemplates();
return ZOHO.CRM.API.getRecord({Entity:entity,RecordID:entityId});
}).then(function(res){
var rec=res && res.data && res.data[0];
var phone=rec && (rec.Phone||rec.Mobile);
if(phone){loadConversation(phone);}else{renderStatus('No phone number on this record.');}
}).catch(function(){});
});
function showDebug(text){
var el = document.getElementById('debugBox');
if(!el){
var wrap = document.createElement('div'); wrap.id = 'debugWrap'; wrap.className = 'collapsed'; wrap.style.cssText = 'border-top:2px solid red;background:#111;flex:0 0 auto;';
var header = document.createElement('div'); header.id = 'debugHeader'; header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:4px 8px;font-size:11px;color:#f66;cursor:pointer;font-family:monospace;';
var headerLabel = document.createElement('span'); headerLabel.textContent = 'Debug log';
var headerChevron = document.createElement('span'); headerChevron.id = 'debugChevron'; headerChevron.textContent = '▶'; headerChevron.style.cssText = 'transition:transform 0.15s ease;';
header.appendChild(headerLabel); header.appendChild(headerChevron);
var body = document.createElement('div'); body.id = 'debugBody'; body.style.cssText = 'display:none;';
header.onclick = function(){
var collapsed = wrap.classList.toggle('collapsed');
body.style.display = collapsed ? 'none' : '';
headerChevron.style.transform = collapsed ? 'rotate(0deg)' : 'rotate(90deg)';
};
el = document.createElement('pre');
el.id = 'debugBox';
el.style.cssText = 'white-space:pre-wrap;word-break:break-all;background:#111;color:#0f0;font-size:11px;padding:8px;max-height:200px;overflow:auto;margin:0;';
var copyBtn = document.createElement('button'); copyBtn.id = 'debugCopyBtn'; copyBtn.textContent = 'Copy log'; copyBtn.style.cssText = 'margin:4px 8px;padding:2px 8px;font-size:11px;background:#222;color:#0f0;border:1px solid #0f0;cursor:pointer;'; copyBtn.onclick = function(){ var txt = el.textContent; function done(ok){ copyBtn.textContent = ok ? 'Copied!' : 'Copy failed'; setTimeout(function(){ copyBtn.textContent = 'Copy log'; }, 1500); } if(navigator.clipboard && navigator.clipboard.writeText){ navigator.clipboard.writeText(txt).then(function(){ done(true); }).catch(function(){ done(false); }); } else { var ta = document.createElement('textarea'); ta.value = txt; document.body.appendChild(ta); ta.select(); var ok = false; try{ ok = document.execCommand('copy'); }catch(e){} document.body.removeChild(ta); done(ok); } }; body.appendChild(copyBtn); var clearBtn = document.createElement('button'); clearBtn.id = 'debugClearBtn'; clearBtn.textContent = 'Clear log'; clearBtn.style.cssText = 'margin:4px 8px;padding:2px 8px;font-size:11px;background:#222;color:#f66;border:1px solid #f66;cursor:pointer;'; clearBtn.onclick = function(){ el.textContent = ''; }; body.appendChild(clearBtn); var testBtn = document.createElement('button'); testBtn.id = 'testFetchBtn'; testBtn.textContent = 'Test raw fetch'; testBtn.style.cssText = 'margin:4px 8px;padding:2px 8px;font-size:11px;background:#222;color:#0af;border:1px solid #0af;cursor:pointer;'; testBtn.onclick = function(){ if(!currentPhone){ showDebug('testFetch: no currentPhone'); return; } var url = "https://api.engati.ai/bot-api/v1.0/customer/" + ENGATI_CUSTOMER_ID + "/bot/" + ENGATI_BOT_ID + "/broadcast"; var testBody = { broadcastId: null, broadcastTitle: "rawfetch-test-" + Date.now(), publishedOn: new Date().toISOString(), audience: { rule: { channels: ["whatsapp"], channelUserIds: [currentPhone] } }, payload: { type: "direct", content: [ { type: "text", data: { message: "raw fetch test" } } ] }, status: null }; showDebug('testFetch: sending via raw fetch...'); fetch(url, { method: 'POST', headers: { 'Authorization': 'Basic ' + ENGATI_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(testBody) }).then(function(r){ return r.text().then(function(t){ showDebug('testFetch: status=' + r.status + ' body=' + t.slice(0,500)); }); }).catch(function(e){ showDebug('testFetch: NETWORK/CORS ERROR: ' + (e && e.message)); }); }; body.appendChild(testBtn); body.appendChild(el);
wrap.appendChild(header); wrap.appendChild(body);
document.getElementById('chat-root').appendChild(wrap);
}
el.textContent += (new Date()).toISOString().slice(11,19) + ' ' + text + String.fromCharCode(10); el.scrollTop = el.scrollHeight;
}
function pausePolling(){
if(pollTimer){ clearInterval(pollTimer); pollTimer=null; }
}
function resumePolling(){
if(!pollTimer && currentPhone){
pollTimer = setInterval(function(){ fetchConversation(currentPhone, false); }, POLL_INTERVAL_MS);
}
}
// Attachment UI (free-text side). URL-based for now, matching how template
// headers already work - file upload / hosting is a separate, not-yet-made
// decision (see catalyst-functions/README.md).
document.getElementById('attachToggleBtn').addEventListener('click', function(){
var row = document.getElementById('attachRow');
var willShow = row.classList.contains('hidden') || !row.classList.contains('open');
row.classList.toggle('open');
this.classList.toggle('active');
});
document.getElementById('attachClearBtn').addEventListener('click', function(){
document.getElementById('attachUrl').value = '';
document.getElementById('attachType').value = 'IMAGE';
document.getElementById('attachRow').classList.remove('open');
document.getElementById('attachToggleBtn').classList.remove('active');
});

document.getElementById('sendBtn').addEventListener('click',function(){
var input=document.getElementById('msgInput');
var text=input.value.trim();
var attachUrlInput = document.getElementById('attachUrl');
var attachUrl = attachUrlInput.value.trim();
var attachType = document.getElementById('attachType').value;
var media = attachUrl ? { value: attachUrl, mimeType: mimeTypeForPacketType(attachType) } : null;
if(!text && !media)return;
if(!currentPhone){ return; }
var btn=document.getElementById('sendBtn');
btn.disabled=true;
var prevLabel=btn.textContent;
btn.textContent='Sending...';
pausePolling();
sendFreeTextMessage(currentPhone, text, media).then(function(resp){
var data=safeParse(resp);
showDebug('RAW RESPONSE: ' + JSON.stringify(resp).slice(0,3000));
var failed = !!(data && ((data.statusCode && data.statusCode>=400) || (data.status_code && data.status_code>=400) || (data.status && data.status>=400) || data.error || data.type==='about:blank' || (data.body && safeParse(data.body) && (safeParse(data.body).error || (safeParse(data.body).status && safeParse(data.body).status>=400)))));
btn.disabled=false;
btn.textContent=prevLabel;
resumePolling();
if(failed){
return;
}
localSentMessages.push({ direction:'out', text: text || (media ? '['+attachType+']' : ''), time: formatTimestamp(new Date()), ts: Date.now(), status: 'sent' }); showDebug('sendBtn: pushed local message, count='+localSentMessages.length); renderMerged(false); input.value='';
attachUrlInput.value=''; document.getElementById('attachRow').classList.remove('open'); document.getElementById('attachToggleBtn').classList.remove('active');
fetchConversation(currentPhone, false);
}).catch(function(err){
btn.disabled=false;
btn.textContent=prevLabel;
resumePolling();
showDebug('CATCH ERROR: ' + JSON.stringify(err).slice(0,3000));
});
});
function mimeTypeForPacketType(t){
if(t === 'VIDEO') return 'video/mp4';
if(t === 'AUDIO') return 'audio/mpeg';
return 'image/jpeg';
}
ZOHO.embeddedApp.init();
