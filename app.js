function renderStatus(t){document.getElementById('messages').innerHTML='<div class="status">'+t+'</div>';}
function safeParse(r){try{return typeof r==='string'?JSON.parse(r):r;}catch(e){return null;}}
function parseEngatiTimestamp(ts){
  if(!ts) return null;
  var iso = String(ts).replace(' ', 'T');
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
      timeEl.textContent=m.time;
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
var currentPhone = null;
var ENGATI_CUSTOMER_ID = "112609";
var ENGATI_BOT_ID = "41e497d0ee1d46b6";
var ENGATI_API_KEY = "37a3db0a-626c-4f36-bbc1-833d5b1d7bf5-IMqeVqx";

function isNearBottom(el){
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
    var list = (bodyParsed && (bodyParsed.conversations || bodyParsed.messages)) || data.conversations || data.messages || [];
    var mapped = list.map(function(m){
      var d = parseEngatiTimestamp(m.timestamp);
      return {
        direction: (m.sender === 'bot' ? 'out' : 'in'),
        text: m.response || m.text || '',
        time: formatTimestamp(d)
      };
    });
    var signature = JSON.stringify(mapped);
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

function sendFreeTextMessage(phone, text){
  var url = "https://api.engati.ai/bot-api/v1.0/customer/" + ENGATI_CUSTOMER_ID + "/bot/" + ENGATI_BOT_ID + "/broadcast";
  var body = {
    broadcastId: null,
    broadcastTitle: "widget-reply-" + Date.now(),
    publishedOn: new Date().toISOString(),
    audience: {
      rule: {
        channels: ["whatsapp"],
        channelUserIds: [phone]
      }
    },
    payload: {
      type: "direct",
      content: [
        { type: "text", data: { message: text } }
      ]
    },
    status: null
  };
  return ZOHO.CRM.HTTP.post({
    url: url,
    headers: { "Authorization": "Basic " + ENGATI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}
var templatesById = {};

function loadTemplates(){
  var select = document.getElementById('templateSelect');
  return ZOHO.CRM.API.getAllRecords({Entity:'WhatsApp_Templates', sort_order:'asc', per_page:200}).then(function(res){
    var records = (res && res.data) || [];
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
  }).catch(function(err){
    select.innerHTML = '<option value="">(templates error: '+((err&&(err.message||JSON.stringify(err)))||'unknown')+')</option>';
  });
}

function renderTemplateParams(rec){
  var wrap = document.getElementById('templateParams');
  wrap.innerHTML = '';
  if(!rec){ return; }
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
  flowKeys.forEach(function(key, idx){
    components.push({
      index: idx,
      sub_type: 'quick_reply',
      type: 'button',
      parameters: [{ type:'payload', payload: key }]
    });
  });
  return {
    name: rec.Template_Name,
    components: components,
    language: { code: rec.Language_Code || 'en', policy: 'deterministic' }
  };
}

function sendTemplateMessage(phone, rec){
  var url = "https://api.engati.ai/whatsapp-api/v1.0/customer/" + ENGATI_CUSTOMER_ID + "/bot/" + ENGATI_BOT_ID + "/template";
  var body = {
    phoneNumber: '+' + phone,
    payload: buildTemplatePayload(rec)
  };
  return ZOHO.CRM.HTTP.post({
    url: url,
    headers: { "Authorization": "Basic " + ENGATI_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
}

document.getElementById('templateSelect').addEventListener('change', function(){
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
  sendTemplateMessage(currentPhone, rec).then(function(resp){
    var data = safeParse(resp);
    var failed = data && (data.status_code >= 400 || data.error);
    btn.disabled = false;
    btn.textContent = prevLabel;
    resumePolling();
    if(failed){
      alert('Could not send template. Check the template configuration in the WhatsApp Templates module.');
      return;
    }
    select.value = '';
    document.getElementById('templateParams').innerHTML = '';
    fetchConversation(currentPhone, false);
  }).catch(function(){
    btn.disabled = false;
    btn.textContent = prevLabel;
    resumePolling();
    alert('Could not send template. Check the template configuration in the WhatsApp Templates module.');
  });
});

ZOHO.embeddedApp.on('PageLoad',function(data){
  var entityId = data && (Array.isArray(data.EntityId)?data.EntityId[0]:data.EntityId);
  var entity = (data && data.Entity) || 'Leads';
  if(!entityId){renderStatus('No record context found.');return;}
  loadTemplates();
  ZOHO.CRM.API.getRecord({Entity:entity,RecordID:entityId}).then(function(res){
    var rec=res && res.data && res.data[0];
    var phone=rec && (rec.Phone||rec.Mobile);
    if(phone){loadConversation(phone);}else{renderStatus('No phone number on this record.');}
  }).catch(function(){renderStatus('Could not read record.');});
});
function pausePolling(){
  if(pollTimer){ clearInterval(pollTimer); pollTimer=null; }
}
function resumePolling(){
  if(!pollTimer && currentPhone){
    pollTimer = setInterval(function(){ fetchConversation(currentPhone, false); }, POLL_INTERVAL_MS);
  }
}
document.getElementById('sendBtn').addEventListener('click',function(){
  var input=document.getElementById('msgInput');
  var text=input.value.trim();
  if(!text)return;
  if(!currentPhone){ return; }
  var btn=document.getElementById('sendBtn');
  btn.disabled=true;
  var prevLabel=btn.textContent;
  btn.textContent='Sending...';
  pausePolling();
  sendFreeTextMessage(currentPhone, text).then(function(resp){
    var data=safeParse(resp);
    var failed = data && (data.status_code >= 400 || data.error || (data.body && safeParse(data.body) && safeParse(data.body).error));
    btn.disabled=false;
    btn.textContent=prevLabel;
    resumePolling();
    if(failed){
      alert('Could not send message. This customer may be outside the 24-hour reply window — use an approved template instead.');
      return;
    }
    input.value='';
    fetchConversation(currentPhone, false);
  }).catch(function(err){
    btn.disabled=false;
    btn.textContent=prevLabel;
    resumePolling();
    alert('Could not send message. This customer may be outside the 24-hour reply window — use an approved template instead.');
  });
});
ZOHO.embeddedApp.init();
