// ============================================================
// parser.js — Response parsing & extraction for Worm Tracker
// ============================================================

// ── Strip internal reasoning blocks ─────────────────────────
// Removes <think>, <thinking>, <thought>, <council...> etc.
// MUST run before any text reaches the extraction prompt.
// Prevents Lumia Council deliberation from being logged as world state.
export function stripThinkingBlocks(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<council[\s\S]*?<\/council>/gi, '')
    .replace(/<lumiaooc>[\s\S]*?<\/lumiaooc>/gi, '')
    .replace(/```forge[\s\S]*?```/gi, '')  // strip forge blocks too — handled separately
    .trim();
}

// ── Continue detection & merging ─────────────────────────────
// When user hits Continue, ST fires with an empty/null user turn.
// Buffer continued output and merge with prior AI message before extraction.
export function mergeWithPreviousIfContinue(currentText, previousText, isContinue) {
  if (!isContinue || !previousText) return currentText;
  return previousText.trim() + ' ' + currentText.trim();
}

// ── Build the extraction prompt ──────────────────────────────
// Sends cleaned response text + current state to the AI for delta extraction.
export function buildExtractionPrompt(responseText, currentState) {
  return `You are a state extraction assistant for a Worm (webserial) roleplay session. Read the narrative response below and compare it against the current tracked state. Identify ONLY concrete, confirmed changes — things that definitively happened in the text, not inferences or possibilities.

Return a single JSON object only. If nothing changed, return {}.

Categories to check:

npc_knowledge: Did any NPC learn something new?
  Format: { "npc_filename.json": { "knowledge.field": newValue } }

npc_relationship: Did any NPC's relationship to the user character visibly shift?
  Format: { "npc_filename.json": "new relationship description" }

npc_current_state: Physical or emotional state changes for any NPC.
  Format: { "npc_filename.json": { "emotional_state": "...", "physical_state": "..." } }

arc_events: Did any tracked canon event fire, get altered, or get skipped?
  Format: { "event_id": "fired-canon" | "fired-altered" | "skipped" }

new_npcs: Were any new named characters introduced not yet in the tracker?
  Format: [{ "display_name": "", "alias": "", "aliases": [], "faction": "", "first_appeared": "" }]

npc_appearance: Did the narrative visually describe any NPC's physical appearance in a way that reveals or confirms concrete details?
  Only propose if the narrative contains specific visual description (hair, eyes, height, build, clothing, face, marks).
  Do NOT propose for vague references. Only concrete details actually described or confirmed in this response.
  Format: { "npc_filename.json": { "hair": "...", "eyes": "...", "height": "...", "build": "...", "face": "...", "clothing_style": "...", "distinguishing_marks": "..." } }
  Include ONLY fields actually described. Omit null/unknown fields entirely.

npc_aliases: Did any NPC reveal, adopt, or lose a name or alias in this response?
  This includes: taking a new cape name, civilian name revealed, old villain name referenced, going by a different identity.
  Format: { "npc_filename.json": { "alias": "primary cape name", "aliases": ["all known names including old ones"] } }
  Only include if there's a concrete in-scene reason (e.g. Taylor publicly becomes Weaver, Armsmaster is called Defiant for the first time, an NPC's real name is revealed).

world_state: Any city-level changes (territorial shifts, public cape knowledge updates, new active situations)?
  Format: { "field_name": newValue }

divergence_delta: Integer — how many new butterfly effects were confirmed in this response? 0 if none.

in_world_date: New date string if time has advanced in-scene, otherwise null.

CURRENT STATE SUMMARY:
${JSON.stringify(currentState, null, 2)}

NARRATIVE RESPONSE TO ANALYZE:
${responseText}

Return JSON only. No explanation. No markdown fences. No prose.`;
}

// ── Run extraction via ST's existing API connection ──────────
// Uses generateQuietPrompt — no separate API key required.
export async function runExtractionCall(prompt) {
  // Try ST's context-based quiet prompt first
  const ctx = window.SillyTavern?.getContext?.();

  if (ctx && typeof ctx.generateQuietPrompt === 'function') {
    return await ctx.generateQuietPrompt(prompt, false, true);
  }

  // Fallback: check global
  if (typeof window.generateQuietPrompt === 'function') {
    return await window.generateQuietPrompt(prompt, false, true);
  }

  throw new Error('generateQuietPrompt not available — check SillyTavern version compatibility.');
}


// ── Extract forge block from raw message text ────────────────
// The narrator AI already outputs ```forge {...} ``` blocks — parse these
// directly instead of re-sending the response through the LLM.
// NOTE: run this on RAW text BEFORE stripThinkingBlocks (which deletes forge blocks).
export function extractForgeBlock(rawText) {
  if (!rawText) return null;
  const match = rawText.match(/```forge\s*([\s\S]*?)```/i);
  if (!match) return null;
  try {
    return JSON.parse(match[1].trim());
  } catch (e) {
    console.warn('[WormTracker] forge block parse failed:', e.message, '| raw:', match[1].slice(0, 200));
    return null;
  }
}

// ── Normalise a forge block → internal delta format ──────────
// The card's forge format (npc_state_change, arc_event, world_state…)
// differs from what proposeDelta expects (npc_current_state, arc_events…).
// This translates between them, using gistFiles for filename lookups.
export function normalizeForgeBlock(forgeObj, gistFiles = {}) {
  if (!forgeObj || typeof forgeObj !== 'object') return null;
  const delta = {};

  // ── divergence_delta ──────────────────────────────────────
  if (forgeObj.divergence_delta > 0) {
    delta.divergence_delta = Number(forgeObj.divergence_delta) || 0;
  }

  // ── in_world_date (top-level or inside world_state) ───────
  const newDate = forgeObj.in_world_date
    ?? forgeObj.world_state?.in_world_date
    ?? null;
  if (newDate && typeof newDate === 'string') delta.in_world_date = newDate;

  // ── world_state fields (pass through, exclude in_world_date already handled) ──
  if (forgeObj.world_state && typeof forgeObj.world_state === 'object') {
    const ws = { ...forgeObj.world_state };
    delete ws.in_world_date;
    if (Object.keys(ws).length) delta.world_state = ws;
  }

  // ── arc_event (string or object) ─────────────────────────
  // Card format: "arc_event": "Taylor met the Undersiders"
  // Internal format: "arc_events": { "event_id": "fired-canon" }
  if (forgeObj.arc_event && forgeObj.arc_event !== 'null') {
    const eventKey = typeof forgeObj.arc_event === 'string'
      ? forgeObj.arc_event.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)
      : 'event_' + Date.now();
    delta.arc_events = { [eventKey]: 'fired-canon' };
  }

  // ── npc_updates — NEW expanded format [{name, relationship, emotional_state, physical_state, learned}]
  // Also handles legacy npc_state_change: {name, change} from old card format
  const updates = [];
  if (Array.isArray(forgeObj.npc_updates)) {
    updates.push(...forgeObj.npc_updates);
  }
  // Legacy: npc_state_change (single object or array)
  const legacyChanges = Array.isArray(forgeObj.npc_state_change)
    ? forgeObj.npc_state_change
    : (forgeObj.npc_state_change ? [forgeObj.npc_state_change] : []);
  for (const lc of legacyChanges) {
    if (lc?.name) updates.push({ name: lc.name, emotional_state: lc.change || lc.state || '' });
  }

  for (const upd of updates) {
    if (!upd?.name) continue;
    const filename = resolveNpcFilename(upd.name, gistFiles);
    if (!filename) continue;

    // relationship field
    if (upd.relationship) {
      delta.npc_relationship = delta.npc_relationship || {};
      delta.npc_relationship[filename] = upd.relationship;
    }

    // emotional_state and/or physical_state → npc_current_state
    if (upd.emotional_state || upd.physical_state) {
      delta.npc_current_state = delta.npc_current_state || {};
      delta.npc_current_state[filename] = delta.npc_current_state[filename] || {};
      if (upd.emotional_state) delta.npc_current_state[filename].emotional_state = upd.emotional_state;
      if (upd.physical_state)  delta.npc_current_state[filename].physical_state  = upd.physical_state;
    }

    // learned → npc_knowledge
    if (upd.learned) {
      delta.npc_knowledge = delta.npc_knowledge || {};
      delta.npc_knowledge[filename] = delta.npc_knowledge[filename] || {};
      // Key by timestamp slug so multiple learns don't overwrite each other
      const key = 'learned_' + Date.now();
      delta.npc_knowledge[filename][key] = upd.learned;
    }
  }

  // ── npc_knowledge (pass through if already in correct format) ─
  if (forgeObj.npc_knowledge) {
    delta.npc_knowledge = delta.npc_knowledge || {};
    Object.assign(delta.npc_knowledge, forgeObj.npc_knowledge);
  }

  // ── npc_relationship (direct key, if present alongside npc_updates) ─
  if (forgeObj.npc_relationship) {
    delta.npc_relationship = delta.npc_relationship || {};
    Object.assign(delta.npc_relationship, forgeObj.npc_relationship);
  }

  // ── new_npcs ─────────────────────────────────────────────
  if (Array.isArray(forgeObj.new_npcs)) delta.new_npcs = forgeObj.new_npcs;

  return delta;
}

// ── Resolve NPC name → Gist filename ─────────────────────────
// Fuzzy-matches a display name, alias, or cape name to an npc_*.json key.
function resolveNpcFilename(name, gistFiles) {
  if (!name || typeof name !== 'string') return null;
  const n = name.toLowerCase().trim();

  // Exact filename match
  const exactKey = 'npc_' + n.replace(/\s+/g, '_') + '.json';
  if (gistFiles[exactKey]) return exactKey;

  // Match against display_name, alias, or any entry in aliases[]
  for (const [filename, file] of Object.entries(gistFiles)) {
    if (!filename.startsWith('npc_')) continue;
    if (!file || typeof file !== 'object') continue;
    const candidates = [
      file.display_name,
      file.alias,
      ...(Array.isArray(file.aliases) ? file.aliases : [])
    ].filter(Boolean).map(s => s.toLowerCase());
    if (candidates.some(c => c.includes(n) || n.includes(c))) return filename;
  }
  return null;
}

// ── Parse the delta response ─────────────────────────────────
export function parseDelta(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;
  try {
    const cleaned = rawText
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();
    const parsed = JSON.parse(cleaned);
    // Validate it's an object
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    console.warn('[WormTracker] Delta parse failed on:', rawText.slice(0, 200));
    return null;
  }
}

// ── Check if delta has any actual content ────────────────────
export function deltaIsEmpty(delta) {
  if (!delta) return true;
  return Object.keys(delta).every(k => {
    const v = delta[k];
    if (v === null || v === 0 || v === '' || v === undefined) return true;
    if (Array.isArray(v) && v.length === 0) return true;
    if (typeof v === 'object' && Object.keys(v).length === 0) return true;
    return false;
  });
}
