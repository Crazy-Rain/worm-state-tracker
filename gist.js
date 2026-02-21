const GIST_TOKEN_KEY = 'worm_tracker_gist_token';
const GIST_MAP_KEY   = 'worm_tracker_chat_gist_map';

export function getToken() {
  return localStorage.getItem(GIST_TOKEN_KEY) || '';
}

export function setToken(token) {
  localStorage.setItem(GIST_TOKEN_KEY, token);
}

export function getChatGistMap() {
  try {
    return JSON.parse(localStorage.getItem(GIST_MAP_KEY) || '{}');
  } catch { return {}; }
}

export function setGistForChat(chatId, gistId) {
  const map = getChatGistMap();
  map[chatId] = gistId;
  localStorage.setItem(GIST_MAP_KEY, JSON.stringify(map));
}

export function getGistIdForChat(chatId) {
  return getChatGistMap()[chatId] || null;
}

export async function fetchGistFiles(gistId) {
  const token = getToken();
  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json'
    }
  });
  if (!res.ok) throw new Error(`Gist fetch failed: ${res.status}`);
  const data = await res.json();
  // Parse each file's content as JSON where possible
  const parsed = {};
  for (const [filename, fileObj] of Object.entries(data.files)) {
    try {
      parsed[filename] = JSON.parse(fileObj.content);
    } catch {
      parsed[filename] = fileObj.content;
    }
  }
  return parsed;
}

export async function updateGistFiles(gistId, filesObj) {
  // filesObj: { 'filename.json': { content: stringifiedJSON } }
  const token = getToken();
  const res = await fetch(`https://api.github.com/gists/${gistId}`, {
    method: 'PATCH',
    headers: {
      'Authorization': `token ${token}`,
      'Accept': 'application/vnd.github.v3+json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ files: filesObj })
  });
  if (!res.ok) throw new Error(`Gist update failed: ${res.status}`);
  return await res.json();
}

export async function createGist(description, filesObj) {
  const token = getToken();
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
  if (!res.ok) throw new Error(`Gist create failed: ${res.status}`);
  return await res.json();
}

export function scaffoldNpcFile(displayName, alias, faction, firstArc) {
  return {
    display_name: displayName,
    alias: alias || '',
    faction: faction || 'Unknown',
    classification: '',
    first_appeared: firstArc || '',
    power: {
      summary: '',
      mechanics: '',
      current_limitations: [],
      cannot_do: ''
    },
    trigger_event: { summary: '', visibility_gate: '', notes: '' },
    personality: '',
    history: '',
    knowledge: { specific_intel: [], visibility_gates: {} },
    current_state: {
      relationship_to_user_character: 'not yet met',
      emotional_state: '',
      physical_state: ''
    },
    lorebook_variable: `%%NPC_${displayName.toUpperCase().replace(/\s+/g, '_')}%%`
  };
}
