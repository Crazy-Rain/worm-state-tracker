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
  Format: [{ "display_name": "", "alias": "", "faction": "", "first_appeared": "" }]

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
