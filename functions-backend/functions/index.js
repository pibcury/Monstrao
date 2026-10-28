/**
 * Monstrão — Cloud Functions (multi-user edition)
 *
 *  estimateCalories  HTTPS  AI calorie/protein estimate (Claude). Per-user approval check,
 *                           per-user daily cap, and token/cost usage logging.
 *  api               Callable  One entry point for the app: session (register/ping), admin
 *                           console actions, and WHOOP connect/sync/disconnect.
 *  seedOwner         HTTPS  One-time: creates the owner account (pibcury@gmail.com) with a random
 *                           password and moves the pre-multi-user data into it.
 *  whoopCallback     HTTPS  OAuth redirect target for "Connect WHOOP".
 *  whoopSyncAll      Scheduled every 30 min: pulls each connected user's WHOOP calories.
 *
 * Firestore layout
 *  users/{uid}                    account record (status, role, usage totals) — server-written
 *  users/{uid}/data/{name}        the user's app data: entries, weights, profile, goals, wearable
 *  users/{uid}/private/whoop      WHOOP OAuth tokens — server only, never readable by any client
 *  usage/{uid}/days/{YYYY-MM-DD}  per-user daily AI usage (calls, tokens, searches, cost)
 *  statsDaily/{YYYY-MM-DD}        app-wide daily stats (active users, AI calls, cost, sign-ups)
 *  invites/{email}                invited emails (auto-approved on sign-up)
 *  config/app                     sign-up mode, default AI cap, owner seeding flag
 *  config/whoop                   WHOOP developer app credentials (set from the admin console)
 *  whoopStates/{state}            short-lived OAuth state → uid mapping
 */

const { onRequest, onCall, HttpsError } = require('firebase-functions/v2/https');
const { onSchedule } = require('firebase-functions/v2/scheduler');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const logger = require('firebase-functions/logger');
const crypto = require('crypto');

initializeApp();
const db = getFirestore();

const REGION = 'us-central1';
const OWNER_EMAIL = 'pibcury@gmail.com';
const APP_TZ = 'America/New_York';        // day boundaries for caps and stats
const anthropicApiKey = defineSecret('ANTHROPIC_API_KEY');

// ---- AI model + pricing (USD per million tokens; web search per 1,000 searches) ----
const MODEL = 'claude-haiku-5-5';
const PRICE_INPUT_PER_MTOK = 0.10;
const PRICE_OUTPUT_PER_MTOK = 0.50;
const PRICE_WEB_SEARCH_PER_1K = 10.0;
const GLOBAL_DAILY_CAP = 600;             // app-wide safety net across all users
const DEFAULT_USER_DAILY_CAP = 40;        // per user per day, unless overridden in the console

const WHOOP_AUTH_URL = 'https://api.prod.whoop.com/oauth/oauth2/auth';
const WHOOP_TOKEN_URL = 'https://api.prod.whoop.com/oauth/oauth2/token';
const WHOOP_API = 'https://api.prod.whoop.com/developer';
const WHOOP_SCOPES = 'offline read:cycles read:profile';
const WHOOP_REDIRECT_URI = `https://${REGION}-monstrao-e04ac.cloudfunctions.net/whoopCallback`;

// =====================================================================================
// helpers
// =====================================================================================
function dayKey(date = new Date()){
  return date.toLocaleDateString('en-CA', { timeZone: APP_TZ }); // YYYY-MM-DD
}
function daysAgoKey(n){
  return dayKey(new Date(Date.now() - n * 86400000));
}
async function getAppConfig(){
  const snap = await db.doc('config/app').get();
  const c = snap.exists ? snap.data() : {};
  return {
    signupMode: c.signupMode === 'open' ? 'open' : 'approval',
    defaultDailyAiCap: Number.isFinite(c.defaultDailyAiCap) ? c.defaultDailyAiCap : DEFAULT_USER_DAILY_CAP,
    ownerSeeded: !!c.ownerSeeded
  };
}
async function verifyBearer(req){
  const m = (req.get('Authorization') || '').match(/^Bearer (.+)$/);
  if(!m) return null;
  try { return await getAuth().verifyIdToken(m[1]); } catch(e){ return null; }
}
function isAdminRole(role){ return role === 'owner' || role === 'admin'; }
function costOf(usage){
  const inTok = (usage && usage.input_tokens) || 0;
  const outTok = (usage && usage.output_tokens) || 0;
  const searches = (usage && usage.server_tool_use && usage.server_tool_use.web_search_requests) || 0;
  const cost = inTok / 1e6 * PRICE_INPUT_PER_MTOK + outTok / 1e6 * PRICE_OUTPUT_PER_MTOK + searches / 1000 * PRICE_WEB_SEARCH_PER_1K;
  return { inTok, outTok, searches, cost };
}

// =====================================================================================
// estimateCalories
// =====================================================================================
const SYSTEM_PROMPT = `You estimate calories and protein for a single food entry in a personal diet-tracking app.
You may be given a text description, a photo of the food, or both. Use whatever you're given to figure out the calorie count and protein content, then reply with ONLY a JSON object as your final message, no other text, no markdown fences, in exactly this shape:
{"label": "short food name, max 40 characters", "calories": 000, "protein": 0}
"calories" must be your best-effort whole-number estimate of total calories for the portion described and/or shown.
"protein" must be your best-effort whole-number estimate of total protein in grams for the same portion.
"label" must be a short, human-readable name for the item suitable as a food-log entry title.
If given only a photo with no text, estimate from the photo alone — identify the food, judge the portion size as best you can from the image, and still return your best single-number estimate rather than refusing.
If the description is vague, still return your best single-number estimate rather than refusing or asking a follow-up question.

You have a web_search tool available. Use it ONLY when you can identify a specific commercial, branded, or packaged product — from the text naming it, or from a photo showing its packaging/label clearly enough to read the brand and product name — where an official nutrition label or published nutrition facts plausibly exist online. In that case, search for the real figure rather than guessing, and use it. Do at most one search; do not keep searching for alternate sources once you have a reasonable figure.
For anything else — homemade dishes, generic descriptions or photos of unpackaged food (a plate, a restaurant dish with no visible branding), or food with no identifiable brand/product name — do NOT search. Just estimate directly; a search would not help and only adds cost and delay. Precision matters here, so when a real published figure is findable, prefer it over a guess even though it costs a little more.
Whatever happens, your final response must still be ONLY the JSON object described above — no explanation, no search summary, no extra text.`;

const ALLOWED_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_IMAGE_BASE64_CHARS = 7_000_000;

exports.estimateCalories = onRequest(
  { secrets: [anthropicApiKey], region: REGION, cors: true },
  async (req, res) => {
    if(req.method !== 'POST'){ res.status(405).json({ error: 'Use POST.' }); return; }

    // ---- 1. signed-in, approved user ----
    const decoded = await verifyBearer(req);
    if(!decoded){ res.status(401).json({ error: 'Please sign in again.' }); return; }
    const uid = decoded.uid;
    const userSnap = await db.doc(`users/${uid}`).get();
    const user = userSnap.exists ? userSnap.data() : null;
    if(!user || user.status !== 'active'){
      res.status(403).json({ error: 'Your account is waiting for approval.' });
      return;
    }

    // ---- 2. input: description, photo, or both ----
    const description = (req.body && typeof req.body.description === 'string') ? req.body.description.trim() : '';
    if(description.length > 1000){ res.status(400).json({ error: 'That description is too long — try trimming it.' }); return; }
    let image = null;
    const rawImage = req.body && req.body.image;
    if(rawImage && typeof rawImage === 'object'){
      const mediaType = typeof rawImage.mediaType === 'string' ? rawImage.mediaType : '';
      const data = typeof rawImage.data === 'string' ? rawImage.data : '';
      if(!ALLOWED_IMAGE_TYPES.has(mediaType)){ res.status(400).json({ error: 'Unsupported photo format — try a different photo.' }); return; }
      if(!data){ res.status(400).json({ error: 'Photo upload looked empty — try again.' }); return; }
      if(data.length > MAX_IMAGE_BASE64_CHARS){ res.status(400).json({ error: 'That photo is too large — try a different one.' }); return; }
      image = { data, mediaType };
    }
    if(!description && !image){ res.status(400).json({ error: 'Describe the food, add a photo, or both.' }); return; }

    // ---- 3. caps: per user (console-adjustable) and app-wide ----
    const today = dayKey();
    const cfg = await getAppConfig();
    const userCap = Number.isFinite(user.aiDailyCap) ? user.aiDailyCap : cfg.defaultDailyAiCap;
    const usageRef = db.doc(`usage/${uid}/days/${today}`);
    const statsRef = db.doc(`statsDaily/${today}`);
    try {
      const verdict = await db.runTransaction(async (tx) => {
        const [u, s] = await Promise.all([tx.get(usageRef), tx.get(statsRef)]);
        const userCalls = u.exists ? (u.data().calls || 0) : 0;
        const allCalls = s.exists ? (s.data().aiCalls || 0) : 0;
        if(userCalls >= userCap) return 'user';
        if(allCalls >= GLOBAL_DAILY_CAP) return 'global';
        tx.set(usageRef, { date: today, calls: FieldValue.increment(1) }, { merge: true });
        tx.set(statsRef, { date: today, aiCalls: FieldValue.increment(1) }, { merge: true });
        return 'ok';
      });
      if(verdict === 'user'){ res.status(429).json({ error: `You've reached today's limit of ${userCap} AI estimates. Log this one manually, or try again tomorrow.` }); return; }
      if(verdict === 'global'){ res.status(429).json({ error: 'The app has reached its AI limit for today. Log this one manually, or try again tomorrow.' }); return; }
    } catch(e){
      logger.error('cap transaction failed', e); // fail open: an infra hiccup shouldn't block logging
    }

    // ---- 4. call Claude ----
    try {
      const userContent = image
        ? [
            { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
            { type: 'text', text: description || 'No text description given — estimate from the photo alone.' }
          ]
        : description;
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': anthropicApiKey.value(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 500,
          thinking: { type: 'disabled' },
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userContent }],
          tools: [{ type: 'web_search_20260318', name: 'web_search', max_uses: 2, allowed_callers: ['direct'] }]
        })
      });
      if(!resp.ok){
        logger.error('Claude API error', resp.status, await resp.text());
        res.status(502).json({ error: 'Calorie estimate failed — the AI service returned an error.' });
        return;
      }
      const data = await resp.json();

      // ---- 5. usage + cost, per user and app-wide (best effort, never blocks the answer) ----
      const u = costOf(data.usage);
      const inc = FieldValue.increment;
      Promise.all([
        usageRef.set({ inputTokens: inc(u.inTok), outputTokens: inc(u.outTok), searches: inc(u.searches), costUsd: inc(u.cost), photos: inc(image ? 1 : 0) }, { merge: true }),
        statsRef.set({ costUsd: inc(u.cost), active: FieldValue.arrayUnion(uid) }, { merge: true }),
        db.doc(`users/${uid}`).set({ aiCallsTotal: inc(1), aiCostTotal: inc(u.cost), lastAiAt: FieldValue.serverTimestamp(), lastActiveAt: FieldValue.serverTimestamp() }, { merge: true })
      ]).catch((e) => logger.error('usage logging failed', e));

      const textBlocks = (data.content || []).filter((b) => b.type === 'text');
      const raw = textBlocks.length ? textBlocks[textBlocks.length - 1].text.trim() : '';
      let parsed;
      try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
      } catch(e){
        logger.error('Could not parse model output', { raw: raw.slice(0, 500), stopReason: data.stop_reason });
        res.status(502).json({ error: 'Calorie estimate failed — could not read the AI response.' });
        return;
      }
      const calories = Math.round(Number(parsed.calories));
      const label = String(parsed.label || '').slice(0, 60).trim();
      if(!Number.isFinite(calories) || calories < 0 || !label){
        res.status(502).json({ error: 'Calorie estimate failed — got an unusable response.' });
        return;
      }
      let protein = Math.round(Number(parsed.protein));
      if(!Number.isFinite(protein) || protein < 0) protein = 0;
      res.status(200).json({ label, calories, protein });
    } catch(e){
      logger.error('estimateCalories failed', e);
      res.status(502).json({ error: 'Calorie estimate failed — could not reach the AI service.' });
    }
  }
);

// =====================================================================================
// seedOwner — open this URL once after deploying. Creates the owner's account with a random
// password nobody knows (use "Forgot password" in the app to set your own), makes it the owner,
// and copies the pre-multi-user data (monstrao/*) into it. Safe to open again: it does nothing
// once seeding is done, never returns credentials, and only ever touches the owner's account.
// =====================================================================================
exports.seedOwner = onRequest({ region: REGION }, async (req, res) => {
  try {
    const cfg = await getAppConfig();
    if(cfg.ownerSeeded){ res.status(200).send(page('Already set up', `The owner account (${OWNER_EMAIL}) already exists. Open the app and sign in.`)); return; }

    let owner;
    try {
      owner = await getAuth().getUserByEmail(OWNER_EMAIL);
    } catch(e){
      owner = await getAuth().createUser({
        email: OWNER_EMAIL,
        emailVerified: true,
        password: crypto.randomBytes(24).toString('base64url')
      });
    }

    // display name from the existing profile, if there is one
    let displayName = '';
    const legacyProfile = await db.doc('monstrao/profile').get();
    if(legacyProfile.exists){
      try { displayName = (JSON.parse(legacyProfile.data().json || '{}').name || '').trim(); } catch(e){}
    }

    await db.doc(`users/${owner.uid}`).set({
      email: OWNER_EMAIL, displayName, role: 'owner', status: 'active',
      createdAt: FieldValue.serverTimestamp(), lastActiveAt: FieldValue.serverTimestamp()
    }, { merge: true });

    const moved = [];
    for(const name of ['entries', 'weights', 'profile', 'goals']){
      const src = await db.doc(`monstrao/${name}`).get();
      const dest = db.doc(`users/${owner.uid}/data/${name}`);
      if(src.exists && !(await dest.get()).exists){
        await dest.set({ json: src.data().json || '{}', updatedAt: FieldValue.serverTimestamp(), migratedFrom: `monstrao/${name}` });
        moved.push(name);
      }
    }

    await db.doc('config/app').set({
      ownerSeeded: true, ownerUid: owner.uid, signupMode: 'approval', defaultDailyAiCap: DEFAULT_USER_DAILY_CAP,
      seededAt: FieldValue.serverTimestamp()
    }, { merge: true });

    logger.info('owner seeded', { uid: owner.uid, moved });
    res.status(200).send(page('Owner account ready',
      `Created <b>${OWNER_EMAIL}</b> as the app owner and moved your data (${moved.join(', ') || 'nothing to move'}).<br><br>` +
      `Next: open Monstrão, tap <b>Forgot password?</b>, enter ${OWNER_EMAIL}, and set your password from the email.`));
  } catch(e){
    logger.error('seedOwner failed', e);
    res.status(500).send(page('Setup failed', 'Check the function logs in the Firebase console, then try this link again.'));
  }
});
function page(title, body){
  return `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>` +
    `<body style="font:16px/1.5 -apple-system,Inter,sans-serif;background:#0E1014;color:#F4F5F7;padding:32px;max-width:520px;margin:auto">` +
    `<h2 style="margin:0 0 12px">${title}</h2><p style="color:#C9CCD6">${body}</p></body>`;
}

// =====================================================================================
// api — every app call goes through here: { action, ...params }
// =====================================================================================
exports.api = onCall({ region: REGION }, async (request) => {
  if(!request.auth) throw new HttpsError('unauthenticated', 'Please sign in.');
  const uid = request.auth.uid;
  const email = (request.auth.token.email || '').toLowerCase();
  const p = request.data || {};
  const action = String(p.action || '');

  if(action === 'session') return session(uid, email, p);

  const meSnap = await db.doc(`users/${uid}`).get();
  const me = meSnap.exists ? meSnap.data() : null;
  if(!me) throw new HttpsError('failed-precondition', 'Account not set up yet.');

  if(action.startsWith('whoop.')){
    if(me.status !== 'active') throw new HttpsError('permission-denied', 'Your account is waiting for approval.');
    return whoopAction(uid, action, p);
  }
  if(action.startsWith('admin.')){
    if(!isAdminRole(me.role)) throw new HttpsError('permission-denied', 'Admins only.');
    return adminAction(uid, me, action, p);
  }
  throw new HttpsError('invalid-argument', `Unknown action: ${action}`);
});

// ---- session: called on every app start. Creates the account record on first sign-in. ----
async function session(uid, email, p){
  const ref = db.doc(`users/${uid}`);
  const snap = await ref.get();
  const today = dayKey();
  let user;
  if(!snap.exists){
    const cfg = await getAppConfig();
    const isOwner = email === OWNER_EMAIL;
    const invite = email ? await db.doc(`invites/${email}`).get() : null;
    const invited = !!(invite && invite.exists);
    user = {
      email,
      displayName: String(p.displayName || '').slice(0, 60).trim(),
      role: isOwner ? 'owner' : 'user',
      status: (isOwner || invited || cfg.signupMode === 'open') ? 'active' : 'pending',
      invited,
      createdAt: FieldValue.serverTimestamp(),
      lastActiveAt: FieldValue.serverTimestamp()
    };
    await ref.set(user);
    if(invited) await db.doc(`invites/${email}`).set({ usedBy: uid, usedAt: FieldValue.serverTimestamp() }, { merge: true });
    await db.doc(`statsDaily/${today}`).set({ date: today, signups: FieldValue.increment(1) }, { merge: true });
  } else {
    user = snap.data();
    const patch = { lastActiveAt: FieldValue.serverTimestamp() };
    if(!user.displayName && p.displayName) patch.displayName = String(p.displayName).slice(0, 60).trim();
    if(email && user.email !== email) patch.email = email;
    await ref.set(patch, { merge: true });
  }
  if(user.status === 'active'){
    await db.doc(`statsDaily/${today}`).set({ date: today, active: FieldValue.arrayUnion(uid) }, { merge: true });
  }
  const whoopCfg = await db.doc('config/whoop').get();
  return {
    status: user.status,
    role: user.role,
    isAdmin: isAdminRole(user.role),
    whoop: {
      available: whoopCfg.exists && !!whoopCfg.data().clientId,
      connected: !!(user.whoop && user.whoop.connected),
      lastSyncAt: user.whoop && user.whoop.lastSyncAt ? user.whoop.lastSyncAt.toMillis() : null,
      lastError: (user.whoop && user.whoop.lastError) || null
    }
  };
}

// =====================================================================================
// admin console actions
// =====================================================================================
async function adminAction(myUid, me, action, p){
  const isOwner = me.role === 'owner';
  const targetRef = p.uid ? db.doc(`users/${p.uid}`) : null;
  const guardTarget = async () => {
    if(!targetRef) throw new HttpsError('invalid-argument', 'Missing user.');
    const t = await targetRef.get();
    if(!t.exists) throw new HttpsError('not-found', 'User not found.');
    if(t.data().role === 'owner') throw new HttpsError('permission-denied', "The owner account can't be changed here.");
    if(t.data().role === 'admin' && !isOwner) throw new HttpsError('permission-denied', 'Only the owner can change another admin.');
    return t.data();
  };

  switch(action){
    case 'admin.overview': return adminOverview();

    case 'admin.setStatus': {
      const status = p.status;
      if(!['active', 'disabled', 'pending'].includes(status)) throw new HttpsError('invalid-argument', 'Bad status.');
      await guardTarget();
      await targetRef.set({ status, statusChangedAt: FieldValue.serverTimestamp(), statusChangedBy: myUid }, { merge: true });
      await getAuth().updateUser(p.uid, { disabled: status === 'disabled' });
      if(status === 'disabled') await getAuth().revokeRefreshTokens(p.uid);
      return { ok: true };
    }
    case 'admin.setRole': {
      if(!isOwner) throw new HttpsError('permission-denied', 'Only the owner can change roles.');
      if(!['admin', 'user'].includes(p.role)) throw new HttpsError('invalid-argument', 'Bad role.');
      await guardTarget();
      await targetRef.set({ role: p.role }, { merge: true });
      return { ok: true };
    }
    case 'admin.setCap': {
      // a usage limit is harmless to change on anyone, including the owner's own account
      if(!targetRef || !(await targetRef.get()).exists) throw new HttpsError('not-found', 'User not found.');
      let cap;
      if(p.cap === null || p.cap === '' || p.cap === undefined){
        cap = FieldValue.delete(); // back to the app-wide default
      } else {
        const n = Math.round(Number(p.cap));
        if(!Number.isFinite(n) || n < 0 || n > 500) throw new HttpsError('invalid-argument', 'Daily limit must be 0–500.');
        cap = n;
      }
      await targetRef.set({ aiDailyCap: cap }, { merge: true });
      return { ok: true };
    }
    case 'admin.invite': {
      const em = String(p.email || '').trim().toLowerCase();
      if(!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) throw new HttpsError('invalid-argument', 'Enter a valid email.');
      await db.doc(`invites/${em}`).set({ email: em, invitedAt: FieldValue.serverTimestamp(), invitedBy: myUid });
      // already signed up and waiting? approve them now
      const pending = await db.collection('users').where('email', '==', em).limit(1).get();
      let activated = false;
      for(const d of pending.docs){
        if(d.data().status === 'pending'){ await d.ref.set({ status: 'active', invited: true }, { merge: true }); activated = true; }
      }
      return { ok: true, activated };
    }
    case 'admin.revokeInvite': {
      const em = String(p.email || '').trim().toLowerCase();
      await db.doc(`invites/${em}`).delete();
      return { ok: true };
    }
    case 'admin.disconnectWhoop': {
      // allowed on any member, including admins and the owner: it only removes a connection
      if(!targetRef || !(await targetRef.get()).exists) throw new HttpsError('not-found', 'User not found.');
      const r = await disconnectWhoop(p.uid, myUid);
      return { ok: true, ...r };
    }
    case 'admin.deleteUser': {
      await guardTarget();
      await disconnectWhoop(p.uid, myUid); // free their WHOOP slot before their data goes
      await db.recursiveDelete(db.doc(`users/${p.uid}`));
      await db.recursiveDelete(db.doc(`usage/${p.uid}`));
      try { await getAuth().deleteUser(p.uid); } catch(e){ logger.warn('auth delete failed', e); }
      return { ok: true };
    }
    case 'admin.setConfig': {
      const patch = {};
      if(p.signupMode) patch.signupMode = p.signupMode === 'open' ? 'open' : 'approval';
      if(p.defaultDailyAiCap !== undefined){
        const n = Math.round(Number(p.defaultDailyAiCap));
        if(!Number.isFinite(n) || n < 0 || n > 500) throw new HttpsError('invalid-argument', 'Daily limit must be 0–500.');
        patch.defaultDailyAiCap = n;
      }
      await db.doc('config/app').set(patch, { merge: true });
      return { ok: true };
    }
    case 'admin.setWhoopApp': {
      if(!isOwner) throw new HttpsError('permission-denied', 'Only the owner can set this.');
      const clientId = String(p.clientId || '').trim(), clientSecret = String(p.clientSecret || '').trim();
      if(!clientId || !clientSecret) throw new HttpsError('invalid-argument', 'Enter both the client ID and secret.');
      await db.doc('config/whoop').set({ clientId, clientSecret, updatedAt: FieldValue.serverTimestamp() });
      return { ok: true };
    }
    default: throw new HttpsError('invalid-argument', `Unknown action: ${action}`);
  }
}

async function adminOverview(){
  const since = daysAgoKey(29);
  const [usersSnap, invitesSnap, statsSnap, cfg, whoopCfg, authList] = await Promise.all([
    db.collection('users').get(),
    db.collection('invites').get(),
    db.collection('statsDaily').where('date', '>=', since).get(),
    getAppConfig(),
    db.doc('config/whoop').get(),
    getAuth().listUsers(1000)
  ]);
  const authById = new Map(authList.users.map((u) => [u.uid, u]));
  const monthPrefix = dayKey().slice(0, 7);

  const users = await Promise.all(usersSnap.docs.map(async (d) => {
    const u = d.data();
    const [usageSnap, entriesSnap] = await Promise.all([
      db.collection(`usage/${d.id}/days`).where('date', '>=', since).get(),
      db.doc(`users/${d.id}/data/entries`).get()
    ]);
    let calls30 = 0, cost30 = 0, callsMonth = 0, costMonth = 0, photos30 = 0, searches30 = 0;
    usageSnap.forEach((s) => {
      const x = s.data();
      calls30 += x.calls || 0; cost30 += x.costUsd || 0; photos30 += x.photos || 0; searches30 += x.searches || 0;
      if((x.date || s.id).startsWith(monthPrefix)){ callsMonth += x.calls || 0; costMonth += x.costUsd || 0; }
    });
    let daysLogged = 0, lastLogDate = null;
    if(entriesSnap.exists){
      try {
        const e = JSON.parse(entriesSnap.data().json || '{}');
        const dates = Object.keys(e).filter((k) => {
          const v = e[k] || {};
          return (v.items && v.items.length) || typeof v.total === 'number' || typeof v.burned === 'number';
        }).sort();
        daysLogged = dates.length; lastLogDate = dates[dates.length - 1] || null;
      } catch(err){}
    }
    const a = authById.get(d.id);
    const ts = (v) => (v && v.toMillis ? v.toMillis() : null);
    return {
      uid: d.id, email: u.email || (a && a.email) || '', displayName: u.displayName || '',
      role: u.role || 'user', status: u.status || 'pending', invited: !!u.invited,
      createdAt: ts(u.createdAt) || (a ? Date.parse(a.metadata.creationTime) : null),
      lastActiveAt: ts(u.lastActiveAt) || (a && a.metadata.lastSignInTime ? Date.parse(a.metadata.lastSignInTime) : null),
      emailVerified: !!(a && a.emailVerified),
      aiDailyCap: Number.isFinite(u.aiDailyCap) ? u.aiDailyCap : null,
      aiCallsTotal: u.aiCallsTotal || 0, aiCostTotal: u.aiCostTotal || 0,
      calls30, cost30, callsMonth, costMonth, photos30, searches30,
      daysLogged, lastLogDate,
      whoopConnected: !!(u.whoop && u.whoop.connected)
    };
  }));

  const statsByDate = new Map(statsSnap.docs.map((s) => [s.id, s.data()]));
  const series = [];
  for(let i = 29; i >= 0; i--){
    const k = daysAgoKey(i);
    const s = statsByDate.get(k) || {};
    series.push({ date: k, activeUsers: (s.active || []).length, aiCalls: s.aiCalls || 0, costUsd: s.costUsd || 0, signups: s.signups || 0 });
  }

  return {
    users,
    invites: invitesSnap.docs.filter((d) => !d.data().usedBy).map((d) => ({ email: d.id, invitedAt: d.data().invitedAt ? d.data().invitedAt.toMillis() : null })),
    series,
    config: { signupMode: cfg.signupMode, defaultDailyAiCap: cfg.defaultDailyAiCap },
    whoop: { configured: whoopCfg.exists && !!whoopCfg.data().clientId, redirectUri: WHOOP_REDIRECT_URI },
    pricing: { model: MODEL, inputPerMTok: PRICE_INPUT_PER_MTOK, outputPerMTok: PRICE_OUTPUT_PER_MTOK, webSearchPer1k: PRICE_WEB_SEARCH_PER_1K }
  };
}

// =====================================================================================
// WHOOP
//  - Each WHOOP "cycle" runs from one sleep to the next. Its score.kilojoule is total energy
//    expenditure (resting + active) — the same number the WHOOP app shows as calories.
//  - The current cycle has no end yet and its kilojoule keeps rising through the day; once the
//    next sleep starts the cycle closes and the value is final.
//  - A cycle is filed under the local calendar date of (start + 12h), so a cycle that begins
//    with sleep at 11:30pm on the 26th counts as the 27th — the day you were awake for.
// =====================================================================================
async function whoopCreds(){
  const s = await db.doc('config/whoop').get();
  if(!s.exists || !s.data().clientId) throw new HttpsError('failed-precondition', 'WHOOP isn’t set up for this app yet.');
  return s.data();
}

async function whoopAction(uid, action, p){
  switch(action){
    case 'whoop.authUrl': {
      const creds = await whoopCreds();
      const state = crypto.randomBytes(16).toString('hex');
      const returnUrl = /^https:\/\//.test(p.returnUrl || '') ? p.returnUrl : null;
      await db.doc(`whoopStates/${state}`).set({ uid, returnUrl, createdAt: FieldValue.serverTimestamp() });
      const q = new URLSearchParams({
        client_id: creds.clientId, redirect_uri: WHOOP_REDIRECT_URI, response_type: 'code', scope: WHOOP_SCOPES, state
      });
      return { url: `${WHOOP_AUTH_URL}?${q.toString()}` };
    }
    case 'whoop.sync': {
      const result = await syncWhoopUser(uid, { days: 4 });
      return result;
    }
    case 'whoop.disconnect': {
      await disconnectWhoop(uid);
      return { ok: true };
    }
    default: throw new HttpsError('invalid-argument', `Unknown action: ${action}`);
  }
}

exports.whoopCallback = onRequest({ region: REGION }, async (req, res) => {
  const { code, state, error } = req.query;
  let returnUrl = null;
  try {
    if(!state) throw new Error('missing state');
    const stRef = db.doc(`whoopStates/${state}`);
    const st = await stRef.get();
    if(!st.exists) throw new Error('unknown state');
    await stRef.delete();
    const { uid, createdAt } = st.data();
    returnUrl = st.data().returnUrl;
    if(createdAt && Date.now() - createdAt.toMillis() > 15 * 60000) throw new Error('state expired');
    if(error) throw new Error(String(error));
    if(!code) throw new Error('missing code');

    const creds = await whoopCreds();
    const tokResp = await fetch(WHOOP_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code: String(code), redirect_uri: WHOOP_REDIRECT_URI,
        client_id: creds.clientId, client_secret: creds.clientSecret
      })
    });
    if(!tokResp.ok) throw new Error(`token exchange ${tokResp.status}: ${await tokResp.text()}`);
    const tok = await tokResp.json();
    await saveWhoopTokens(uid, tok);
    await db.doc(`users/${uid}`).set({ whoop: { connected: true, connectedAt: FieldValue.serverTimestamp(), lastError: null } }, { merge: true });
    try { await syncWhoopUser(uid, { days: 60 }); } catch(e){ logger.warn('initial WHOOP backfill failed', e); }
    res.redirect(302, (returnUrl || 'https://www.whoop.com') + '#whoop=connected');
  } catch(e){
    logger.error('whoopCallback failed', e);
    if(returnUrl) res.redirect(302, returnUrl + '#whoop=error');
    else res.status(400).send(page('WHOOP connection failed', 'Go back to Monstrão and try connecting again.'));
  }
});

// Revokes the app's access on WHOOP's side (so the member stops counting toward WHOOP's limit),
// then deletes the stored tokens. Used by the member's own Disconnect, the admin console, and
// account deletion. `by` records who did it.
async function disconnectWhoop(uid, by){
  const tokSnap = await db.doc(`users/${uid}/private/whoop`).get();
  let revoked = false;
  if(tokSnap.exists){
    try {
      const token = await whoopAccessToken(uid); // refreshed if expired, so the revoke call is accepted
      const r = await fetch(`${WHOOP_API}/v2/user/access`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      revoked = r.ok || r.status === 204;
      if(!revoked) logger.warn('WHOOP revoke returned', r.status);
    } catch(e){ logger.warn('WHOOP revoke failed', e); }
    await db.doc(`users/${uid}/private/whoop`).delete();
  }
  const userRef = db.doc(`users/${uid}`);
  if((await userRef.get()).exists){
    await userRef.set({ whoop: { connected: false, disconnectedAt: FieldValue.serverTimestamp(), disconnectedBy: by || uid } }, { merge: true });
  }
  return { revoked, hadConnection: tokSnap.exists };
}

async function saveWhoopTokens(uid, tok){
  await db.doc(`users/${uid}/private/whoop`).set({
    accessToken: tok.access_token,
    refreshToken: tok.refresh_token,
    expiresAt: Date.now() + (Number(tok.expires_in) || 3600) * 1000,
    scope: tok.scope || WHOOP_SCOPES,
    updatedAt: FieldValue.serverTimestamp()
  });
}

// WHOOP rotates BOTH tokens on every refresh, so two refreshes racing would invalidate each
// other. The refresh runs inside a Firestore transaction that re-reads the token doc first.
async function whoopAccessToken(uid){
  const ref = db.doc(`users/${uid}/private/whoop`);
  const snap = await ref.get();
  if(!snap.exists) throw new Error('not connected');
  if(snap.data().expiresAt > Date.now() + 120000) return snap.data().accessToken;
  const creds = await whoopCreds();
  return db.runTransaction(async (tx) => {
    const cur = await tx.get(ref);
    const t = cur.data();
    if(t.expiresAt > Date.now() + 120000) return t.accessToken;
    const resp = await fetch(WHOOP_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: t.refreshToken,
        client_id: creds.clientId, client_secret: creds.clientSecret, scope: 'offline'
      })
    });
    if(!resp.ok) throw new Error(`refresh failed ${resp.status}: ${await resp.text()}`);
    const tok = await resp.json();
    tx.set(ref, {
      accessToken: tok.access_token, refreshToken: tok.refresh_token || t.refreshToken,
      expiresAt: Date.now() + (Number(tok.expires_in) || 3600) * 1000, updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return tok.access_token;
  });
}

function cycleDate(cycle){
  const m = String(cycle.timezone_offset || '+00:00').match(/^([+-])(\d{2}):?(\d{2})$/);
  const offMin = m ? (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  const local = new Date(Date.parse(cycle.start) + offMin * 60000 + 12 * 3600000);
  return local.toISOString().slice(0, 10);
}

async function syncWhoopUser(uid, { days = 4 } = {}){
  const userRef = db.doc(`users/${uid}`);
  try {
    const token = await whoopAccessToken(uid);
    const start = new Date(Date.now() - days * 86400000).toISOString();
    const cycles = [];
    let nextToken = null;
    for(let page = 0; page < 12; page++){
      const q = new URLSearchParams({ start, limit: '25' });
      if(nextToken) q.set('nextToken', nextToken);
      const r = await fetch(`${WHOOP_API}/v2/cycle?${q.toString()}`, { headers: { Authorization: `Bearer ${token}` } });
      if(r.status === 401) throw new Error('WHOOP access was revoked — reconnect WHOOP.');
      if(!r.ok) throw new Error(`cycle fetch ${r.status}`);
      const body = await r.json();
      cycles.push(...(body.records || []));
      nextToken = body.next_token || null;
      if(!nextToken) break;
    }

    const wRef = db.doc(`users/${uid}/data/wearable`);
    const wSnap = await wRef.get();
    let store = {};
    try { store = wSnap.exists ? JSON.parse(wSnap.data().json || '{}') : {}; } catch(e){ store = {}; }

    let changed = 0;
    for(const c of cycles){
      const kj = c.score && Number(c.score.kilojoule);
      if(!Number.isFinite(kj) || kj <= 0) continue; // PENDING_SCORE / UNSCORABLE — never show as zero
      const date = cycleDate(c);
      const rec = { kcal: Math.round(kj / 4.184), final: !!c.end, source: 'whoop', cycleId: c.id, updatedAt: c.updated_at || null };
      const prev = store[date];
      if(prev && prev.final && !rec.final) continue;
      if(!prev || prev.kcal !== rec.kcal || prev.final !== rec.final){ store[date] = rec; changed++; }
    }
    // keep ~400 days
    const keys = Object.keys(store).sort();
    while(keys.length > 400) delete store[keys.shift()];

    if(changed || !wSnap.exists){
      await wRef.set({ json: JSON.stringify(store), updatedAt: FieldValue.serverTimestamp() });
    }
    await userRef.set({ whoop: { connected: true, lastSyncAt: FieldValue.serverTimestamp(), lastError: null } }, { merge: true });
    return { ok: true, cycles: cycles.length, changed };
  } catch(e){
    logger.warn('WHOOP sync failed', { uid, err: String(e && e.message || e) });
    const revoked = /revoked|refresh failed 4/.test(String(e && e.message));
    await userRef.set({ whoop: { lastError: String(e && e.message || e).slice(0, 200), ...(revoked ? { connected: false } : {}) } }, { merge: true });
    return { ok: false, error: String(e && e.message || e) };
  }
}

exports.whoopSyncAll = onSchedule({ schedule: 'every 30 minutes', region: REGION, timeoutSeconds: 300 }, async () => {
  const cfg = await db.doc('config/whoop').get();
  if(!cfg.exists || !cfg.data().clientId) return;
  const snap = await db.collection('users').where('whoop.connected', '==', true).get();
  for(const d of snap.docs){
    if(d.data().status !== 'active') continue;
    await syncWhoopUser(d.id, { days: 3 });
  }
  // tidy up abandoned OAuth attempts
  const old = await db.collection('whoopStates').where('createdAt', '<', new Date(Date.now() - 3600000)).get();
  await Promise.all(old.docs.map((x) => x.ref.delete()));
});
