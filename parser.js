// Strip thinking/reasoning blocks before extraction
export function stripThinkingBlocks(text) {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .replace(/<council[\s\S]*?<\/council>/gi, '')
    .trim();
}

// Merge continued responses before extraction
export function mergeWithPreviousIfContinue(currentText, previousText, isContinue) {
  if (!isContinue || !previousText) return currentText;
  return previousText.trim() + ' ' + currentText.trim();
}

// Build the extraction prompt
export function buildExtractionPrompt(responseText, currentState) {
  return `You are a state extraction assistant. Read the following narrative response and compare it against the current tracked state. Identify ONLY concrete, confirmed changes — things that definitively happened in the text, not inferences or possibilities.

Return a JSON delta object only. If nothing changed return {}.

Categories to check:
- npc_knowledge: Did any NPC learn something new? Format: { "npc_filename": { "knowledge.field": newValue } }
- npc_relationship: Did any NPC's relationship to the user character shift?
- npc_current_state: Physical/emotional state changes for any NPC
- arc_events: Did any tracked canon event fire, get altered, or get skipped? Format: { "event_id": "fired-canon" | "fired-altered" | "skipped" }
- new_npcs: Were any new named characters introduced who don't exist in the tracker? Format: [{ "display_name": "", "alias": "", "faction": "", "first_appeared": "" }]
- world_state: Any city-level changes (territorial shifts, public cape knowledge updates)?
- divergence_delta: Integer — how many new butterfly effects are confirmed in this response? 0 if none.
- in_world_date: New date if time has advanced, otherwise null.

CURRENT STATE SUMMARY:
${JSON.stringify(currentState, null, 2)}

NARRATIVE RESPONSE TO ANALYZE:
${responseText}

Return JSON only. No explanation. No markdown fences.`;
}

// Call SillyTavern's existing API connection for extraction
export async function runExtractionCall(prompt) {
  // Uses ST's generateQuietPrompt if available — no separate API key needed
  if (typeof window.generateQuietPrompt === 'function') {
    const result = await window.generateQuietPrompt([
      { role: 'user', content: prompt }
    ]);
    return result;
  }
  throw new Error('generateQuietPrompt not available — ST API hook missing');
}

export function parseDelta(rawText) {
  try {
    const cleaned = rawText
      .replace(/```json/gi, '')
      .replace(/```/g, '')
      .trim();
    return JSON.parse(cleaned);
  } catch {
    console.warn('[WormTracker] Delta parse failed:', rawText);
    return null;
  }
}
