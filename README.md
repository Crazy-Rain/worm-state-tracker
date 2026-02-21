# Worm State Tracker — v0.4.0
### SillyTavern Extension for *Worm* (Parahumans) Roleplay

> **To restore context in a new session:** Paste this README. Everything needed to continue development or debugging is here. The extension reads from a GitHub Gist — that Gist is your save file and survives between sessions.

---

## Scenario

**Setting:** Brockton Bay, Massachusetts — Earth Bet  
**Date:** April 15, 2011 — early morning, day after the Undersiders' bank robbery  
**Arc:** 2 (post-Insinuation 2.9)  
**Player Character:** A unique OC — **NOT Taylor Hebert.** Taylor is an NPC in this scenario.  
**Immediate city threat:** Bakuda's bombing campaign, which started yesterday alongside the bank job.

**Aisha Laborn status:** 13 years old, civilian, no powers. She does not trigger until sometime after Leviathan (May 15, 2011). Any encounter with her now is with Brian Laborn's sharp-tongued kid sister — no cape identity, nothing. She goes places she absolutely shouldn't.

---

## Architecture

**Extension + Gist only. No lorebook.**

The static lorebook was deprecated because it caused duplicate injection — lorebook entries fired their stale baked data *alongside* live Gist data in the same prompt, creating conflicts and burning tokens on contradictory information. The Gist is the single source of truth. The extension handles everything.

```
GitHub Gist (private) — the live save file
├── _master_index.json        ← 27-character roster, factions, critical notes
├── world_state.json          ← live game state: arc, date, divergence, situations, secrets
├── arc_events.json           ← 29 arcs, 234 chapters (real wiki XML source)
└── npc_*.json (27 files)     ← individual NPC profiles with structured data

SillyTavern Extension: worm-state-tracker-v2/
├── manifest.json             ← extension registration
├── index.js                  ← all logic: hooks, UI panel, state management, delta application
├── gist.js                   ← GitHub Gist read/write, file scaffolding
├── parser.js                 ← AI response parsing, delta type extraction
└── style.css                 ← mobile-responsive panel styles
```

**On `chat_changed`:** Fetches the Gist linked to that chat ID → caches all files in localStorage.

**On `message_received`:** Strips thinking blocks → sends cleaned AI response + current state to `generateQuietPrompt` for delta extraction → surfaces detected changes in the approve/deny queue → applies accepted changes → debounced 8-second push to Gist.

---

## Extension Features (v0.4.0)

### Configuration Panel
- **GitHub PAT** — stored in localStorage, never transmitted outside Gist API calls
- **Gist ID** — per-chat, maps chat IDs to Gist IDs so different chats can use different Gists
- **Max NPCs injected** — configurable 1–30 (default 8). Changes take effect immediately. Controls how many NPC profiles are selected and injected per prompt.
- **Save / Sync / New Gist** buttons

### PC Knowledge Editor
A collapsible "🔍 PC Knowledge" section in the panel that reads `known_secrets` from `world_state.json` directly. Every secret shows as a toggleable row — green ✓ (known) or grey ✗ (unknown). Click to flip, × to delete, add new entries with the input at the bottom. Changes write to Gist automatically (debounced). No queue — this is you directly editing your own canon state.

### Import
**📂 Import JSON files** button accepts one or more `.json` files via the native file picker. Detects file type by filename pattern (npc_*, world_state, arc_events, _master_index) and routes each through the approve/deny queue before writing to Gist.

### Approve/Deny Queue
Every AI-detected state change surfaces here before writing. Queue header shows count; bulk ✓ All / ✗ All buttons. Each card shows: change type, NPC name, old value → new value (expandable). Accept writes to Gist. Deny discards.

### Smart NPC Selection
Reads the most recent chat messages (configurable scan depth), scores every NPC file against mentions of their name, alias, or any entry in their `aliases` array. Selects the top N most relevant (N = Max NPCs setting). Alias arrays cover cape names, civilian names, and legacy identities — e.g. "Hellhound" fires Rachel's profile, "Defiant" fires Armsmaster's post-arc-8 version.

---

## Delta Types

The parser extracts six types of changes from each AI response:

| Type | What it tracks |
|------|----------------|
| `npc_state` | Knowledge shifts, relationship changes to PC, emotional/physical state |
| `arc_event` | Canon events firing as canon / altered / skipped |
| `world_state` | In-world date advancing, divergence increments, situation updates |
| `npc_new` | New NPC introduced — scaffolds a blank template on the Gist |
| `npc_aliases` | Name/alias changes (e.g. Armsmaster adopts Defiant after arc 8) |
| `npc_appearance` | Concrete physical descriptions — merges into structured appearance object field by field |

### Structured Appearance Fields
Each NPC file supports an `appearance` object with named fields: `height`, `build`, `face`, `hair`, `eyes`, `body_detail`, `distinguishing_marks`, `clothing_style`. The renderer builds a readable physical description from whichever fields are populated. Flat `physical_description` strings are backward-compatible. When the AI describes a character concretely, `npc_appearance` deltas merge new fields without overwriting existing ones — a scene that only establishes hair color won't wipe out build and height data already on file.

---

## Gist File Inventory

Upload all of these to a single private Gist. Filenames are exact — no typos.

### Core State Files
| File | Purpose |
|------|---------|
| `_master_index.json` | 27-character roster with faction, alias, classification, critical notes |
| `world_state.json` | Live game state — arc, date, factions, active situations, known secrets, PC relationships |
| `arc_events.json` | 29 arcs, 234 chapters sourced from wiki XML; each chapter has plot summary + player_status slot |

### NPC Files (27 total)
| File | Character |
|------|-----------|
| `npc_taylor_hebert.json` | Taylor Hebert / Skitter — NPC in this scenario |
| `npc_grue.json` | Brian Laborn / Grue |
| `npc_tattletale.json` | Lisa Wilbourn / Tattletale |
| `npc_regent.json` | Alec Vasil / Regent (triggered age 10, not 16) |
| `npc_rachel_lindt.json` | Rachel Lindt / Bitch / Hellhound |
| `npc_aisha_laborn.json` | Aisha Laborn — 13, no powers, pre-trigger civilian |
| `npc_coil.json` | Thomas Calvert / Coil |
| `npc_dinah_alcott.json` | Dinah Alcott — captive, precog |
| `npc_armsmaster.json` | Colin Wallis / Armsmaster / Defiant |
| `npc_miss_militia.json` | Hannah / Miss Militia |
| `npc_dauntless.json` | Shawn / Dauntless |
| `npc_assault.json` | Ethan / Assault (ex-Madcap) |
| `npc_battery.json` | Battery |
| `npc_velocity.json` | Robin Swoyer / Velocity |
| `npc_piggot.json` | Emily Piggot — PRT Director |
| `npc_aegis.json` | Carlos / Aegis |
| `npc_clockblocker.json` | Dennis / Clockblocker |
| `npc_vista.json` | Missy Biron / Vista |
| `npc_kid_win.json` | Chris / Kid Win |
| `npc_triumph.json` | Rory Christner / Triumph |
| `npc_flechette.json` | Lily / Flechette / Foil (not in Brockton Bay until post-Leviathan) |
| `npc_parian.json` | Sabah / Parian |
| `npc_gallant.json` | Dean Stansfield / Gallant |
| `npc_sophia_hess.json` | Sophia Hess / Shadow Stalker |
| `npc_danny_hebert.json` | Danny Hebert |
| `npc_emma_barnes.json` | Emma Barnes |
| `npc_madison_clements.json` | Madison Clements |
| `npc_lung.json` | Kenta / Lung — in PRT custody |

---

## Setup

### 1 — Create the Gist
1. Go to [gist.github.com](https://gist.github.com) and create a **private** Gist
2. Upload all files from the inventory above (drag and drop or paste contents)
3. Copy the Gist ID from the URL: `gist.github.com/{username}/{GIST_ID}`

### 2 — Create a GitHub PAT
1. GitHub → Settings → Developer settings → Personal access tokens → Fine-grained or Classic
2. Scope needed: **Gist** (read + write)
3. Copy the token — you only see it once

### 3 — Install the Extension
1. Copy the `worm-state-tracker-v2/` folder to:  
   `SillyTavern/public/extensions/third-party/worm-state-tracker/`
2. Hard refresh ST (Ctrl+Shift+R)
3. Extensions menu → enable **Worm State Tracker**
4. The panel appears in the Extensions settings drawer (▼ arrow to expand)

### 4 — Configure
1. Enter your GitHub PAT in the PAT field
2. Enter your Gist ID
3. Set Max NPCs to your preferred value (8 is a good starting point)
4. Click **Save** → **↺ Sync**
5. Status should show: `synced — N files`

**No lorebook needed.** Do not install `worm_lorebook.json` — it's obsolete and will cause duplicate injection.

---

## Critical NPC Notes

Things the AI must never get wrong, sourced from the wiki and Wildbow comments:

| NPC | Critical |
|-----|----------|
| Taylor Hebert | NPC in this scenario. Double-trigger (locker). No second trigger possible. Mole arrangement with Armsmaster — OC does not know this. |
| Tattletale | Average intelligence *without* her power — she knows it and it terrifies her. Migraines from overuse. Found her brother's body. |
| Regent | Triggered at **10** under Heartbreaker's abuse, not 16. PRT identified him as former Hijack post-bank job. |
| Rachel Lindt | Cannot read. Auburn hair (not dark). Power neurologically rewired her toward canine social structures over human ones. Dogs: Brutus, Judas, Angelica. |
| Aisha Laborn | **13 years old. No powers.** Triggers post-Leviathan (May 15, 2011+). Currently just Brian's kid sister — a civilian in a bombing zone. |
| Armsmaster | Under quiet internal investigation for the Lung credit claim. Nano-thorn halberd not yet public. Lie detector fails on Taylor (she offloads emotional cues to her bugs). |
| Sophia Hess | Triggered at **12** (not 15–16). **Breaker 3** (Stranger 2, Mover 1) — misclassified as Mover by many. Three vulnerabilities: electricity damages her in breaker state, aerosols cause harm on re-formation, mid-phase stall causes excruciating pain. Carries lethal crossbow bolts illegally. |
| Coil | Real identity: Thomas Calvert. PRT civilian consultant — has live intelligence access. Nilbog survivor alongside Piggot; neither knows about the other. |
| Dinah Alcott | 12 years old. Kidnapped April 14 — same day as bank robbery. Family starting to report her missing as of April 15. Triumph (Rory Christner) is her cousin. |
| Miss Militia | Sleeps approximately once per year — power sustains her. Knows Taylor is Armsmaster's mole. |
| Vista | 12 years old. Lied about parental permission for the Leviathan battle. Living creatures in her area reduce her maximum warp scale. |
| Dauntless | Fate: Leviathan time bubble → eventual Kronos Titan. Not arc 2 relevant. |
| Velocity | Fate: dies at Leviathan. At full speed cannot interact with objects heavier than air resistance. |
| Flechette | NOT in Brockton Bay at scenario start. Arrives post-Leviathan. Her shard (Sting) can kill Endbringers with a core shot. |

---

## Alias Coverage

These aliases are populated in NPC files and will trigger the correct NPC profile on any mention:

| NPC | Aliases that trigger their profile |
|-----|-----------------------------------|
| Taylor Hebert | Skitter, Taylor, Weaver (future) |
| Brian Laborn | Grue, Brian |
| Lisa Wilbourn | Tattletale, Lisa, Tt, Tats |
| Alec Vasil | Regent, Hijack, Alec |
| Rachel Lindt | Bitch, Hellhound, Rachel |
| Aisha Laborn | Imp (post-trigger), Aisha |
| Colin Wallis | Armsmaster, Defiant, Colin |
| Lily | Flechette, Foil, Lily |
| Sophia Hess | Shadow Stalker, Shadow, Sophia |

---

## Divergence Tracking

`world_state.json` tracks a `divergence` object. Every OC action that provably changes a canon outcome adds to `rating`. At the `threshold` (default 15), `timeline_reliable` flips false — from that point the arc_events schedule is a reference, not a guarantee.

The OC's existence is itself a minor divergence (it's noted in `divergence.baseline_note`). Small interactions won't butterfly major arc events. Large ones — stopping Bakuda before her arc 3 capture, warning the PRT about Coil — will accumulate fast.

---

## Known Constraints

- **GitHub API is blocked in the Claude build container.** Files must be uploaded to Gist manually via browser or GitHub CLI. The extension running inside ST's browser context has no such restriction — read/write works fine there.
- **Extension requires ST 1.11.0+** for `setExtensionPrompt`.
- **File naming is exact.** Common typo Gist filenames to rename if present: `npc_cpil.json` → `npc_coil.json`, `npc_maddison_clements.json` → `npc_madison_clements.json`, `npc_reagent.json` → `npc_regent.json`.

---

## Development History

- **Sessions 1–5:** Built lorebook infrastructure from 23MB Worm wiki XML. 27 NPC templates, master index, world state baseline.
- **Session 6:** Arc events JSON for arcs 1–3. Debugged GitHub API egress block (container can't reach api.github.com).
- **Sessions 7–8:** Architecture locked: lorebook is static encyclopedia, Gist is live save. Deprecation of lorebook as active injection layer decided.
- **Session 9:** Extension v0.2.0 — manifest, index.js, gist.js, parser.js, style.css. Basic Gist sync + NPC injection.
- **Session 10:** Extension v0.3.0 — mobile-responsive UI (16px inputs, 44px touch targets, viewport scroll). JSON import via file picker with approve/deny queue routing.
- **Session 11:** Alias tracking (multi-alias arrays on 7 NPCs). Full 29-arc extraction from real wiki XML (234 chapters, replacing 3-arc summary). Import path bug fixed (../../../../ → ../../../ — was causing extension load failure). Alias delta type added.
- **Session 12:** UI fixes — removed duplicate drawer toggle listener (was double-firing against ST's own handler). CSS overflow fix so panel doesn't hide under next extension. 
- **Session 13:** Max NPCs configurable input (1–30, localStorage-persisted). PC Knowledge / known_secrets in-panel editor (toggle, delete, add). Structured appearance fields (8-field object replacing flat string). Appearance delta type added to extraction pipeline.
- **Session 14:** NPC appearance data populated from real wiki XML for Taylor, Grue, Tattletale, Regent, Rachel, Aisha. Appearance deltas wired to approve/deny queue.
- **Session 15:** world_state.json rebuilt — correct arc (2), correct date (April 15, 2011), OC player character frame (not Taylor), all known_secrets reset to false, Taylor flagged as NPC, Aisha age corrected to 13 (was wrong at 15). Master index updated — arc_1_status → status, scenario_anchor added, Taylor pc_role flagged. This README rewritten.

---

*v0.4.0 — February 2026. 27 NPCs. 29 arcs / 234 chapters (wiki XML source). Extension: no lorebook, Gist-only architecture.*
