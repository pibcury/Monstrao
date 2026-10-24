/**
 * Cloud Function: estimateCalories
 *
 * Takes a free-text food description from the Monstrão app and returns an
 * estimated calorie count + a short label, using the Claude API.
 *
 * Security:
 *  - The Anthropic API key lives only here, as a Secret Manager secret
 *    (ANTHROPIC_API_KEY). It is never sent to, or visible from, the browser.
 *  - Every request must carry a valid Firebase ID token (the app already
 *    signs the user in anonymously and can fetch one for free).
 *  - A simple per-day counter in Firestore caps total calls, so a bug or a
 *    stranger who finds this URL can't run up an unbounded bill.
 */

const { onRequest } = require('firebase-functions/v2/https');
const { defineSecret } = require('firebase-functions/params');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');
const logger = require('firebase-functions/logger');

initializeApp();

const anthropicApiKey = defineSecret('ANTHROPIC_API_KEY');

const MODEL = 'claude-haiku-5-5';
const DAILY_CAP = 200; // generous for one personal user; raise/lower as you like

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
const MAX_IMAGE_BASE64_CHARS = 7_000_000; // ~5MB raw, comfortably under the API's per-image cap

exports.estimateCalories = onRequest(
  { secrets: [anthropicApiKey], region: 'us-central1', cors: true },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Use POST.' });
      return;
    }

    // ---- 1. verify the caller is signed in to this app (anonymous auth is fine) ----
    const authHeader = req.get('Authorization') || '';
    const match = authHeader.match(/^Bearer (.+)$/);
    if (!match) {
      res.status(401).json({ error: 'Missing auth token.' });
      return;
    }
    try {
      await getAuth().verifyIdToken(match[1]);
    } catch (e) {
      res.status(401).json({ error: 'Invalid auth token.' });
      return;
    }

    // ---- 2. validate input: a description, a photo, or both ----
    const description = (req.body && typeof req.body.description === 'string') ? req.body.description.trim() : '';
    if (description.length > 1000) {
      res.status(400).json({ error: 'That description is too long — try trimming it.' });
      return;
    }

    let image = null; // { data: base64, mediaType }
    const rawImage = req.body && req.body.image;
    if (rawImage && typeof rawImage === 'object') {
      const mediaType = typeof rawImage.mediaType === 'string' ? rawImage.mediaType : '';
      const data = typeof rawImage.data === 'string' ? rawImage.data : '';
      if (!ALLOWED_IMAGE_TYPES.has(mediaType)) {
        res.status(400).json({ error: 'Unsupported photo format — try a different photo.' });
        return;
      }
      if (!data) {
        res.status(400).json({ error: 'Photo upload looked empty — try again.' });
        return;
      }
      if (data.length > MAX_IMAGE_BASE64_CHARS) {
        res.status(400).json({ error: 'That photo is too large — try a different one.' });
        return;
      }
      image = { data, mediaType };
    }

    if (!description && !image) {
      res.status(400).json({ error: 'Describe the food, add a photo, or both.' });
      return;
    }

    // ---- 3. daily cap: a cheap guard against a bug or abuse burning through API credit ----
    const db = getFirestore();
    const today = new Date().toISOString().slice(0, 10);
    const counterRef = db.collection('monstrao').doc('aiCallCounter');
    try {
      const overCap = await db.runTransaction(async (tx) => {
        const snap = await tx.get(counterRef);
        const data = snap.exists ? snap.data() : {};
        const count = (data.date === today) ? (data.count || 0) : 0;
        if (count >= DAILY_CAP) return true;
        tx.set(counterRef, { date: today, count: count + 1 }, { merge: true });
        return false;
      });
      if (overCap) {
        res.status(429).json({ error: `Daily estimate limit reached (${DAILY_CAP}). Log this one manually, or try again tomorrow.` });
        return;
      }
    } catch (e) {
      logger.error('counter transaction failed', e);
      // fail open on the counter itself — an infra hiccup here shouldn't block logging
    }

    // ---- 4. call Claude ----
    try {
      // text-only keeps the simple string form; a photo (with or without text) switches to a
      // content-block array — an image block, plus a text block (a fallback line when there's
      // no typed description at all, so the model always gets an explicit instruction).
      const userContent = image
        ? [
            { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.data } },
            { type: 'text', text: description || 'No text description given — estimate from the photo alone.' }
          ]
        : description;

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropicApiKey.value(),
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 500,
          thinking: { type: 'disabled' },
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userContent }],
          tools: [{
            type: 'web_search_20260318',
            name: 'web_search',
            max_uses: 2,
            allowed_callers: ['direct']
          }]
        })
      });

      if (!resp.ok) {
        const errText = await resp.text();
        logger.error('Claude API error', resp.status, errText);
        res.status(502).json({ error: 'Calorie estimate failed — the AI service returned an error.' });
        return;
      }

      const data = await resp.json();
      // with web search enabled, content can include search/tool-use blocks before
      // the final answer — take the LAST text block, not the first, as the result
      const textBlocks = (data.content || []).filter((b) => b.type === 'text');
      const block = textBlocks.length ? textBlocks[textBlocks.length - 1] : null;
      const raw = block ? block.text.trim() : '';
      const searchCount = (data.usage && data.usage.server_tool_use && data.usage.server_tool_use.web_search_requests) || 0;
      if (searchCount > 0) {
        logger.info('estimateCalories used web search', { searchCount, hasImage: !!image, description: description.slice(0, 100) });
      }

      let parsed;
      try {
        // tolerate the model wrapping JSON in a code fence despite instructions not to
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
      } catch (e) {
        logger.error('Could not parse model output', {
          raw,
          rawLength: raw.length,
          stopReason: data.stop_reason,
          contentTypes: (data.content || []).map((b) => b.type),
          fullResponse: JSON.stringify(data).slice(0, 2000)
        });
        res.status(502).json({ error: 'Calorie estimate failed — could not read the AI response.' });
        return;
      }

      const calories = Math.round(Number(parsed.calories));
      const label = String(parsed.label || '').slice(0, 60).trim();
      if (!Number.isFinite(calories) || calories < 0 || !label) {
        res.status(502).json({ error: 'Calorie estimate failed — got an unusable response.' });
        return;
      }
      // protein is a newer field — tolerate an older/odd model response missing it rather than
      // failing the whole estimate, defaulting to 0 instead of blocking on it.
      let protein = Math.round(Number(parsed.protein));
      if (!Number.isFinite(protein) || protein < 0) protein = 0;

      res.status(200).json({ label, calories, protein });
    } catch (e) {
      logger.error('estimateCalories failed', e);
      res.status(502).json({ error: 'Calorie estimate failed — could not reach the AI service.' });
    }
  }
);

/**
 * Cloud Function: cleanupFoodSuggestions
 *
 * Once a day (the app itself enforces the "once a day" part — this function just
 * trusts the call it's given and applies its own low-volume safety cap), the app
 * sends the compact list of distinct foods its own local clustering has already
 * produced from the log history — NOT the raw log, so the payload and the token
 * cost stay small and bounded no matter how much history exists. Claude's job is
 * narrow: merge entries that are clearly the same food under different wording,
 * pick one clean label per group, and reconcile each group's calorie figure from
 * the numbers it was given (never invent one from outside food knowledge). This
 * never decides WHICH foods get suggested or WHEN — that stays in the app's own
 * fast, free, local time-of-day/recency heuristic; this only tidies the pool it
 * draws from.
 */
const SUGGESTION_MODEL = 'claude-haiku-5-5';
const SUGGESTION_DAILY_CAP = 10; // the app calls this at most once/day; this is just a safety net
const MAX_CLUSTERS_IN = 60;

const SUGGESTION_SYSTEM_PROMPT = `You clean up a personal diet-tracking app's list of frequently-logged foods, so its quick-add suggestions look tidy instead of fragmented by rewording.

You will be given a JSON array of distinct food entries the app's own clustering already produced from someone's log history. Each has:
- "key": the exact text currently representing it (treat this as an opaque id, not just a label)
- "count": how many times it (or a near-duplicate) was logged
- "avgCal": the average calories logged under it
- "lastCal": the most recently logged calorie figure for it
- "lastSeen": the date it was last logged (YYYY-MM-DD)

Some of these "distinct" entries are actually the same food under slightly different wording (e.g. "chx breast" and "grilled chicken breast") that the app's own text matching didn't catch. Your job:
1. Group entries that are clearly the same food. Leave genuinely different foods separate even if related (e.g. "chicken breast" and "chicken thigh" are NOT the same food — keep them in different groups).
2. For every input entry, including ones that stay in a group of one, pick or lightly rewrite ONE clean, short, human-readable label (max 40 characters) for its group — fix typos/abbreviations/casing, but don't invent detail (brand, portion, preparation) that isn't already implied by the inputs.
3. For each group, choose ONE sensible calorie number from the avgCal/lastCal figures you were given for its members: prefer the lastCal of whichever member has the highest count, unless the figures disagree wildly within the group (e.g. one member's lastCal is 5-10x the others', suggesting a typo) — in that case prefer the more internally consistent figure instead. Only reconcile the numbers you were given; never estimate calories from outside knowledge of the food.

Reply with ONLY a JSON object as your entire response, no other text, no markdown fences, in exactly this shape:
{"groups":[{"desc":"string, max 40 chars","cal":000,"memberKeys":["<exact key from input>", "..."]}]}
Every input "key" must appear in exactly one group's "memberKeys", copied EXACTLY as given — this is how the app matches your groups back to its own data, so never alter, retype, or omit a key.`;

exports.cleanupFoodSuggestions = onRequest(
  { secrets: [anthropicApiKey], region: 'us-central1', cors: true },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'Use POST.' });
      return;
    }

    // ---- 1. verify the caller is signed in to this app ----
    const authHeader = req.get('Authorization') || '';
    const match = authHeader.match(/^Bearer (.+)$/);
    if (!match) {
      res.status(401).json({ error: 'Missing auth token.' });
      return;
    }
    try {
      await getAuth().verifyIdToken(match[1]);
    } catch (e) {
      res.status(401).json({ error: 'Invalid auth token.' });
      return;
    }

    // ---- 2. validate input: an array of pre-clustered food digests, not raw log entries ----
    const clustersIn = req.body && Array.isArray(req.body.clusters) ? req.body.clusters : null;
    if (!clustersIn || !clustersIn.length) {
      res.status(400).json({ error: 'No clusters given.' });
      return;
    }
    if (clustersIn.length > MAX_CLUSTERS_IN) {
      res.status(400).json({ error: `Too many clusters (max ${MAX_CLUSTERS_IN}).` });
      return;
    }
    const clusters = [];
    const seenKeys = new Set();
    for (const c of clustersIn) {
      if (!c || typeof c !== 'object') continue;
      const key = typeof c.key === 'string' ? c.key.slice(0, 200).trim() : '';
      const count = Number(c.count);
      const avgCal = Number(c.avgCal);
      const lastCal = Number(c.lastCal);
      const lastSeen = typeof c.lastSeen === 'string' ? c.lastSeen.slice(0, 10) : '';
      if (!key || seenKeys.has(key)) continue;
      if (!Number.isFinite(count) || !Number.isFinite(avgCal) || !Number.isFinite(lastCal)) continue;
      seenKeys.add(key);
      clusters.push({ key, count: Math.round(count), avgCal: Math.round(avgCal), lastCal: Math.round(lastCal), lastSeen });
    }
    if (clusters.length < 2) {
      res.status(400).json({ error: 'Not enough valid clusters to clean up.' });
      return;
    }

    // ---- 3. daily cap: the app itself only calls this once/day; this is just a backstop ----
    const db = getFirestore();
    const today = new Date().toISOString().slice(0, 10);
    const counterRef = db.collection('monstrao').doc('suggestionCleanupCounter');
    try {
      const overCap = await db.runTransaction(async (tx) => {
        const snap = await tx.get(counterRef);
        const data = snap.exists ? snap.data() : {};
        const count = (data.date === today) ? (data.count || 0) : 0;
        if (count >= SUGGESTION_DAILY_CAP) return true;
        tx.set(counterRef, { date: today, count: count + 1 }, { merge: true });
        return false;
      });
      if (overCap) {
        res.status(429).json({ error: `Daily cleanup limit reached (${SUGGESTION_DAILY_CAP}).` });
        return;
      }
    } catch (e) {
      logger.error('suggestion cleanup counter transaction failed', e);
      // fail open on the counter itself
    }

    // ---- 4. call Claude ----
    try {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropicApiKey.value(),
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: SUGGESTION_MODEL,
          max_tokens: 1500,
          thinking: { type: 'disabled' },
          system: SUGGESTION_SYSTEM_PROMPT,
          messages: [{ role: 'user', content: JSON.stringify(clusters) }]
        })
      });

      if (!resp.ok) {
        const errText = await resp.text();
        logger.error('Claude API error (cleanup)', resp.status, errText);
        res.status(502).json({ error: 'Cleanup failed — the AI service returned an error.' });
        return;
      }

      const data = await resp.json();
      const textBlocks = (data.content || []).filter((b) => b.type === 'text');
      const block = textBlocks.length ? textBlocks[textBlocks.length - 1] : null;
      const raw = block ? block.text.trim() : '';

      let parsed;
      try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
      } catch (e) {
        logger.error('Could not parse cleanup model output', { raw, rawLength: raw.length });
        res.status(502).json({ error: 'Cleanup failed — could not read the AI response.' });
        return;
      }

      // ---- 5. validate the model's own output before trusting it back to the client ----
      const groupsIn = Array.isArray(parsed.groups) ? parsed.groups : [];
      const inputKeys = new Set(clusters.map((c) => c.key));
      const claimedKeys = new Set();
      const groups = [];
      for (const g of groupsIn) {
        if (!g || typeof g !== 'object') continue;
        const desc = typeof g.desc === 'string' ? g.desc.slice(0, 40).trim() : '';
        const cal = Math.round(Number(g.cal));
        const memberKeys = Array.isArray(g.memberKeys)
          ? g.memberKeys.filter((k) => typeof k === 'string' && inputKeys.has(k) && !claimedKeys.has(k))
          : [];
        if (!desc || !Number.isFinite(cal) || cal < 0 || !memberKeys.length) continue;
        memberKeys.forEach((k) => claimedKeys.add(k));
        groups.push({ desc, cal, memberKeys });
      }
      // any input key the model dropped still gets its own single-member group, using its own
      // data unchanged — a partial/sloppy model response degrades gracefully instead of losing foods
      for (const c of clusters) {
        if (claimedKeys.has(c.key)) continue;
        groups.push({ desc: c.key.slice(0, 40), cal: c.lastCal, memberKeys: [c.key] });
      }

      res.status(200).json({ groups });
    } catch (e) {
      logger.error('cleanupFoodSuggestions failed', e);
      res.status(502).json({ error: 'Cleanup failed — could not reach the AI service.' });
    }
  }
);
