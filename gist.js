// ============================================================
// gist.js — GitHub Gist read/write for Worm State Tracker
// ============================================================

const GIST_TOKEN_KEY = 'worm_tracker_gist_token';
const GIST_MAP_KEY   = 'worm_tracker_chat_gist_map';
const LAST_GIST_KEY  = 'worm_tracker_last_gist_id';  // global fallback — survives page refresh

// ── Token storage ────────────────────────────────────────────
export function getToken() {
  return localStorage.getItem(GIST_TOKEN_KEY) || '';
}

export function setToken(token) {
  localStorage.setItem(GIST_TOKEN_KEY, token.trim());
}

// ── Chat → Gist mapping ──────────────────────────────────────
export function getChatGistMap() {
  try {
    return JSON.parse(localStorage.getItem(GIST_MAP_KEY) || '{}');
  } catch { return {}; }
}

export function setGistForChat(chatId, gistId) {
  const map = getChatGistMap();
  map[chatId] = gistId;
  localStorage.setItem(GIST_MAP_KEY, JSON.stringify(map));
  // Always update global fallback so page refresh gets the last used ID
  localStorage.setItem(LAST_GIST_KEY, gistId);
}

export function getGistIdForChat(chatId) {
  const perChat = getChatGistMap()[chatId];
  if (perChat) return perChat;
  // Fall back to last globally used ID — covers refresh before chatId is known
  return localStorage.getItem(LAST_GIST_KEY) || null;
}

export function getLastGistId() {
  return localStorage.getItem(LAST_GIST_KEY) || null;
}

// ── Fetch all files from a Gist ──────────────────────────────
// Returns { 'filename.json': parsedData, ... }
export async function fetchGistFiles(gistId) {
  const token = getToken();
  if (!token) throw new Error('No GitHub token set. Enter your PAT in the tracker panel.');

  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gist fetch failed (${res.status}): ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const parsed = {};

  for (const [filename, fileObj] of Object.entries(data.files)) {
    // Large files may need separate raw fetch
    let content = fileObj.content;
    if (fileObj.truncated && fileObj.raw_url) {
      const raw = await fetch(fileObj.raw_url);
      content = await raw.text();
    }
    try {
      parsed[filename] = JSON.parse(content);
    } catch {
      parsed[filename] = content; // store as string if not JSON
    }
  }

  return parsed;
}

// ── Update files on a Gist (PATCH) ──────────────────────────
// filesObj format: { 'filename.json': { content: '...' }, ... }
export async function updateGistFiles(gistId, filesObj) {
  const token = getToken();
  if (!token) throw new Error('No GitHub token set.');

  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ files: filesObj })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gist update failed (${res.status}): ${body.slice(0, 200)}`);
  }

  return await res.json();
}

// ── Create a new Gist ────────────────────────────────────────
export async function createGist(description, filesObj) {
  const token = getToken();
  if (!token) throw new Error('No GitHub token set.');

  const res = await fetch('https://api.github.com/gists', {
    method: 'POST',
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      description,
      public: false,
      files: filesObj
    })
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Gist create failed (${res.status}): ${body.slice(0, 200)}`);
  }

  return await res.json();
}

// ── Scaffold a blank NPC file ────────────────────────────────
export function scaffoldNpcFile(displayName, alias, faction, firstArc) {
  const varKey = `%%NPC_${displayName.toUpperCase().replace(/\s+/g, '_')}%%`;
  return {
    display_name: displayName,
    alias: alias || '',
    faction: faction || 'Unknown',
    classification: '',
    first_appeared: firstArc || '',
    age: '',
    physical_description: '',
    power: {
      summary: '',
      mechanics: '',
      current_limitations: [],
      cannot_do: ''
    },
    trigger_event: { summary: '', visibility_gate: '', notes: '' },
    personality: '',
    history: '',
    knowledge: {
      specific_intel: [],
      visibility_gates: {}
    },
    current_state: {
      relationship_to_user_character: 'not yet met',
      emotional_state: '',
      physical_state: ''
    },
    lorebook_variable: varKey
  };
}

// ── Default file templates for fresh Gist creation ──────────
export function defaultIndex(chatId) {
  return {
    schema_version: '1.0',
    setting: 'Worm — Brockton Bay',
    chat_id: chatId || '',
    current_arc: '1',
    current_chapter: '1.1',
    in_world_date: '2010-09-03',
    divergence_rating: 0,
    divergence_threshold: 15,
    timeline_reliable: true,
    active_npcs: [],
    last_updated: new Date().toISOString(),
    notes: 'Divergence rating increments per confirmed butterfly. When rating hits threshold, timeline_reliable flips false and arc_events shifts to reference-only mode.'
  };
}

export function defaultWorldState() {
  return {
    in_world_date: '2010-09-03',
    arc: '1',
    chapter: '1.1',
    territorial_control: {},
    public_cape_knowledge: {},
    active_situations: [],
    divergence: { rating: 0, threshold: 15, timeline_reliable: true, logged: [] }
  };
}

export function defaultArcEvents() {
  return { arc_1: {} };
}
