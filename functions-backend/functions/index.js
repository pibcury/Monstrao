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

const SYSTEM_PROMPT = `You estimate calories for a single food entry in a personal diet-tracking app.
You may be given a text description, a photo of the food, or both. Use whatever you're given to figure out the calorie count, then reply with ONLY a JSON object as your final message, no other text, no markdown fences, in exactly this shape:
{"label": "short food name, max 40 characters", "calories": 000}
"calories" must be your best-effort whole-number estimate of total calories for the portion described and/or shown.
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

      res.status(200).json({ label, calories });
    } catch (e) {
      logger.error('estimateCalories failed', e);
      res.status(502).json({ error: 'Calorie estimate failed — could not reach the AI service.' });
    }
  }
);
