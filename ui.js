export function buildPanel() {
  return `
    <div id="worm-tracker-panel" class="worm-tracker-panel">
      <h3>⚡ Worm State Tracker</h3>

      <div class="worm-tracker-section">
        <label>GitHub Token</label>
        <input type="password" id="worm-gist-token" placeholder="ghp_..." />
        <button id="worm-save-token">Save Token</button>
      </div>

      <div class="worm-tracker-section">
        <label>Gist ID (this chat)</label>
        <input type="text" id="worm-gist-id" placeholder="Gist ID or leave blank to create new" />
        <button id="worm-link-gist">Link Gist</button>
        <button id="worm-create-gist">Create New</button>
      </div>

      <div class="worm-tracker-section worm-tracker-status">
        <span id="worm-status-text">No gist linked.</span>
        <span id="worm-arc-display"></span>
        <span id="worm-divergence-display"></span>
      </div>

      <div class="worm-tracker-section worm-tracker-manual-buttons">
        <strong>Manual Controls</strong>
        <button id="worm-scan-last">🔍 Scan Last Response</button>
        <button id="worm-push-gist">⬆️ Push to Gist</button>
        <button id="worm-pull-gist">⬇️ Pull from Gist</button>
        <button id="worm-add-npc">➕ Add NPC</button>
        <button id="worm-edit-state">✏️ Edit State JSON</button>
      </div>

      <div class="worm-tracker-section" id="worm-npc-list-section">
        <strong>Active NPCs</strong>
        <ul id="worm-npc-list"></ul>
      </div>
    </div>
  `;
}

export function buildConfirmationModal(delta) {
  const lines = [];

  if (delta.npc_knowledge) {
    for (const [npc, changes] of Object.entries(delta.npc_knowledge)) {
      for (const [field, val] of Object.entries(changes)) {
        lines.push(`<li><b>${npc}</b> — ${field}: <code>${JSON.stringify(val)}</code></li>`);
      }
    }
  }
  if (delta.arc_events) {
    for (const [evtId, status] of Object.entries(delta.arc_events)) {
      lines.push(`<li>Event <b>${evtId}</b> → <code>${status}</code></li>`);
    }
  }
  if (delta.new_npcs && delta.new_npcs.length) {
    for (const npc of delta.new_npcs) {
      lines.push(`<li>New NPC: <b>${npc.display_name}</b> (${npc.alias || 'no alias'}, ${npc.faction || 'unknown faction'})</li>`);
    }
  }
  if (delta.divergence_delta) {
    lines.push(`<li>Divergence rating +${delta.divergence_delta}</li>`);
  }
  if (delta.in_world_date) {
    lines.push(`<li>In-world date → <code>${delta.in_world_date}</code></li>`);
  }

  if (!lines.length) return null; // Nothing to confirm

  return `
    <div id="worm-modal-overlay" class="worm-modal-overlay">
      <div class="worm-modal">
        <h4>Proposed State Updates</h4>
        <ul>${lines.join('')}</ul>
        <div class="worm-modal-buttons">
          <button id="worm-modal-approve">✅ Approve</button>
          <button id="worm-modal-edit">✏️ Edit</button>
          <button id="worm-modal-reject">❌ Reject</button>
        </div>
      </div>
    </div>
  `;
}

export function buildNpcAddModal() {
  return `
    <div id="worm-modal-overlay" class="worm-modal-overlay">
      <div class="worm-modal">
        <h4>Add New NPC</h4>
        <label>Display Name</label>
        <input type="text" id="worm-npc-name" placeholder="Taylor Hebert" />
        <label>Alias / Cape Name</label>
        <input type="text" id="worm-npc-alias" placeholder="Skitter" />
        <label>Faction</label>
        <input type="text" id="worm-npc-faction" placeholder="Undersiders" />
        <label>First Appeared (Arc)</label>
        <input type="text" id="worm-npc-arc" placeholder="1.1" />
        <div class="worm-modal-buttons">
          <button id="worm-npc-add-confirm">✅ Create</button>
          <button id="worm-npc-add-cancel">❌ Cancel</button>
        </div>
      </div>
    </div>
  `;
}
