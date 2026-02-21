// ============================================================
// index.js — Worm State Tracker v0.4.0
// ============================================================
// Mobile-first. Full Gist-backed NPC injection. Approve/deny
// queue for both extracted changes AND file imports.
// ============================================================

import { getContext } from '../../../extensions.js';
import {
  getToken, setToken, setGistForChat, getGistIdForChat,
  fetchGistFiles, updateGistFiles, createGist,
  scaffoldNpcFile, defaultIndex, defaultWorldState, defaultArcEvents
} from './gist.js';
import {
  stripThinkingBlocks, buildExtractionPrompt,
  runExtractionCall, parseDelta, deltaIsEmpty
} from './parser.js';

// ── Constants ─────────────────────────────────────────────────
const MODULE        = 'worm_tracker';
const PANEL_ID      = 'worm_tracker_panel';
const STORE_PREFIX  = 'worm_tracker_';
const MAX_NPCS      = 8;
const SCAN_DEPTH    = 3;
const PUSH_DELAY_MS = 8000;

// ── Session state ─────────────────────────────────────────────
let currentChatId   = null;
let gistId          = null;
let gistFiles       = {};
let pendingQueue    = [];     // { id, type, ... description, applyFn, expanded? }
let lastMessageText = '';
let isExtracting    = false;
let syncTimer       = null;

// ── Accessors ─────────────────────────────────────────────────
const worldState  = () => gistFiles['world_state.json']   || {};
const masterIndex = () => gistFiles['_master_index.json']  || {};
const arcEvents   = () => gistFiles['arc_events.json']    || {};
const allNpcFiles = () =>
  Object.entries(gistFiles)
    .filter(([k]) => k.startsWith('npc_') && k.endsWith('.json'))
    .map(([, v]) => v)
    .filter(Boolean);

// ═══════════════════════════════════════════════════════════════
// 1. RENDERING — Gist JSON → prompt-ready text
// ═══════════════════════════════════════════════════════════════

function renderWorldState() {
  const ws  = worldState();
  const div = ws.divergence || {};
  if (!ws.in_world_date && !ws.arc) return '';

  const lines = [
    '=== WORLD STATE ===',
    `Date: ${ws.in_world_date || '?'}  |  Arc ${ws.arc || '?'}${ws.chapter ? ' ch.' + ws.chapter : ''}`
  ];

  if (div.rating !== undefined) {
    const warn = !div.timeline_reliable
      ? '  ⚠ TIMELINE UNRELIABLE — arc events reference only' : '';
    lines.push(`Divergence: ${div.rating}/${div.threshold || 15}${warn}`);
  }

  if (ws.active_situations?.length) {
    lines.push('', 'Active situations:');
    for (const s of ws.active_situations) {
      lines.push(`  • ${typeof s === 'string' ? s : JSON.stringify(s)}`);
    }
  }

  const factions = ws.faction_status || ws.territorial_control || {};
  if (Object.keys(factions).length) {
    lines.push('', 'Faction status:');
    for (const [name, status] of Object.entries(factions)) {
      lines.push(`  ${name}: ${typeof status === 'object'
        ? (status.status || JSON.stringify(status)) : status}`);
    }
  }

  if (ws.known_secrets) {
    const truths = Object.entries(ws.known_secrets)
      .filter(([, v]) => v === true || (typeof v === 'string' && v.toLowerCase().includes('know')));
    if (truths.length) {
      lines.push('', 'PC currently knows:');
      truths.forEach(([k]) => lines.push(`  • ${k.replace(/_/g, ' ')}`));
    }
  }

  return lines.join('\n');
}

function renderArcEvents() {
  const ae  = arcEvents();
  const ws  = worldState();
  const arc = ws.arc || '1';
  const arcData = ae[`arc_${arc}`];
  if (!arcData) return '';

  const fired = Object.entries(arcData)
    .filter(([, ev]) => ev.player_status && ev.player_status !== 'pending')
    .map(([id, ev]) =>
      `  [${ev.player_status.toUpperCase()}] ${id.replace(/_/g, ' ')} — ${ev.summary || ''}`
    );

  return fired.length
    ? `=== ARC ${arc} EVENTS (FIRED) ===\n${fired.join('\n')}`
    : '';
}

function renderNpcToText(npc) {
  if (!npc?.display_name) return null;

  const alias = npc.alias ? ` "${npc.alias}"` : '';
  const lines = [
    `[NPC: ${npc.display_name.toUpperCase()}${alias} | ${npc.faction || 'Unknown'} | ${npc.classification || ''}]`
  ];

  if (npc.physical_description) lines.push(`Physical: ${npc.physical_description}`);

  if (npc.power) {
    const p = npc.power;
    if (p.summary) lines.push(`Power: ${p.summary}`);
    if (p.current_limitations?.length)
      lines.push(`  Limitations: ${p.current_limitations.join('; ')}`);
    if (p.vulnerabilities?.length) {
      const v = Array.isArray(p.vulnerabilities) ? p.vulnerabilities : [p.vulnerabilities];
      lines.push(`  Vulnerabilities: ${v.join('; ')}`);
    }
    if (p.cannot_do) lines.push(`  Cannot: ${p.cannot_do}`);
  }

  if (npc.personality) lines.push(`Personality: ${npc.personality}`);

  const cs = npc.current_state || {};
  lines.push('Current:');
  if (cs.relationship_to_user_character)
    lines.push(`  → Relationship to PC: ${cs.relationship_to_user_character}`);
  if (cs.emotional_state) lines.push(`  → Emotional: ${cs.emotional_state}`);
  if (cs.physical_state)  lines.push(`  → Physical: ${cs.physical_state}`);

  const know = npc.knowledge || {};
  const intel = (know.specific_intel || []).filter(Boolean);
  const gates = know.visibility_gates || {};
  const hidden = Object.entries(gates).filter(([, v]) => v === false || v === 'hidden');

  if (intel.length || hidden.length) {
    lines.push('Knowledge:');
    intel.forEach(i => lines.push(`  [KNOWS] ${typeof i === 'string' ? i : i.fact}`));
    hidden.forEach(([k]) => lines.push(`  [DOES NOT KNOW] ${k.replace(/_/g, ' ')}`));
  }

  if (npc.critical_note) lines.push(`!! CRITICAL: ${npc.critical_note}`);

  return lines.join('\n');
}

// ═══════════════════════════════════════════════════════════════
// 2. SMART NPC SELECTION
// ═══════════════════════════════════════════════════════════════

function getRecentMessageText() {
  const ctx = getContext();
  if (!ctx?.chat?.length) return '';
  return ctx.chat.slice(-SCAN_DEPTH).map(m => m.mes || '').join(' ').toLowerCase();
}

function scoreNpc(npc, recentText) {
  let score = 0;
  const names = [npc.display_name, npc.alias, ...(npc.aliases || [])].filter(Boolean);

  for (const name of names) {
    if (recentText.includes(name.toLowerCase()))          { score += 10; break; }
    const first = name.split(/\s+/)[0].toLowerCase();
    if (first.length > 3 && recentText.includes(first))  { score += 7;  break; }
  }

  const phys = (npc.current_state?.physical_state || '').toLowerCase();
  if (/present|scene|with pc|same room/.test(phys)) score += 8;

  const rel = (npc.current_state?.relationship_to_user_character || '').toLowerCase();
  if (/hostile|enemy|threat/.test(rel))   score += 5;
  if (/trusted|loyal|ally/.test(rel))     score += 4;
  if (/romantic|love|crush/.test(rel))    score += 6;

  if ((npc.knowledge?.specific_intel || []).length > 0) score += 1;

  return score;
}

function selectRelevantNpcs() {
  const recentText = getRecentMessageText();
  const npcs       = allNpcFiles();

  return npcs
    .map(npc => ({ npc, score: scoreNpc(npc, recentText) }))
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_NPCS)
    .map(x => x.npc);
}

// ═══════════════════════════════════════════════════════════════
// 3. PROMPT INJECTION
// ═══════════════════════════════════════════════════════════════

function injectWorldState() {
  const ctx = getContext();
  if (!ctx?.setExtensionPrompt) return;
  const wsText  = renderWorldState();
  const arcText = renderArcEvents();
  const combined = [wsText, arcText].filter(Boolean).join('\n\n');
  ctx.setExtensionPrompt(`${MODULE}_world`, combined, 1, 0, false, null);
}

function injectNpcs() {
  const ctx = getContext();
  if (!ctx?.setExtensionPrompt) return;
  const selected = selectRelevantNpcs();
  if (!selected.length) {
    ctx.setExtensionPrompt(`${MODULE}_npcs`, '', 1, 0, false, null);
    return;
  }
  const rendered = selected.map(renderNpcToText).filter(Boolean).join('\n\n');
  const block    = `=== ACTIVE NPCs (${selected.length}) ===\n${rendered}`;
  ctx.setExtensionPrompt(`${MODULE}_npcs`, block, 1, 0, false, null);
}

function rebuildContextInjection() {
  injectWorldState();
  injectNpcs();
}

// ═══════════════════════════════════════════════════════════════
// 4. GIST SYNC
// ═══════════════════════════════════════════════════════════════

function persistLocal() {
  if (!currentChatId) return;
  try {
    localStorage.setItem(
      `${STORE_PREFIX}state_${currentChatId}`,
      JSON.stringify({ gistId, gistFiles, timestamp: Date.now() })
    );
  } catch (e) { console.warn('[WormTracker] Local persist failed:', e); }
}

function loadLocal() {
  if (!currentChatId) return false;
  try {
    const raw = localStorage.getItem(`${STORE_PREFIX}state_${currentChatId}`);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (Date.now() - data.timestamp > 86_400_000) return false;
    gistId    = data.gistId;
    gistFiles = data.gistFiles;
    return true;
  } catch { return false; }
}

async function syncFromGist() {
  if (!gistId) { updateStatus('no Gist ID — enter one in the panel'); return; }
  try {
    updateStatus('fetching from Gist…');
    gistFiles = await fetchGistFiles(gistId);
    persistLocal();
    rebuildContextInjection();
    updateStatus('synced ✓');
    updatePanelSummary();
  } catch (err) {
    console.error('[WormTracker] Gist fetch error:', err);
    updateStatus(`sync failed: ${err.message}`);
  }
}

function schedulePushToGist() {
  if (syncTimer) clearTimeout(syncTimer);
  syncTimer = setTimeout(pushToGist, PUSH_DELAY_MS);
}

async function pushToGist() {
  if (!gistId) return;
  try {
    updateStatus('saving to Gist…');
    const filesObj = {};
    for (const [name, data] of Object.entries(gistFiles)) {
      filesObj[name] = { content: JSON.stringify(data, null, 2) };
    }
    await updateGistFiles(gistId, filesObj);
    updateStatus('saved ✓');
  } catch (err) {
    console.error('[WormTracker] Push error:', err);
    updateStatus(`save failed: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════════
// 5. EXTRACTION PIPELINE
// ═══════════════════════════════════════════════════════════════

async function onMessageReceived() {
  const ctx = getContext();
  const messages = ctx?.chat;
  if (!messages?.length) return;
  const lastMsg = messages[messages.length - 1];
  if (!lastMsg || lastMsg.is_user) return;

  const rawText   = lastMsg.mes || '';
  const cleanText = stripThinkingBlocks(rawText);
  if (cleanText === lastMessageText || !cleanText) return;
  lastMessageText = cleanText;
  if (!gistFiles['world_state.json'] || isExtracting) return;

  rebuildContextInjection();

  isExtracting = true;
  updateStatus('extracting changes…');
  try {
    const prompt = buildExtractionPrompt(cleanText, {
      world_state:  worldState(),
      master_index: masterIndex(),
      arc_events:   arcEvents(),
      active_npcs:  allNpcFiles().map(n => ({
        file:          Object.entries(gistFiles).find(([, v]) => v === n)?.[0],
        display_name:  n.display_name,
        alias:         n.alias,
        current_state: n.current_state,
        knowledge:     n.knowledge
      }))
    });
    const raw   = await runExtractionCall(prompt);
    const delta = parseDelta(raw);
    if (!deltaIsEmpty(delta)) proposeDelta(delta);
    else updateStatus('idle ✓');
  } catch (err) {
    console.error('[WormTracker] Extraction error:', err);
    updateStatus(`extraction error: ${err.message}`);
  } finally {
    isExtracting = false;
  }
}

// ═══════════════════════════════════════════════════════════════
// 6. APPROVE/DENY QUEUE — extracted deltas
// ═══════════════════════════════════════════════════════════════

function proposeDelta(delta) {
  const newItems = [];

  if (delta.npc_knowledge) {
    for (const [file, changes] of Object.entries(delta.npc_knowledge)) {
      const npc  = gistFiles[file];
      const name = npc?.display_name || file.replace(/npc_|\.json/g, '').replace(/_/g, ' ');
      for (const [field, newVal] of Object.entries(changes)) {
        const oldVal = deepGet(npc, field);
        newItems.push({
          id: uid(), type: 'npc_knowledge', npcFile: file,
          description: `${name}: knowledge — ${field.replace(/\./g, ' → ')} → ${JSON.stringify(newVal).slice(0, 80)}`,
          oldValue: oldVal, newValue: newVal,
          applyFn: () => { if (!gistFiles[file]) gistFiles[file] = {}; deepSet(gistFiles[file], field, newVal); }
        });
      }
    }
  }

  if (delta.npc_relationship) {
    for (const [file, rel] of Object.entries(delta.npc_relationship)) {
      const npc  = gistFiles[file];
      const name = npc?.display_name || file.replace(/npc_|\.json/g, '').replace(/_/g, ' ');
      const old  = npc?.current_state?.relationship_to_user_character;
      newItems.push({
        id: uid(), type: 'npc_relationship', npcFile: file,
        description: `${name}: relationship → ${rel}${old ? ` (was: ${old})` : ''}`,
        oldValue: old, newValue: rel,
        applyFn: () => {
          if (!gistFiles[file]) gistFiles[file] = {};
          gistFiles[file].current_state = gistFiles[file].current_state || {};
          gistFiles[file].current_state.relationship_to_user_character = rel;
        }
      });
    }
  }

  if (delta.npc_current_state) {
    for (const [file, state] of Object.entries(delta.npc_current_state)) {
      const npc  = gistFiles[file];
      const name = npc?.display_name || file.replace(/npc_|\.json/g, '').replace(/_/g, ' ');
      newItems.push({
        id: uid(), type: 'npc_state', npcFile: file,
        description: `${name}: state — ${Object.entries(state).map(([k,v]) => `${k}: ${v}`).join('; ')}`,
        oldValue: npc?.current_state, newValue: state,
        applyFn: () => {
          if (!gistFiles[file]) gistFiles[file] = {};
          gistFiles[file].current_state = Object.assign(gistFiles[file].current_state || {}, state);
        }
      });
    }
  }

  // NPC alias updates — cape name changes, identity reveals, new names adopted
  if (delta.npc_aliases) {
    for (const [file, aliasData] of Object.entries(delta.npc_aliases)) {
      const npc  = gistFiles[file];
      const name = npc?.display_name || file.replace(/npc_|\.json/g, '').replace(/_/g, ' ');
      const oldAlias   = npc?.alias;
      const oldAliases = npc?.aliases;
      const newAlias   = aliasData.alias;
      const newAliases = aliasData.aliases;

      const changes = [];
      if (newAlias && newAlias !== oldAlias)
        changes.push(`primary name: ${oldAlias || '?'} → ${newAlias}`);
      if (newAliases)
        changes.push(`known names: [${(oldAliases || []).join(', ')}] → [${newAliases.join(', ')}]`);

      if (!changes.length) continue;

      newItems.push({
        id: uid(), type: 'npc_aliases', npcFile: file,
        description: `${name}: alias update — ${changes.join('; ')}`,
        oldValue: { alias: oldAlias, aliases: oldAliases },
        newValue: aliasData,
        applyFn: () => {
          if (!gistFiles[file]) gistFiles[file] = {};
          if (newAlias)   gistFiles[file].alias   = newAlias;
          if (newAliases) gistFiles[file].aliases  = newAliases;
        }
      });
    }
  }

  if (delta.arc_events) {
    for (const [evId, status] of Object.entries(delta.arc_events)) {
      newItems.push({
        id: uid(), type: 'arc_event', npcFile: null,
        description: `Arc event: "${evId.replace(/_/g, ' ')}" → ${status}`,
        oldValue: null, newValue: status,
        applyFn: () => {
          const ae = gistFiles['arc_events.json'] || {};
          const arcKey = `arc_${worldState().arc || '1'}`;
          if (!ae[arcKey]) ae[arcKey] = {};
          if (ae[arcKey][evId]) ae[arcKey][evId].player_status = status;
          gistFiles['arc_events.json'] = ae;
        }
      });
    }
  }

  if (delta.world_state) {
    for (const [field, newVal] of Object.entries(delta.world_state)) {
      const old = worldState()[field];
      newItems.push({
        id: uid(), type: 'world_state', npcFile: null,
        description: `World state: ${field} → ${JSON.stringify(newVal).slice(0, 80)}`,
        oldValue: old, newValue: newVal,
        applyFn: () => {
          const ws = gistFiles['world_state.json'] || {};
          ws[field] = newVal;
          gistFiles['world_state.json'] = ws;
        }
      });
    }
  }

  if (delta.divergence_delta > 0) {
    const cur = worldState().divergence?.rating || 0;
    newItems.push({
      id: uid(), type: 'divergence', npcFile: null,
      description: `Divergence +${delta.divergence_delta} (${cur} → ${cur + delta.divergence_delta})`,
      oldValue: cur, newValue: cur + delta.divergence_delta,
      applyFn: () => {
        const ws = gistFiles['world_state.json'] || {};
        ws.divergence = ws.divergence || { rating: 0, threshold: 15, timeline_reliable: true, logged: [] };
        ws.divergence.rating += delta.divergence_delta;
        ws.divergence.logged.push({ timestamp: new Date().toISOString(), delta: delta.divergence_delta });
        if (ws.divergence.rating >= ws.divergence.threshold) ws.divergence.timeline_reliable = false;
        gistFiles['world_state.json'] = ws;
      }
    });
  }

  if (delta.in_world_date) {
    const old = worldState().in_world_date;
    newItems.push({
      id: uid(), type: 'date_advance', npcFile: null,
      description: `Date: ${old || '?'} → ${delta.in_world_date}`,
      oldValue: old, newValue: delta.in_world_date,
      applyFn: () => {
        const ws = gistFiles['world_state.json'] || {};
        ws.in_world_date = delta.in_world_date;
        gistFiles['world_state.json'] = ws;
      }
    });
  }

  if (delta.new_npcs?.length) {
    for (const spec of delta.new_npcs) {
      const filename = npcFilename(spec.display_name);
      if (gistFiles[filename]) continue;
      newItems.push({
        id: uid(), type: 'new_npc', npcFile: filename,
        description: `New NPC: ${spec.display_name}${spec.alias ? ` (${spec.alias})` : ''} — ${spec.faction || 'unknown faction'}`,
        oldValue: null, newValue: spec,
        applyFn: () => {
          gistFiles[filename] = scaffoldNpcFile(spec.display_name, spec.alias, spec.faction, spec.first_appeared);
        }
      });
    }
  }

  if (!newItems.length) { updateStatus('idle ✓'); return; }

  pendingQueue.push(...newItems);
  updateStatus(`${pendingQueue.length} change${pendingQueue.length !== 1 ? 's' : ''} pending review`);
  renderQueuePanel();
}

// ═══════════════════════════════════════════════════════════════
// 7. FILE IMPORT PIPELINE
// ═══════════════════════════════════════════════════════════════

// Detect what kind of Gist file a parsed JSON object is
function detectFileType(data) {
  if (!data || typeof data !== 'object') return 'unknown';
  if (data.display_name && data.power)                        return 'npc';
  if (data.active_situations || data.faction_status
      || (data.in_world_date && data.arc))                    return 'world_state';
  if (Object.keys(data).some(k => /^arc_\d+/.test(k)))        return 'arc_events';
  if (data.current_arc !== undefined && data.active_npcs)     return 'master_index';
  if (data.schema_version && data.setting)                    return 'master_index';
  return 'unknown';
}

// Determine target Gist filename for a parsed file
function targetFilename(data, originalFilename) {
  const type = detectFileType(data);
  if (type === 'npc')          return npcFilename(data.display_name);
  if (type === 'world_state')  return 'world_state.json';
  if (type === 'arc_events')   return 'arc_events.json';
  if (type === 'master_index') return '_master_index.json';
  // Fall back to original filename (stripped to basename)
  return originalFilename.split(/[/\\]/).pop();
}

// Build a human-readable preview string for the expand toggle
function buildPreviewText(data, type) {
  try {
    const lines = [];
    if (type === 'npc') {
      lines.push(`Name:           ${data.display_name}${data.alias ? ` / ${data.alias}` : ''}`);
      lines.push(`Faction:        ${data.faction || '—'}`);
      lines.push(`Classification: ${data.classification || '—'}`);
      if (data.age) lines.push(`Age:            ${data.age}`);
      if (data.power?.summary) lines.push(`Power:          ${data.power.summary}`);
      if (data.personality)    lines.push(`Personality:    ${data.personality.slice(0, 150)}${data.personality.length > 150 ? '…' : ''}`);
      if (data.critical_note)  lines.push(`!! CRITICAL:    ${data.critical_note}`);
      const cs = data.current_state || {};
      if (cs.relationship_to_user_character)
        lines.push(`Relationship:   ${cs.relationship_to_user_character}`);
      if (data.trigger_event?.summary)
        lines.push(`Trigger:        ${data.trigger_event.summary.slice(0, 120)}`);
    } else if (type === 'world_state') {
      lines.push(`Date:  ${data.in_world_date || '—'}`);
      lines.push(`Arc:   ${data.arc || '—'}${data.chapter ? ' ch.' + data.chapter : ''}`);
      if (data.divergence) {
        lines.push(`Div:   ${data.divergence.rating}/${data.divergence.threshold}`);
      }
      const sits = data.active_situations || [];
      if (sits.length) {
        lines.push(`Active situations (${sits.length}):`);
        sits.slice(0, 5).forEach(s =>
          lines.push(`  • ${typeof s === 'string' ? s.slice(0, 80) : JSON.stringify(s).slice(0, 80)}`));
      }
    } else if (type === 'arc_events') {
      const arcs = Object.keys(data).filter(k => /^arc_/.test(k));
      lines.push(`Arcs present: ${arcs.join(', ')}`);
      for (const arcKey of arcs) {
        const count = Object.keys(data[arcKey] || {}).length;
        lines.push(`  ${arcKey}: ${count} event${count !== 1 ? 's' : ''}`);
      }
    } else if (type === 'master_index') {
      if (data.setting)       lines.push(`Setting: ${data.setting}`);
      if (data.current_arc)   lines.push(`Arc:     ${data.current_arc}`);
      if (data.active_npcs)   lines.push(`Active NPCs: ${data.active_npcs.length}`);
    } else {
      // Unknown — just show top-level keys
      lines.push(JSON.stringify(data, null, 2).slice(0, 400));
    }
    return lines.join('\n');
  } catch {
    return '(preview unavailable)';
  }
}

// Read File objects selected by the file input and build import queue items
async function handleFileImport(fileList) {
  const files = Array.from(fileList);
  if (!files.length) return;

  updateStatus(`reading ${files.length} file${files.length !== 1 ? 's' : ''}…`);
  const newItems = [];

  for (const file of files) {
    try {
      const text  = await readFileAsText(file);
      const data  = JSON.parse(text);
      const type  = detectFileType(data);
      const fname = targetFilename(data, file.name);
      const icon  = TYPE_ICONS[type === 'npc' ? 'new_npc'
                              : type === 'world_state' ? 'world_state'
                              : type === 'arc_events' ? 'arc_event'
                              : 'import'] || '📂';

      // Describe what we found
      let desc = '';
      if (type === 'npc') {
        desc = `Import NPC: ${data.display_name}${data.alias ? ` / ${data.alias}` : ''} — ${data.faction || 'unknown faction'}`;
        if (gistFiles[fname]) desc += ' (⚠ will overwrite existing)';
      } else if (type === 'world_state') {
        desc = `Import world_state.json — Arc ${data.arc || '?'}, ${data.in_world_date || 'no date'}`;
        if (gistFiles[fname]) desc += ' (⚠ will overwrite)';
      } else if (type === 'arc_events') {
        const arcs = Object.keys(data).filter(k => /^arc_/.test(k));
        desc = `Import arc_events.json — ${arcs.length} arc${arcs.length !== 1 ? 's' : ''} (${arcs.join(', ')})`;
        if (gistFiles[fname]) desc += ' (⚠ will overwrite)';
      } else if (type === 'master_index') {
        desc = `Import _master_index.json — ${data.setting || 'no setting listed'}`;
        if (gistFiles[fname]) desc += ' (⚠ will overwrite)';
      } else {
        desc = `Import "${file.name}" → "${fname}" (type unknown — review before accepting)`;
      }

      newItems.push({
        id:          uid(),
        type:        'import',
        npcFile:     fname,
        description: desc,
        previewText: buildPreviewText(data, type),
        expanded:    false,
        oldValue:    gistFiles[fname] ? '[existing file]' : null,
        newValue:    data,
        applyFn: () => {
          gistFiles[fname] = data;
        }
      });

    } catch (err) {
      console.error(`[WormTracker] Failed to parse ${file.name}:`, err);
      updateStatus(`parse error in ${file.name}: ${err.message}`);
    }
  }

  if (!newItems.length) { updateStatus('no valid files found'); return; }

  pendingQueue.push(...newItems);
  updateStatus(`${newItems.length} file${newItems.length !== 1 ? 's' : ''} ready to review`);
  renderQueuePanel();
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = e => resolve(e.target.result);
    reader.onerror = () => reject(new Error('File read failed'));
    reader.readAsText(file, 'utf-8');
  });
}

// ═══════════════════════════════════════════════════════════════
// 8. QUEUE — accept / deny / accept-all / deny-all
// ═══════════════════════════════════════════════════════════════

function acceptChange(id) {
  const idx = pendingQueue.findIndex(item => item.id === id);
  if (idx === -1) return;
  pendingQueue[idx].applyFn();
  pendingQueue.splice(idx, 1);
  persistLocal();
  rebuildContextInjection();
  schedulePushToGist();
  updatePanelSummary();
  renderQueuePanel();
  if (!pendingQueue.length) updateStatus('all changes applied ✓');
}

function denyChange(id) {
  const idx = pendingQueue.findIndex(item => item.id === id);
  if (idx === -1) return;
  pendingQueue.splice(idx, 1);
  renderQueuePanel();
  if (!pendingQueue.length) updateStatus('idle ✓');
}

function acceptAll() {
  for (const item of [...pendingQueue]) item.applyFn();
  pendingQueue = [];
  persistLocal();
  rebuildContextInjection();
  schedulePushToGist();
  updatePanelSummary();
  renderQueuePanel();
  updateStatus('all changes applied ✓');
}

function denyAll() {
  pendingQueue = [];
  renderQueuePanel();
  updateStatus('all changes denied ✓');
}

function toggleExpand(id) {
  const item = pendingQueue.find(i => i.id === id);
  if (!item) return;
  item.expanded = !item.expanded;
  renderQueuePanel();
}

// ═══════════════════════════════════════════════════════════════
// 9. PANEL UI
// ═══════════════════════════════════════════════════════════════

const TYPE_ICONS = {
  npc_knowledge:   '🧠',
  npc_relationship:'🤝',
  npc_state:       '💭',
  npc_aliases:     '🏷️',
  arc_event:       '📖',
  world_state:     '🌆',
  divergence:      '⚡',
  date_advance:    '📅',
  new_npc:         '👤',
  import:          '📂',
  unknown:         '❓',
};

function buildPanel() {
  const panel = document.createElement('div');
  panel.id = PANEL_ID;
  panel.innerHTML = `
    <div class="inline-drawer">

      <div class="inline-drawer-toggle inline-drawer-header wt-header">
        <b>🕷 Worm State Tracker</b>
        <span id="wt_badge" class="wt-badge" style="display:none">0</span>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
      </div>

      <div class="inline-drawer-content" style="display:none;">

        <!-- PAT + Gist ID -->
        <div class="wt-section">
          <div class="wt-row">
            <label class="wt-label">GitHub PAT</label>
            <input id="wt_token" type="password" class="wt-input"
              placeholder="ghp_xxxxxxxxxxxx" value="${getToken()}">
          </div>
          <div class="wt-row">
            <label class="wt-label">Gist ID</label>
            <input id="wt_gist_id" type="text" class="wt-input"
              placeholder="a1b2c3d4e5f6…" value="${gistId || ''}">
          </div>
          <div class="wt-actions">
            <button id="wt_save"     class="menu_button wt-btn">Save</button>
            <button id="wt_sync"     class="menu_button wt-btn">↺ Sync</button>
            <button id="wt_new_gist" class="menu_button wt-btn">+ New Gist</button>
          </div>
        </div>

        <hr class="wt-divider">

        <!-- Import section -->
        <div class="wt-import-section">
          <div class="wt-actions">
            <button id="wt_import_btn" class="menu_button wt-btn wt-btn-neutral">
              📂 Import JSON files
            </button>
          </div>
          <p class="wt-import-hint">
            Select one or more NPC, world_state, or arc_events .json files.
            Each file will appear in the review queue below before being pushed to Gist.
          </p>
          <input id="wt_file_input" type="file" multiple accept=".json">
        </div>

        <hr class="wt-divider">

        <!-- Status + summary -->
        <div id="wt_status"  class="wt-status">idle</div>
        <div id="wt_summary" class="wt-summary"></div>

        <hr class="wt-divider">

        <!-- Approve/deny queue -->
        <div id="wt_queue_header" style="display:none;" class="wt-queue-header">
          <span id="wt_queue_count">0 pending</span>
          <div class="wt-queue-bulk">
            <button id="wt_accept_all" class="menu_button wt-btn wt-btn-accept">✓ All</button>
            <button id="wt_deny_all"   class="menu_button wt-btn wt-btn-deny">✗ All</button>
          </div>
        </div>
        <div id="wt_queue" class="wt-queue"></div>

      </div>
    </div>
  `;
  // Save config
  panel.querySelector('#wt_save').addEventListener('click', () => {
    const token  = panel.querySelector('#wt_token').value.trim();
    const newGid = panel.querySelector('#wt_gist_id').value.trim();
    if (token)  setToken(token);
    if (newGid && currentChatId) { gistId = newGid; setGistForChat(currentChatId, newGid); }
    updateStatus('config saved ✓');
  });

  // Sync
  panel.querySelector('#wt_sync').addEventListener('click', async () => {
    const id = panel.querySelector('#wt_gist_id').value.trim() || gistId;
    if (!id) { updateStatus('no Gist ID'); return; }
    gistId = id;
    if (currentChatId) setGistForChat(currentChatId, id);
    await syncFromGist();
  });

  // New Gist
  panel.querySelector('#wt_new_gist').addEventListener('click', async () => {
    try {
      updateStatus('creating Gist…');
      const result = await createGist(
        `Worm Tracker — ${new Date().toLocaleDateString()}`,
        {
          '_master_index.json': { content: JSON.stringify(defaultIndex(currentChatId), null, 2) },
          'world_state.json':   { content: JSON.stringify(defaultWorldState(), null, 2) },
          'arc_events.json':    { content: JSON.stringify(defaultArcEvents(), null, 2) }
        }
      );
      gistId = result.id;
      if (currentChatId) setGistForChat(currentChatId, gistId);
      panel.querySelector('#wt_gist_id').value = gistId;
      await syncFromGist();
    } catch (err) { updateStatus(`create failed: ${err.message}`); }
  });

  // Import button → trigger hidden file input
  panel.querySelector('#wt_import_btn').addEventListener('click', () => {
    panel.querySelector('#wt_file_input').click();
  });

  // File input change
  panel.querySelector('#wt_file_input').addEventListener('change', async (e) => {
    if (e.target.files?.length) {
      await handleFileImport(e.target.files);
      e.target.value = ''; // reset so re-selecting same file triggers change again
    }
  });

  // Bulk actions
  panel.querySelector('#wt_accept_all').addEventListener('click', acceptAll);
  panel.querySelector('#wt_deny_all').addEventListener('click', denyAll);

  $('#extensions_settings').append(panel);
}

function renderQueuePanel() {
  const queueEl  = document.getElementById('wt_queue');
  const headerEl = document.getElementById('wt_queue_header');
  const countEl  = document.getElementById('wt_queue_count');
  const badge    = document.getElementById('wt_badge');
  if (!queueEl) return;

  const count = pendingQueue.length;

  if (badge) {
    badge.textContent  = count;
    badge.style.display = count > 0 ? 'inline-block' : 'none';
  }

  if (!count) {
    queueEl.innerHTML = '';
    if (headerEl) headerEl.style.display = 'none';
    return;
  }

  if (headerEl) {
    headerEl.style.display = 'flex';
    if (countEl) countEl.textContent = `${count} pending`;
  }

  queueEl.innerHTML = pendingQueue.map(item => {
    const icon     = TYPE_ICONS[item.type] || '•';
    const oldSnip  = item.oldValue != null
      ? `<div class="wt-card-old">was: ${escapeHtml(JSON.stringify(item.oldValue).slice(0, 60))}</div>`
      : '';

    // Import card — stacked layout with expand/collapse preview
    if (item.type === 'import') {
      const previewClass = item.expanded ? 'wt-preview-block open' : 'wt-preview-block';
      const toggleLabel  = item.expanded ? '▲ Hide preview' : '▼ Show preview';
      return `
        <div class="wt-card wt-card--import" data-id="${item.id}">
          <div class="wt-import-top">
            <div class="wt-card-icon">${icon}</div>
            <div class="wt-card-body">
              <div class="wt-card-desc">${escapeHtml(item.description)}</div>
              ${oldSnip}
              <span class="wt-preview-toggle wt-toggle" data-id="${item.id}">${toggleLabel}</span>
            </div>
          </div>
          <pre class="${previewClass}">${escapeHtml(item.previewText || '')}</pre>
          <div class="wt-import-actions">
            <button class="menu_button wt-btn wt-btn-deny wt-deny"     data-id="${item.id}">✗ Discard</button>
            <button class="menu_button wt-btn wt-btn-accept wt-accept" data-id="${item.id}">✓ Add to Gist</button>
          </div>
        </div>`;
    }

    // Standard card
    return `
      <div class="wt-card" data-id="${item.id}">
        <div class="wt-card-icon">${icon}</div>
        <div class="wt-card-body">
          <div class="wt-card-desc">${escapeHtml(item.description)}</div>
          ${oldSnip}
        </div>
        <div class="wt-card-actions">
          <button class="menu_button wt-btn wt-btn-accept wt-accept" data-id="${item.id}">✓</button>
          <button class="menu_button wt-btn wt-btn-deny   wt-deny"   data-id="${item.id}">✗</button>
        </div>
      </div>`;
  }).join('');

  // Event delegation — one listener block for all card buttons
  queueEl.querySelectorAll('.wt-accept').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); acceptChange(e.currentTarget.dataset.id); })
  );
  queueEl.querySelectorAll('.wt-deny').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); denyChange(e.currentTarget.dataset.id); })
  );
  queueEl.querySelectorAll('.wt-toggle').forEach(btn =>
    btn.addEventListener('click', e => { e.stopPropagation(); toggleExpand(e.currentTarget.dataset.id); })
  );
}

function updateStatus(msg) {
  const el = document.getElementById('wt_status');
  if (el) el.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
}

function updatePanelSummary() {
  const el = document.getElementById('wt_summary');
  if (!el) return;
  const ws    = worldState();
  const div   = ws.divergence;
  const npcN  = allNpcFiles().length;
  const lines = [];

  if (ws.in_world_date) lines.push(`📅 ${ws.in_world_date}`);
  if (ws.arc) lines.push(`📖 Arc ${ws.arc}${ws.chapter ? ' ch.' + ws.chapter : ''}`);
  if (div) lines.push(`⚡ Divergence ${div.rating}/${div.threshold || 15}${!div.timeline_reliable ? ' ⚠' : ''}`);
  lines.push(`👤 ${npcN} NPC${npcN !== 1 ? 's' : ''} in Gist`);

  const selected = selectRelevantNpcs();
  if (selected.length) {
    lines.push(`🎯 Injecting: ${selected.map(n => n.alias || n.display_name).join(', ')}`);
  }

  el.innerHTML = lines.join('<br>');
}

// ═══════════════════════════════════════════════════════════════
// 10. UTILITY HELPERS
// ═══════════════════════════════════════════════════════════════

function uid() {
  return `${Date.now()}_${Math.random().toString(36).slice(2)}`;
}

function npcFilename(displayName) {
  return `npc_${displayName.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')}.json`;
}

function deepGet(obj, path) {
  if (!obj) return undefined;
  return path.split('.').reduce((acc, k) => acc?.[k], obj);
}

function deepSet(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ═══════════════════════════════════════════════════════════════
// 11. ST EVENT HOOKS + INIT
// ═══════════════════════════════════════════════════════════════

function registerEventHooks() {
  const ctx    = getContext();
  const events = ctx?.eventSource;
  if (!events) { console.warn('[WormTracker] No eventSource — hooks not registered'); return; }

  events.on('chat_changed', async (chatId) => {
    currentChatId   = chatId;
    gistFiles       = {};
    pendingQueue    = [];
    lastMessageText = '';
    renderQueuePanel();

    const storedId = getGistIdForChat(chatId);
    if (storedId) {
      gistId = storedId;
      const inp = document.getElementById('wt_gist_id');
      if (inp) inp.value = storedId;
    }

    if (loadLocal()) {
      rebuildContextInjection();
      updateStatus('loaded (cached)');
      updatePanelSummary();
    } else if (gistId) {
      await syncFromGist();
    } else {
      updateStatus('no Gist linked — enter ID in panel');
    }
  });

  events.on('message_received',   onMessageReceived);
  events.on('generation_ended',   rebuildContextInjection);
}

jQuery(async () => {
  console.log('[WormTracker] Loading v0.4.0…');
  buildPanel();
  registerEventHooks();

  const ctx = getContext();
  if (ctx?.chatId) {
    currentChatId = ctx.chatId;
    const storedId = getGistIdForChat(ctx.chatId);
    if (storedId) {
      gistId = storedId;
      const inp = document.getElementById('wt_gist_id');
      if (inp) inp.value = storedId;
    }
    if (loadLocal()) {
      rebuildContextInjection();
      updateStatus('loaded (cached)');
      updatePanelSummary();
    } else if (gistId) {
      await syncFromGist();
    }
  }

  console.log('[WormTracker] Ready.');
});
