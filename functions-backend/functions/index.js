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
Given a free-text description (what the food was, how it was prepared, portion size, etc.), reply with ONLY a JSON object, no other text, no markdown fences, in exactly this shape:
{"label": "short food name, max 40 characters", "calories": 000}
"calories" must be your best-effort whole-number estimate of total calories for the described portion.
"label" must be a short, human-readable name for the item (not the whole description) suitable as a food-log entry title.
If the description is vague, still return your best single-number estimate rather than refusing or asking a follow-up question.`;

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

    // ---- 2. validate input ----
    const description = (req.body && typeof req.body.description === 'string') ? req.body.description.trim() : '';
    if (!description) {
      res.status(400).json({ error: 'Describe the food first.' });
      return;
    }
    if (description.length > 1000) {
      res.status(400).json({ error: 'That description is too long — try trimming it.' });
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
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': anthropicApiKey.value(),
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json'
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 300,
          thinking: { type: 'disabled' },
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: description }]
        })
      });

      if (!resp.ok) {
        const errText = await resp.text();
        logger.error('Claude API error', resp.status, errText);
        res.status(502).json({ error: 'Calorie estimate failed — the AI service returned an error.' });
        return;
      }

      const data = await resp.json();
      const block = (data.content || []).find((b) => b.type === 'text');
      const raw = block ? block.text.trim() : '';

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
