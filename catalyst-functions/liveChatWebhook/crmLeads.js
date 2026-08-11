// Creates a Zoho CRM Lead for a WhatsApp contact that doesn't have one yet.
//
// Triggered from liveChatWebhook when an inbound packet arrives. NOTE the
// trigger is USER_MESSAGE, not START_CHAT, despite START_CHAT being the
// original plan: in practice START_CHAT rarely fires (it needs the bot flow to
// hit a Transfer to Agent node), and when it does fire on the web channel its
// userId is a session UUID rather than a phone number. USER_MESSAGE fires on
// every inbound WhatsApp message and carries the real phone number, so it is
// both more reliable and the only one with usable data.
//
// Because it runs on every message, it must be cheap and idempotent: it
// searches for an existing Lead first and only creates one when there is no
// match. That also makes it self-healing - if a create fails, the contact's
// next message retries it.
//
// CREDENTIALS: read from environment variables, set per deployment in the
// Catalyst console (Functions > liveChatWebhook > Configuration). They are
// deliberately NOT committed - each customer's Catalyst project holds their
// own org's values. See SETUP.md.
//   ZOHO_CLIENT_ID
//   ZOHO_CLIENT_SECRET
//   ZOHO_REFRESH_TOKEN
//   ZOHO_ACCOUNTS_HOST   optional, default accounts.zoho.in
//   ZOHO_API_HOST        optional, default www.zohoapis.in
// The hosts matter: a customer on the US/EU data centre uses .com / .eu, and
// calling the wrong one fails authentication in a confusing way.

const https = require('https');

function requestJson(options, body) {
  return new Promise(function (resolve) {
    const req = https.request(options, function (res) {
      let chunks = '';
      res.on('data', function (c) { chunks += c; });
      res.on('end', function () {
        let parsed = null;
        try { parsed = chunks ? JSON.parse(chunks) : null; } catch (e) { parsed = null; }
        resolve({ statusCode: res.statusCode, body: chunks, json: parsed });
      });
    });
    req.on('error', function (err) {
      resolve({ statusCode: 599, body: String((err && err.message) || err), json: null });
    });
    if (body) { req.write(body); }
    req.end();
  });
}

// Access tokens last an hour. Cache across warm invocations so we're not
// burning a token refresh on every single inbound message.
let cachedToken = null;
let cachedTokenExpiresAt = 0;

function accountsHost() { return process.env.ZOHO_ACCOUNTS_HOST || 'accounts.zoho.in'; }
function apiHost() { return process.env.ZOHO_API_HOST || 'www.zohoapis.in'; }

async function getAccessToken() {
  const now = Date.now();
  // Refresh a minute early rather than racing the expiry.
  if (cachedToken && now < cachedTokenExpiresAt - 60000) { return cachedToken; }

  const clientId = process.env.ZOHO_CLIENT_ID;
  const clientSecret = process.env.ZOHO_CLIENT_SECRET;
  const refreshToken = process.env.ZOHO_REFRESH_TOKEN;
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Zoho CRM credentials not configured (ZOHO_CLIENT_ID / ZOHO_CLIENT_SECRET / ZOHO_REFRESH_TOKEN)');
  }

  const form = 'grant_type=refresh_token'
    + '&client_id=' + encodeURIComponent(clientId)
    + '&client_secret=' + encodeURIComponent(clientSecret)
    + '&refresh_token=' + encodeURIComponent(refreshToken);

  const res = await requestJson({
    hostname: accountsHost(),
    path: '/oauth/v2/token',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(form)
    }
  }, form);

  const token = res.json && res.json.access_token;
  if (!token) {
    throw new Error('Token refresh failed (' + res.statusCode + '): ' + String(res.body).slice(0, 300));
  }
  const expiresInSec = (res.json && res.json.expires_in) || 3600;
  cachedToken = token;
  cachedTokenExpiresAt = Date.now() + expiresInSec * 1000;
  return token;
}

// Leads in this system are only ever created by upsertLead() below, from an
// Engati userId - which is always the full international number - and always
// written as '+' + digits. So that is the only format a Lead's Phone can hold,
// and it is the first thing we look for.
//
// The plain-digits form is kept purely as a cheap safety net for a number
// somebody hand-edited in CRM after the fact.
//
// Deliberately NOT searched: national-format renderings (bare "561145456",
// "0561145456", "+971 561145456"). An earlier version built those by stripping
// a country code, which was both buggy - it did digits.slice(-10), hardcoding
// India's 10-digit national number, so UAE's 971561145456 split into country
// code "97" and national "1561145456" - and unnecessary, since no Lead here is
// ever stored that way. Worse, Zoho's phone search is not strictly exact, so
// searching a bare national number can match a DIFFERENT country's Lead ending
// in the same digits and silently attach this conversation to the wrong person.
// Restore them only if a customer starts creating Leads by hand or by import,
// and split on an explicitly configured country code, never on length.
function phoneVariants(digits) {
  return ['+' + digits, digits];
}

async function findLeadByPhone(token, digits) {
  for (const variant of phoneVariants(digits)) {
    const res = await requestJson({
      hostname: apiHost(),
      path: '/crm/v2/Leads/search?phone=' + encodeURIComponent(variant),
      method: 'GET',
      headers: { 'Authorization': 'Zoho-oauthtoken ' + token }
    });
    // 204 = no match, which is a normal answer here, not an error.
    if (res.statusCode === 200 && res.json && Array.isArray(res.json.data) && res.json.data.length) {
      return res.json.data[0];
    }
  }
  return null;
}

// Fallback name Leads are created with when no real name is known yet -
// shared between upsertLead's write and ensureLeadForPhone's check for
// whether a Lead still needs its name backfilled.
function fallbackName(digits) { return 'WhatsApp ' + digits; }

// Patches just Last_Name on an existing Lead. Used to repair a Lead that was
// created before a real name was known (e.g. from USER_MESSAGE, which never
// carries a name) once a later START_CHAT supplies one. Best-effort - a
// failure here shouldn't take down the caller, the Lead already exists and
// works fine, it would just keep its placeholder name.
async function updateLeadName(token, id, displayName) {
  const payload = JSON.stringify({ data: [{ id: id, Last_Name: displayName }] });
  const res = await requestJson({
    hostname: apiHost(),
    path: '/crm/v2/Leads',
    method: 'PUT',
    headers: {
      'Authorization': 'Zoho-oauthtoken ' + token,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, payload);
  const record = res.json && Array.isArray(res.json.data) && res.json.data[0];
  return !!(record && record.code === 'SUCCESS');
}

// Sets the two fields that let agents see "new message" from the Leads
// LIST VIEW, without opening every record - see multi-tenant-customer-
// expansion / composer-ui-additions memory notes for why this exists.
// WhatsApp_Unread and Last_WhatsApp_Message are both custom fields that
// must be created on the Leads module before this does anything useful
// (see SETUP.md) - a missing-field error here is swallowed the same way
// every other CRM write failure in this file is, so a customer who
// hasn't set these fields up yet doesn't lose inbound message
// processing over it.
//
// Cleared client-side instead of here - see app.js's PageLoad handler,
// which clears it the moment an agent actually opens the record's
// WhatsApp panel. That's the real "read" signal, not "an agent sent a
// reply" (an agent might open a conversation just to check it).
async function markUnread(token, id) {
  const payload = JSON.stringify({ data: [{ id: id, WhatsApp_Unread: true, Last_WhatsApp_Message: new Date().toISOString() }] });
  const res = await requestJson({
    hostname: apiHost(),
    path: '/crm/v2/Leads',
    method: 'PUT',
    headers: {
      'Authorization': 'Zoho-oauthtoken ' + token,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, payload);
  const record = res.json && Array.isArray(res.json.data) && res.json.data[0];
  if (!(record && record.code === 'SUCCESS')) {
    console.error('[crmLeads] markUnread failed for Lead ' + id + ': ' + String(res.body).slice(0, 300));
  }
}

async function getLeadName(token, id) {
  const res = await requestJson({
    hostname: apiHost(),
    path: '/crm/v2/Leads/' + id + '?fields=Last_Name',
    method: 'GET',
    headers: { 'Authorization': 'Zoho-oauthtoken ' + token }
  });
  const record = res.json && Array.isArray(res.json.data) && res.json.data[0];
  return record ? record.Last_Name : null;
}

// Given a Lead id we already know about (from either cache layer), check and
// backfill its name if it still has the placeholder. One extra GET (plus a
// PUT if it needs fixing) - acceptable because this path only runs when
// displayName is present, which only happens on START_CHAT, an infrequent
// event compared to USER_MESSAGE.
async function backfillIfNeeded(token, id, digits, displayName) {
  const currentName = await getLeadName(token, id);
  if (currentName !== fallbackName(digits)) {
    return 'existing Lead ' + id + ' (name already set)';
  }
  const renamed = await updateLeadName(token, id, displayName);
  return 'existing Lead ' + id + ' (name ' + (renamed ? 'backfilled' : 'backfill FAILED') + ')';
}

// Uses upsert rather than plain create, and this matters: Zoho's /search
// endpoint reads a search index that lags behind writes by a few seconds, so a
// Lead created moments ago is not yet findable. Testing showed two messages in
// quick succession producing two duplicate Leads for the same number.
//
// /upsert with duplicate_check_fields does the find-or-create atomically on
// Zoho's side against live data, which closes that race entirely.
async function upsertLead(token, digits, displayName) {
  // Last_Name is mandatory on Zoho Leads. WhatsApp gives us a profile name at
  // best, often nothing, so fall back to something identifiable rather than
  // failing the write.
  const payload = JSON.stringify({
    data: [{
      Last_Name: displayName || fallbackName(digits),
      Phone: '+' + digits,
      Lead_Source: 'WhatsApp',
      // /upsert handles both the brand-new-Lead case AND the case where
      // duplicate_check_fields matches an existing record - either way,
      // this message just arrived, so both cases get the same "unread,
      // just now" state in one write. No separate markUnread() call
      // needed for this path.
      WhatsApp_Unread: true,
      Last_WhatsApp_Message: new Date().toISOString()
    }],
    duplicate_check_fields: ['Phone'],
    trigger: []
  });

  const res = await requestJson({
    hostname: apiHost(),
    path: '/crm/v2/Leads/upsert',
    method: 'POST',
    headers: {
      'Authorization': 'Zoho-oauthtoken ' + token,
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  }, payload);

  const record = res.json && Array.isArray(res.json.data) && res.json.data[0];
  if (record && record.code === 'SUCCESS') {
    const id = record.details && record.details.id;
    // Zoho reports which branch it took, so the log can distinguish a genuinely
    // new contact from a repeat message by an existing one.
    return { id: id, action: record.action || 'unknown' };
  }
  throw new Error('Lead upsert failed (' + res.statusCode + '): ' + String(res.body).slice(0, 300));
}

// Zoho's /search endpoint reads an index that lags writes by a long time -
// measured at over 20 seconds against this org, and it may be minutes. That
// makes it useless on its own for "did I just create this?", and testing
// confirmed a contact sending three quick messages got three duplicate Leads.
// /upsert with duplicate_check_fields doesn't help either: it only dedupes on
// fields marked unique in the CRM, and Phone isn't by default.
//
// So recently-created numbers are remembered directly. Two layers, because
// neither alone is sufficient:
//   1. an in-process Map - instant, but only covers a warm container
//   2. Catalyst Cache - survives across containers and cold starts
// Once the search index catches up (well within the cache TTL) the search path
// takes over, so nothing depends on the cache persisting.
const recentlyCreated = new Map();
const RECENT_TTL_MS = 60 * 60 * 1000;
const CACHE_TTL_HOURS = 6;

function rememberLocally(digits, leadId) {
  recentlyCreated.set(digits, { leadId: leadId, at: Date.now() });
  // Cheap sweep so a long-lived container doesn't grow this forever.
  if (recentlyCreated.size > 500) {
    const cutoff = Date.now() - RECENT_TTL_MS;
    for (const [k, v] of recentlyCreated) {
      if (v.at < cutoff) recentlyCreated.delete(k);
    }
  }
}

function recallLocally(digits) {
  const hit = recentlyCreated.get(digits);
  if (!hit) return null;
  if (Date.now() - hit.at > RECENT_TTL_MS) { recentlyCreated.delete(digits); return null; }
  return hit.leadId;
}

function cacheKeyFor(digits) { return 'lead_' + digits; }

async function recallFromCache(catalystApp, digits) {
  if (!catalystApp) return null;
  try {
    const segment = catalystApp.cache().segment();
    const item = await segment.getValue(cacheKeyFor(digits));
    return item || null;
  } catch (e) {
    // Cache being unavailable must not stop us - worst case we fall through to
    // search and possibly create a duplicate, which is better than erroring.
    console.error('[crmLeads] cache read failed: ' + (e && e.message));
    return null;
  }
}

async function rememberInCache(catalystApp, digits, leadId) {
  if (!catalystApp) return;
  try {
    const segment = catalystApp.cache().segment();
    await segment.put(cacheKeyFor(digits), String(leadId), CACHE_TTL_HOURS);
  } catch (e) {
    console.error('[crmLeads] cache write failed: ' + (e && e.message));
  }
}

// Returns a short string describing what happened, for the caller to log.
// Never throws - a CRM problem must not break the webhook response to Engati.
async function ensureLeadForPhone(catalystApp, userId, displayName) {
  const digits = String(userId || '').replace(/[^0-9]/g, '');
  // Web-channel sessions use UUIDs, not phone numbers. Those aren't contacts we
  // can create a Lead for, so skip rather than creating junk records.
  if (!digits || digits.length < 8 || digits !== String(userId).trim()) {
    return 'skipped (userId is not a plain phone number: ' + String(userId).slice(0, 40) + ')';
  }
  // Cheapest checks first - both are local/near-local and immediately
  // consistent, unlike the search index. BUT: only take the fast exit when
  // there's no displayName to offer. displayName is only ever present on
  // START_CHAT (see extractDisplayName in index.js), which is infrequent
  // compared to USER_MESSAGE - so when it IS present, it's worth one extra
  // GET to check whether a Lead already found by the fast caches still has
  // its placeholder name and needs backfilling. Skipping this check on the
  // cache-hit path was a real bug: USER_MESSAGE creates the Lead first with
  // no name, the id gets cached, and a same-session START_CHAT with the
  // real name would otherwise hit the cache and return before ever
  // comparing names - the placeholder would then persist for the entire
  // cache TTL (up to 6 hours) even though the real name was right there.
  const localHit = recallLocally(digits);

  try {
    // Fetched up front now, unlike before markUnread() existed - every
    // return path below (except the create/upsert one, which folds the
    // fields into its own write) now needs a token to mark the Lead
    // unread, so there is no longer a token-free fast path. getAccessToken()
    // caches for an hour, so this is a cheap in-memory check on every call
    // except the first per warm container.
    const token = await getAccessToken();

    if (localHit && !displayName) {
      await markUnread(token, localHit);
      return 'existing Lead ' + localHit + ' (in-process cache)';
    }

    const cachedId = localHit || await recallFromCache(catalystApp, digits);
    if (cachedId && !displayName) {
      rememberLocally(digits, cachedId);
      await markUnread(token, cachedId);
      return 'existing Lead ' + cachedId + ' (Catalyst cache)';
    }

    if (cachedId) {
      // Already know the id - one GET to check the name, cheaper than a
      // fresh /search.
      rememberLocally(digits, cachedId);
      await rememberInCache(catalystApp, digits, cachedId);
      await markUnread(token, cachedId);
      return await backfillIfNeeded(token, cachedId, digits, displayName);
    }

    // Search covers established contacts, once the index has caught up.
    const existing = await findLeadByPhone(token, digits);
    if (existing) {
      rememberLocally(digits, existing.id);
      await rememberInCache(catalystApp, digits, existing.id);
      await markUnread(token, existing.id);
      if (displayName && existing.Last_Name === fallbackName(digits)) {
        const renamed = await updateLeadName(token, existing.id, displayName);
        return 'existing Lead ' + existing.id + ' (matched by search, name ' + (renamed ? 'backfilled' : 'backfill FAILED') + ')';
      }
      return 'existing Lead ' + existing.id + ' (matched by search)';
    }

    // upsertLead's own payload already includes WhatsApp_Unread/
    // Last_WhatsApp_Message - no separate markUnread() call needed here.
    const result = await upsertLead(token, digits, displayName);
    rememberLocally(digits, result.id);
    await rememberInCache(catalystApp, digits, result.id);
    return result.action + ' Lead ' + result.id;
  } catch (e) {
    return 'FAILED: ' + ((e && e.message) || String(e));
  }
}

module.exports = { ensureLeadForPhone };
