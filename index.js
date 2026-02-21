import {
  getToken, setToken, getGistIdForChat, setGistForChat,
  fetchGistFiles, updateGistFiles, createGist, scaffoldNpcFile
} from './gist.js';

import {
  stripThinkingBlocks, mergeWithPreviousIfContinue,
  buildExtractionPrompt, runExtractionCall, parseDelta
} from './parser.js';

import {
  buildPanel, buildConfirmationModal, buildNpcAddModal
} from './ui.js';

const MODULE = '[WormTracker]';

// Local state cache — loaded from gist at chat start
let localState = {
  index: null,
  world_state: null,
  arc_events: null,
  timeline: null,
  npcs: {}
};

let currentGistId  = null;
let lastAiMessage  = '';
let isContinueMode = false;
let mergedBuffer   = '';

// ─────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────

jQuery(async () => {
  // Inject panel into ST Extensions settings drawer
  $('#extensions_settings').append(`
    <div class="inline-drawer">
      <div class="inline-drawer-toggle inline-drawer-header">
        <b>Worm State Tracker</b>
        <div class="inline-drawer-icon fa-solid fa-circle-chevron-down"></div>
      </div>
      <div class="inline-drawer-content">
        ${buildPanel()}
      </div>
    </div>
  `);

  bindPanelEvents();
  hookSillyTavernEvents();

  console.log(`${MODULE} Initialized.`);
});

// ─────────────────────────────────────────────
// ST EVENT HOOKS
// ─────────────────────────────────────────────

function hookSillyTavernEvents() {
  const { eventSource, event_types } = window.SillyTavern?.getContext() || {};
  if (!eventSource) {
    console.warn(`${MODULE} SillyTavern context unavailable.`);
    return;
  }

  eventSource.on(event_types.MESSAGE_RECEIVED, async (messageId) => {
    const context = window.SillyTavern.getContext();
    const messages = context.chat;
    const lastMsg  = messages[messages.length - 1];
    if (!lastMsg || lastMsg.is_user) return;

    const rawText = lastMsg.mes || '';

    // Detect Continue — empty user turn preceding this AI message
    const prevMsg = messages[messages.length - 2];
    isContinueMode = prevMsg && prevMsg.is_user && (!prevMsg.mes || prevMsg.mes.trim() === '');

    if (isContinueMode) {
      mergedBuffer = mergeWithPreviousIfContinue(rawText, mergedBuffer || lastAiMessage, true);
    } else {
      mergedBuffer   = rawText;
      lastAiMessage  = rawText;
    }

    if (!isContinueMode) {
      // Non-continue: run extraction immediately
      await runExtraction(mergedBuffer);
    }
    // Continue: wait — manual scan or next non-continue message triggers
  });

  eventSource.on(event_types.CHAT_CHANGED, async (chatId) => {
    await handleChatChange(chatId);
  });
}

// ─────────────────────────────────────────────
// CHAT CHANGE — LOAD GIST FOR THIS CHAT
// ─────────────────────────────────────────────

async function handleChatChange(chatId) {
  const gistId = getGistIdForChat(chatId);
  updateStatus(gistId ? `Gist linked: ${gistId}` : 'No gist linked for this chat.');

  if (!gistId) {
    currentGistId = null;
    return;
  }

  currentGistId = gistId;
  $('#worm-gist-id').val(gistId);

  try {
    const files = await fetchGistFiles(gistId);
    loadLocalState(files);
    refreshNpcList();
    updateStatusDisplays();
    console.log(`${MODULE} State loaded for chat ${chatId}`);
  } catch (err) {
    updateStatus(`Gist load error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────
// EXTRACTION PIPELINE
// ─────────────────────────────────────────────

async function runExtraction(rawText) {
  if (!currentGistId) return;

  const cleaned = stripThinkingBlocks(rawText);
  const prompt  = buildExtractionPrompt(cleaned, buildStateSummary());

  let rawDelta;
  try {
    rawDelta = await runExtractionCall(prompt);
  } catch (err) {
    console.warn(`${MODULE} Extraction call failed:`, err);
    updateStatus('Extraction failed — use manual scan.');
    return;
  }

  const delta = parseDelta(rawDelta);
  if (!delta || !Object.keys(delta).length) {
    console.log(`${MODULE} No state changes detected.`);
    return;
  }

  showConfirmationModal(delta);
}

// ─────────────────────────────────────────────
// CONFIRMATION MODAL
// ─────────────────────────────────────────────

function showConfirmationModal(delta) {
  const modalHtml = buildConfirmationModal(delta);
  if (!modalHtml) return;

  $('body').append(modalHtml);

  $('#worm-modal-approve').on('click', async () => {
    await applyDelta(delta);
    await pushToGist();
    $('#worm-modal-overlay').remove();
    updateStatus('State updated and pushed.');
  });

  $('#worm-modal-edit').on('click', () => {
    $('#worm-modal-overlay').remove();
    openJsonEditor(delta, async (editedDelta) => {
      await applyDelta(editedDelta);
      await pushToGist();
      updateStatus('Edited state pushed.');
    });
  });

  $('#worm-modal-reject').on('click', () => {
    $('#worm-modal-overlay').remove();
    updateStatus('State update rejected.');
  });
}

// ─────────────────────────────────────────────
// APPLY DELTA TO LOCAL STATE
// ─────────────────────────────────────────────

async function applyDelta(delta) {
  if (delta.npc_knowledge) {
    for (const [npcFile, changes] of Object.entries(delta.npc_knowledge)) {
      if (!localState.npcs[npcFile]) continue;
      for (const [field, val] of Object.entries(changes)) {
        setNestedField(localState.npcs[npcFile], field, val);
      }
    }
  }

  if (delta.npc_relationship) {
    for (const [npcFile, rel] of Object.entries(delta.npc_relationship)) {
      if (localState.npcs[npcFile]) {
        localState.npcs[npcFile].current_state.relationship_to_user_character = rel;
      }
    }
  }

  if (delta.npc_current_state) {
    for (const [npcFile, changes] of Object.entries(delta.npc_current_state)) {
      if (!localState.npcs[npcFile]) continue;
      Object.assign(localState.npcs[npcFile].current_state, changes);
    }
  }

  if (delta.arc_events) {
    for (const [evtId, status] of Object.entries(delta.arc_events)) {
      if (localState.arc_events) {
        for (const arcKey of Object.keys(localState.arc_events)) {
          if (localState.arc_events[arcKey][evtId] !== undefined) {
            localState.arc_events[arcKey][evtId] = status;
          }
        }
      }
    }
  }

  if (delta.new_npcs && delta.new_npcs.length) {
    for (const npcData of delta.new_npcs) {
      const fileKey = `npc_${npcData.display_name.toLowerCase().replace(/\s+/g, '_')}.json`;
      if (!localState.npcs[fileKey]) {
        localState.npcs[fileKey] = scaffoldNpcFile(
          npcData.display_name, npcData.alias,
          npcData.faction, npcData.first_appeared
        );
        localState.index?.active_npcs?.push(fileKey.replace('.json', ''));
      }
    }
    refreshNpcList();
  }

  if (delta.world_state) {
    Object.assign(localState.world_state, delta.world_state);
  }

  if (delta.divergence_delta && localState.index) {
    localState.index.divergence_rating = (localState.index.divergence_rating || 0) + delta.divergence_delta;
    if (localState.index.divergence_rating >= (localState.index.divergence_threshold || 15)) {
      localState.index.timeline_reliable = false;
    }
  }

  if (delta.in_world_date && localState.index) {
    localState.index.in_world_date = delta.in_world_date;
  }

  localState.index.last_updated = new Date().toISOString();
  updateStatusDisplays();
}

// ─────────────────────────────────────────────
// GIST PUSH / PULL
// ─────────────────────────────────────────────

async function pushToGist() {
  if (!currentGistId) return;
  const filesObj = buildGistPayload();
  try {
    await updateGistFiles(currentGistId, filesObj);
    updateStatus('Pushed to Gist ✓');
  } catch (err) {
    updateStatus(`Push failed: ${err.message}`);
  }
}

async function pullFromGist() {
  if (!currentGistId) return;
  try {
    const files = await fetchGistFiles(currentGistId);
    loadLocalState(files);
    refreshNpcList();
    updateStatusDisplays();
    updateStatus('Pulled from Gist ✓');
  } catch (err) {
    updateStatus(`Pull failed: ${err.message}`);
  }
}

// ─────────────────────────────────────────────
// PANEL EVENT BINDINGS
// ─────────────────────────────────────────────

function bindPanelEvents() {
  // Token
  $('#worm-save-token').on('click', () => {
    const token = $('#worm-gist-token').val().trim();
    if (token) { setToken(token); updateStatus('Token saved.'); }
  });

  // Link existing gist
  $('#worm-link-gist').on('click', async () => {
    const gistId = $('#worm-gist-id').val().trim();
    const chatId = window.SillyTavern?.getContext()?.chatId || 'default';
    if (!gistId) return;
    setGistForChat(chatId, gistId);
    currentGistId = gistId;
    await pullFromGist();
  });

  // Create new gist
  $('#worm-create-gist').on('click', async () => {
    const chatId = window.SillyTavern?.getContext()?.chatId || 'default';
    try {
      const newGist = await createGist('Worm State Tracker — ' + chatId, {
        '_index.json':     { content: JSON.stringify(defaultIndex(), null, 2) },
        'world_state.json':{ content: JSON.stringify(defaultWorldState(), null, 2) },
        'arc_events.json': { content: JSON.stringify(defaultArcEvents(), null, 2) }
      });
      currentGistId = newGist.id;
      setGistForChat(chatId, newGist.id);
      $('#worm-gist-id').val(newGist.id);
      await pullFromGist();
      updateStatus(`Gist created: ${newGist.id}`);
    } catch (err) {
      updateStatus(`Create failed: ${err.message}`);
    }
  });

  // Manual scan
  $('#worm-scan-last').on('click', async () => {
    const textToScan = mergedBuffer || lastAiMessage;
    if (!textToScan) { updateStatus('No response to scan.'); return; }
    updateStatus('Scanning...');
    await runExtraction(textToScan);
  });

  // Push / Pull
  $('#worm-push-gist').on('click', pushToGist);
  $('#worm-pull-gist').on('click', pullFromGist);

  // Add NPC
  $('#worm-add-npc').on('click', () => {
    $('body').append(buildNpcAddModal());
    $('#worm-npc-add-confirm').on('click', async () => {
      const name    = $('#worm-npc-name').val().trim();
      const alias   = $('#worm-npc-alias').val().trim();
      const faction = $('#worm-npc-faction').val().trim();
      const arc     = $('#worm-npc-arc').val().trim();
      if (!name) return;
      const fileKey = `npc_${name.toLowerCase().replace(/\s+/g, '_')}.json`;
      localState.npcs[fileKey] = scaffoldNpcFile(name, alias, faction, arc);
      localState.index?.active_npcs?.push(fileKey.replace('.json', ''));
      await pushToGist();
      refreshNpcList();
      $('#worm-modal-overlay').remove();
    });
    $('#worm-npc-add-cancel').on('click', () => $('#worm-modal-overlay').remove());
  });

  // Edit state JSON
  $('#worm-edit-state').on('click', () => {
    openJsonEditor(localState, async (edited) => {
      localState = edited;
      await pushToGist();
      updateStatus('Manual state edit pushed.');
    });
  });
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function loadLocalState(files) {
  localState.index       = files['_index.json'] || null;
  localState.world_state = files['world_state.json'] || null;
  localState.arc_events  = files['arc_events.json'] || null;
  localState.timeline    = files['timeline.json'] || null;
  localState.npcs        = {};
  for (const [filename, data] of Object.entries(files)) {
    if (filename.startsWith('npc_')) {
      localState.npcs[filename] = data;
    }
  }
}

function buildGistPayload() {
  const payload = {
    '_index.json':     { content: JSON.stringify(localState.index, null, 2) },
    'world_state.json':{ content: JSON.stringify(localState.world_state, null, 2) },
    'arc_events.json': { content: JSON.stringify(localState.arc_events, null, 2) }
  };
  for (const [filename, data] of Object.entries(localState.npcs)) {
    payload[filename] = { content: JSON.stringify(data, null, 2) };
  }
  return payload;
}

function buildStateSummary() {
  return {
    current_arc:       localState.index?.current_arc,
    in_world_date:     localState.index?.in_world_date,
    divergence_rating: localState.index?.divergence_rating,
    active_npcs:       Object.keys(localState.npcs),
    arc_events:        localState.arc_events,
    npc_knowledge_snapshot: Object.fromEntries(
      Object.entries(localState.npcs).map(([k, v]) => [k, v.knowledge])
    )
  };
}

function refreshNpcList() {
  const $list = $('#worm-npc-list').empty();
  for (const [filename, npc] of Object.entries(localState.npcs)) {
    $list.append(`<li>${npc.display_name}${npc.alias ? ` (${npc.alias})` : ''}</li>`);
  }
}

function updateStatus(msg) {
  $('#worm-status-text').text(msg);
}

function updateStatusDisplays() {
  if (localState.index) {
    $('#worm-arc-display').text(`Arc: ${localState.index.current_arc} | ${localState.index.in_world_date}`);
    $('#worm-divergence-display').text(
      `Divergence: ${localState.index.divergence_rating}${localState.index.timeline_reliable ? '' : ' ⚠️ Timeline unreliable'}`
    );
  }
}

function setNestedField(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]]) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

function openJsonEditor(data, onSave) {
  const html = `
    <div id="worm-modal-overlay" class="worm-modal-overlay">
      <div class="worm-modal worm-modal-large">
        <h4>Edit State JSON</h4>
        <textarea id="worm-json-editor">${JSON.stringify(data, null, 2)}</textarea>
        <div class="worm-modal-buttons">
          <button id="worm-json-save">✅ Save</button>
          <button id="worm-json-cancel">❌ Cancel</button>
        </div>
      </div>
    </div>
  `;
  $('body').append(html);
  $('#worm-json-save').on('click', () => {
    try {
      const edited = JSON.parse($('#worm-json-editor').val());
      onSave(edited);
      $('#worm-modal-overlay').remove();
    } catch { alert('Invalid JSON — check formatting.'); }
  });
  $('#worm-json-cancel').on('click', () => $('#worm-modal-overlay').remove());
}

// Default file templates for fresh gist creation
function defaultIndex() {
  return {
    schema_version: '1.0', setting: 'Worm — Brockton Bay',
    current_arc: '1', current_chapter: '1.1',
    in_world_date: '2010-09-03', divergence_rating: 0,
    divergence_threshold: 15, timeline_reliable: true,
    active_npcs: [], last_updated: new Date().toISOString()
  };
}
function defaultWorldState() {
  return { in_world_date: '2010-09-03', territorial_control: {}, public_cape_knowledge: {} };
}
function defaultArcEvents() {
  return { arc_1: {} };
}
