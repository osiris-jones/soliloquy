/**
 * Shard Character Builder — builder.js
 *
 * Loads source.json + builder-config.json and renders a step-by-step
 * character builder. Copy source.json from the system root (or from
 * class-browser/source.json) into this directory before serving.
 */

// ── Constants ────────────────────────────────────────────────────────────────

const DATA_URL   = "./source.json";
const CONFIG_URL = "./builder-config.json";

// ── Global data ──────────────────────────────────────────────────────────────

let DATA   = null;  // parsed source.json
let CONFIG = null;  // parsed builder-config.json

let CLASS_MAP   = {};  // classId  → class object
let ABILITY_MAP = {};  // abilityId → ability object
let TAG_MAP     = {};  // tagId    → tag object

// ── Application state ────────────────────────────────────────────────────────

let STATE = {
  name:        "Hero",
  baseClassId: null,
  level1Picks: [],   // [{ abilityId, classId }] — classId is always baseClassId
  levels:      []    // [{ classId, abilityId, heroicTalentId }] — one per level ≥2
};

// Index of the step currently displayed in the step panel.
// 0 = choose base class, 1 = level-1 picks, N≥2 = level N
let activeStepIndex = 0;

// ── Boot ─────────────────────────────────────────────────────────────────────

async function init() {
  const stepPanel = document.getElementById("step-panel");

  try {
    const [dataResp, cfgResp] = await Promise.all([
      fetch(DATA_URL),
      fetch(CONFIG_URL)
    ]);
    if (!dataResp.ok) throw new Error(`source.json HTTP ${dataResp.status}`);
    if (!cfgResp.ok)  throw new Error(`builder-config.json HTTP ${cfgResp.status}`);
    DATA   = await dataResp.json();
    CONFIG = await cfgResp.json();
  } catch (err) {
    stepPanel.innerHTML = `<div class="load-error">
      <strong>Could not load data.</strong><br>${err.message}<br><br>
      Copy <code>source.json</code> into this directory, then serve via HTTP
      (not <code>file://</code>). Try: <code>npx serve .</code>
    </div>`;
    return;
  }

  // Build fast-lookup maps
  CLASS_MAP   = Object.fromEntries((DATA.classes   ?? []).map(c => [c.id, c]));
  ABILITY_MAP = Object.fromEntries((DATA.abilities ?? []).map(a => [a.id, a]));
  TAG_MAP     = Object.fromEntries((DATA.tags      ?? []).map(t => [t.id, t]));

  // Static control wiring
  document.getElementById("char-name").addEventListener("input", e => {
    STATE.name = e.target.value.trim() || "Hero";
    renderSummary();
  });
  document.getElementById("add-level-btn").addEventListener("click", onAddLevel);
  document.getElementById("export-btn").addEventListener("click", exportBuild);

  // Dismiss the floating ability tooltip on anything that moves or supersedes
  // it. (Clicks are handled by the delegated listener further down.)
  document.addEventListener("keydown", e => {
    if (e.key === "Escape") hideAbilityTooltip();
  });
  window.addEventListener("scroll", hideAbilityTooltip, true);  // capture: any scroller
  window.addEventListener("resize", hideAbilityTooltip);

  render();
}

// ── Derived state helpers ────────────────────────────────────────────────────

function getTotalLevel() {
  return STATE.baseClassId ? 1 + STATE.levels.length : 0;
}

function getClassLevel(classId) {
  let n = (STATE.baseClassId === classId) ? 1 : 0;
  STATE.levels.forEach(lv => { if (lv.classId === classId) n++; });
  return n;
}

// Flat array of all explicitly chosen ability IDs (not auto-granted).
function getAllChosenAbilityIds() {
  const ids = [];
  STATE.level1Picks.forEach(p => { if (p.abilityId) ids.push(p.abilityId); });
  STATE.levels.forEach(lv => {
    if (lv.abilityId)      ids.push(lv.abilityId);
    if (lv.heroicTalentId) ids.push(lv.heroicTalentId);
  });
  return ids;
}

// Which classId was a particular chosen ability attributed to?
function getAttributedClass(abilityId) {
  for (const p of STATE.level1Picks) {
    if (p.abilityId === abilityId) return STATE.baseClassId;
  }
  for (const lv of STATE.levels) {
    if (lv.abilityId === abilityId) return lv.classId;
  }
  return null;
}

// ── Eligibility ──────────────────────────────────────────────────────────────

function isPlayableClass(cls) {
  return !(CONFIG.pseudoClasses ?? []).includes(cls.id);
}

/**
 * Abilities eligible to pick for a given classId at a given totalLevel.
 * Excludes: rank 0, innate, heroic talents, special sub-abilities (have parent),
 *           already chosen, outside rank level gate or rank prereq.
 */
function getEligibleAbilities(classId, totalLevel) {
  const chosenSet  = new Set(getAllChosenAbilityIds());
  const deckId     = CONFIG.deckForClass?.[classId];
  const deckAbIds  = new Set(CLASS_MAP[deckId]?.abilities ?? []);
  const classAbIds = new Set(CLASS_MAP[classId]?.abilities ?? []);

  return (DATA.abilities ?? []).filter(ab => {
    if (ab.rank === 0)         return false;  // auto-granted basics
    if (ab.isInnate)           return false;  // auto-granted innates
    if (ab.isHeroicTalent)     return false;  // separate picker
    if (ab.parent)             return false;  // special sub-ability; auto-granted by parent
    if (chosenSet.has(ab.id))  return false;  // already taken

    const isClassAb = classAbIds.has(ab.id);
    const isDeckAb  = deckAbIds.has(ab.id);
    if (!isClassAb && !isDeckAb) return false;

    // Rank level gate
    const rankReq = Number(CONFIG.rankLevelRequirements?.[String(ab.rank)] ?? 99);
    if (totalLevel < rankReq) return false;

    // Rank prereq: need a rank-(N−1) ability attributed to classId
    const prereqRank = ab.rank - 1;
    if (prereqRank >= 1) {
      const hasPrereq = getAllChosenAbilityIds().some(id => {
        const a = ABILITY_MAP[id];
        return a && a.rank === prereqRank && getAttributedClass(id) === classId;
      });
      if (!hasPrereq) return false;
    }

    return true;
  });
}

/**
 * Heroic talents eligible at the current state.
 * Generic (from the 'heroic' pseudo-class): always available.
 * Class-specific: class must have ≥ heroicTalentClassLevelReq levels.
 * Sub-abilities (those with a parent) are never directly selectable.
 */
function getEligibleHeroicTalents() {
  const chosenSet  = new Set(getAllChosenAbilityIds());
  const genericIds = new Set(CLASS_MAP["heroic"]?.abilities ?? []);
  const req        = CONFIG.heroicTalentClassLevelReq ?? 3;

  const eligibleClassIds = new Set(
    (DATA.classes ?? [])
      .filter(c => isPlayableClass(c) && getClassLevel(c.id) >= req)
      .map(c => c.id)
  );

  return (DATA.abilities ?? []).filter(ab => {
    if (!ab.isHeroicTalent)   return false;
    if (ab.parent)            return false;  // special sub-ability of a heroic talent
    if (chosenSet.has(ab.id)) return false;

    if (genericIds.has(ab.id))            return true;  // generic pool
    if (eligibleClassIds.has(ab.class))   return true;  // class-specific, level req met
    return false;
  });
}

// ── Auto-granted ability helpers ─────────────────────────────────────────────

// Basic (rank 0) abilities for a class, excluding sub-abilities.
function getBasicAbilities(classId) {
  const cls = CLASS_MAP[classId];
  if (!cls) return [];
  return (cls.abilities ?? [])
    .map(id => ABILITY_MAP[id])
    .filter(ab => ab && ab.rank === 0 && !ab.isHeroicTalent && !ab.parent);
}

function getInnateAbilities() {
  return (DATA.abilities ?? []).filter(ab => ab.isInnate);
}

// Special sub-abilities automatically granted alongside a chosen ability.
function getSpecialChildren(parentId) {
  return (DATA.abilities ?? []).filter(ab => ab.parent === parentId);
}

// ── Step management ──────────────────────────────────────────────────────────

function isStepComplete(stepIndex) {
  if (stepIndex === 0) return !!STATE.baseClassId;
  if (stepIndex === 1) return STATE.level1Picks.length === 2;
  const lv = STATE.levels[stepIndex - 2];
  if (!lv || !lv.classId || !lv.abilityId) return false;
  const isHeroic = (CONFIG.heroicTalentLevels ?? []).includes(stepIndex);
  return !isHeroic || !!lv.heroicTalentId;
}

function onAddLevel() {
  STATE.levels.push({ classId: null, abilityId: null, heroicTalentId: null });
  activeStepIndex = 1 + STATE.levels.length;  // points to the new level's step
  render();
}

// Re-open a past step for editing; trims everything after it.
function jumpToStep(stepIndex) {
  if (stepIndex === 0) {
    STATE.baseClassId = null;
    STATE.level1Picks = [];
    STATE.levels      = [];
  } else if (stepIndex === 1) {
    STATE.level1Picks = [];
    STATE.levels      = [];
  } else {
    // Keep levels 2 through (stepIndex−1); reset level stepIndex.
    STATE.levels.length = stepIndex - 2;
    STATE.levels.push({ classId: null, abilityId: null, heroicTalentId: null });
  }
  activeStepIndex = stepIndex;
  render();
}

// ── Main render ──────────────────────────────────────────────────────────────

function render() {
  hideAbilityTooltip();   // the anchor rows are about to be replaced
  renderSummary();
  renderStep();
  updateButtons();
}

function updateButtons() {
  const addBtn    = document.getElementById("add-level-btn");
  const exportBtn = document.getElementById("export-btn");

  // "Add Level" only at the frontier (nothing after current step) and when complete.
  const atFrontier = STATE.baseClassId && activeStepIndex === 1 + STATE.levels.length;
  const canAdd     = atFrontier && isStepComplete(activeStepIndex);
  addBtn.hidden    = !canAdd;

  exportBtn.disabled = !(isStepComplete(0) && isStepComplete(1));
}

// ── Summary panel ────────────────────────────────────────────────────────────

function renderSummary() {
  const list = document.getElementById("summary-levels");
  list.innerHTML = "";

  if (!STATE.baseClassId) {
    list.innerHTML = `<div class="summary-hint">Choose a base class to begin.</div>`;
    return;
  }

  // Level 1
  list.appendChild(buildSummaryLevel(1));

  // Levels 2+
  STATE.levels.forEach((lv, idx) => {
    if (lv.classId || activeStepIndex === idx + 2) {
      list.appendChild(buildSummaryLevel(idx + 2));
    }
  });

  // Innates at the bottom
  const innates = getInnateAbilities();
  if (innates.length > 0) {
    const sec = document.createElement("div");
    sec.className = "summary-innates";
    sec.innerHTML = `<div class="summary-innate-label">Innate</div>`;
    innates.forEach(ab => {
      sec.appendChild(summaryAbEl("· " + ab.name, "innate", ab.id));
      getSpecialChildren(ab.id).forEach(c =>
        sec.appendChild(summaryAbEl("  · " + c.name, "innate", c.id))
      );
    });
    list.appendChild(sec);
  }
}

function buildSummaryLevel(levelNum) {
  const stepIdx  = levelNum === 1 ? 1 : levelNum;
  const isHeroic = (CONFIG.heroicTalentLevels ?? []).includes(levelNum);
  const isActive = activeStepIndex === stepIdx;
  const isDone   = isStepComplete(stepIdx);

  const classId = levelNum === 1 ? STATE.baseClassId : STATE.levels[levelNum - 2]?.classId;
  const cls     = CLASS_MAP[classId];
  const baseTag = levelNum === 1 ? " (base)" : "";
  const star    = isHeroic ? "★ " : "";

  const el = document.createElement("div");
  el.className = "summary-level" + (isHeroic ? " summary-heroic-level" : "");

  // Header
  const header = document.createElement("div");
  header.className = "summary-level-header" + (isActive ? " active" : "");
  header.innerHTML =
    `<span class="summary-lv-num">${star}Lv ${levelNum}</span>` +
    `<span class="summary-lv-class">${cls ? cls.name : "…"}${baseTag}</span>` +
    (isDone ? `<span class="summary-edit-hint">✎</span>` : "");
  header.addEventListener("click", () => jumpToStep(stepIdx));
  el.appendChild(header);

  // Ability sub-rows
  const abList = document.createElement("div");
  abList.className = "summary-abilities";

  if (levelNum === 1) {
    // Auto-granted basics
    getBasicAbilities(STATE.baseClassId).forEach(ab => {
      abList.appendChild(summaryAbEl("· " + ab.name, "auto", ab.id));
      getSpecialChildren(ab.id).forEach(c =>
        abList.appendChild(summaryAbEl("  · " + c.name, "auto-child", c.id))
      );
    });
    // Level-1 chosen picks
    STATE.level1Picks.forEach(p => {
      if (!p.abilityId) return;
      const ab = ABILITY_MAP[p.abilityId];
      if (!ab) return;
      abList.appendChild(summaryAbEl("● " + ab.name, "chosen", ab.id));
      getSpecialChildren(ab.id).forEach(c =>
        abList.appendChild(summaryAbEl("  · " + c.name, "granted-child", c.id))
      );
    });
    for (let i = STATE.level1Picks.length; i < 2; i++) {
      abList.appendChild(summaryAbEl("— pick an ability —", "placeholder"));
    }
  } else {
    const lv = STATE.levels[levelNum - 2];
    if (lv?.abilityId) {
      const ab = ABILITY_MAP[lv.abilityId];
      if (ab) {
        abList.appendChild(summaryAbEl("● " + ab.name, "chosen", ab.id));
        getSpecialChildren(ab.id).forEach(c =>
          abList.appendChild(summaryAbEl("  · " + c.name, "granted-child", c.id))
        );
      }
    } else if (classId) {
      abList.appendChild(summaryAbEl("— pick an ability —", "placeholder"));
    }

    if (isHeroic) {
      if (lv?.heroicTalentId) {
        const ht = ABILITY_MAP[lv.heroicTalentId];
        if (ht) {
          abList.appendChild(summaryAbEl("★ " + ht.name, "heroic-chosen", ht.id));
          getSpecialChildren(ht.id).forEach(c =>
            abList.appendChild(summaryAbEl("  · " + c.name, "granted-child", c.id))
          );
        }
      } else if (classId) {
        abList.appendChild(summaryAbEl("★ — pick a heroic talent —", "heroic-placeholder"));
      }
    }
  }

  el.appendChild(abList);
  return el;
}

// `abilityId`, when given, makes the row clickable for the floating detail tooltip.
function summaryAbEl(text, type, abilityId = null) {
  const el = document.createElement("div");
  el.className = `summary-ability summary-ab-${type}`;
  el.textContent = text;
  if (abilityId) {
    el.dataset.abilityId = abilityId;
    el.title = "Click for details";
  }
  return el;
}

// ── Step panel ───────────────────────────────────────────────────────────────

function renderStep() {
  const panel = document.getElementById("step-panel");
  if (!DATA) return;

  if (activeStepIndex === 0) {
    panel.innerHTML = buildStep0();
    // Wire class-option card clicks
    panel.querySelectorAll(".class-option[data-classid]").forEach(card => {
      card.addEventListener("click", () => {
        STATE.baseClassId = card.dataset.classid;
        STATE.level1Picks = [];
        STATE.levels      = [];
        activeStepIndex   = 1;
        render();
      });
    });
  } else if (activeStepIndex === 1) {
    panel.innerHTML = buildStep1();
  } else {
    panel.innerHTML = buildStepN(activeStepIndex);
  }

  // Wire ability-detail expand/collapse on every render
  panel.querySelectorAll(".ab-row-header.has-desc").forEach(header => {
    header.addEventListener("click", e => {
      if (e.target.closest(".select-btn")) return;
      const details = header.nextElementSibling;
      if (details?.classList.contains("ab-details")) {
        details.hidden = !details.hidden;
        header.querySelector(".ab-caret").textContent = details.hidden ? "▶" : "▼";
      }
    });
  });
}

// Step 0 — choose base class
function buildStep0() {
  const classes = (DATA.classes ?? []).filter(isPlayableClass);
  const cards   = classes.map(cls => {
    const s   = cls.stats ?? {};
    const sel = cls.id === STATE.baseClassId ? " selected" : "";
    return `
      <div class="class-option${sel}" data-classid="${cls.id}">
        <div class="class-option-name">${cls.name}</div>
        <div class="class-option-stats">
          <span class="stat hp">&#9829; ${s.maxHP ?? "—"}</span>
          <span class="stat">ATK ${s.atk ?? "—"}</span>
          <span class="stat">MAG ${s.mag ?? "—"}</span>
          <span class="stat">DEF ${s.def ?? "—"}</span>
          <span class="stat">SPD ${s.spd ?? "—"}</span>
          <span class="stat">FP ${s.focusPool ?? 0}</span>
        </div>
        <div class="class-option-desc">${cls.description ? marked.parse(cls.description) : ""}</div>
      </div>`;
  }).join("");

  return `
    <div class="step-header">
      <div class="step-title">Choose Your Base Class</div>
      <div class="step-hint">Your base class determines your core stats. All Basic abilities from your base class are granted automatically at level 1.</div>
    </div>
    <div class="class-grid">${cards}</div>`;
}

// Step 1 — level 1 ability picks (2 slots)
function buildStep1() {
  const cls    = CLASS_MAP[STATE.baseClassId];
  const basics = getBasicAbilities(STATE.baseClassId);

  let html = `
    <div class="step-header">
      <div class="step-title">Level 1 — ${cls?.name ?? ""} (Base Class)</div>
      <div class="step-hint">
        Choose 2 rank-1 abilities. Basic abilities (shown below) are auto-granted.
        <button class="undo-btn" style="margin-left:10px" data-action="change-base-class">← Change class</button>
      </div>
    </div>`;

  // Auto-granted basics — read-only cards, but expandable like the pickers below
  if (basics.length > 0) {
    html += `<div class="step-section-label">Auto-granted Basic abilities</div>
      <div class="ability-picker">
        <div class="picker-rank-group">
          ${basics.map(ab => buildPickerCard(ab, null, false, { selectable: false })).join("")}
        </div>
      </div>`;
  }

  const slot1Done = STATE.level1Picks.length >= 1;
  const slot2Done = STATE.level1Picks.length >= 2;

  // Slot 1
  if (!slot1Done) {
    const eligible = getEligibleAbilities(STATE.baseClassId, 1);
    html += `<div class="step-section-label">Pick 1 of 2</div>`;
    html += buildAbilityPicker(eligible, "pick-l1-0");
  } else {
    const ab = ABILITY_MAP[STATE.level1Picks[0].abilityId];
    html += `<div class="step-section-label">Pick 1 of 2</div>
      <div class="step-chosen-ability">● ${ab?.name ?? ""}
        <button class="undo-btn" data-action="undo-l1-pick" data-slot="0">✕</button>
      </div>`;
  }

  // Slot 2
  if (slot1Done && !slot2Done) {
    const eligible = getEligibleAbilities(STATE.baseClassId, 1);
    html += `<div class="step-section-label">Pick 2 of 2</div>`;
    html += buildAbilityPicker(eligible, "pick-l1-1");
  } else if (slot2Done) {
    const ab = ABILITY_MAP[STATE.level1Picks[1].abilityId];
    html += `<div class="step-section-label">Pick 2 of 2</div>
      <div class="step-chosen-ability">● ${ab?.name ?? ""}
        <button class="undo-btn" data-action="undo-l1-pick" data-slot="1">✕</button>
      </div>
      <div class="step-complete-msg">✓ Both level 1 picks complete. Click <em>+ Add Level</em> or export.</div>`;
  }

  return html;
}

// Step N (N ≥ 2) — choose class + ability (+ heroic talent if applicable)
function buildStepN(stepIndex) {
  const levelNum  = stepIndex;
  const isHeroic  = (CONFIG.heroicTalentLevels ?? []).includes(levelNum);
  const lv        = STATE.levels[stepIndex - 2];
  if (!lv) return `<div class="step-hint">State error — no level entry for step ${stepIndex}.</div>`;

  const classChosen   = !!lv.classId;
  const abilityChosen = !!lv.abilityId;
  const heroicDone    = !isHeroic || !!lv.heroicTalentId;
  const complete      = classChosen && abilityChosen && heroicDone;

  let html = `
    <div class="step-header">
      <div class="step-title">${isHeroic ? "★ " : ""}Level ${levelNum}${isHeroic ? " — Heroic Talent Level" : ""}</div>
      <div class="step-hint">${isHeroic
        ? `At heroic levels, you gain a regular ability pick <em>and</em> a Heroic Talent. Heroic Talents from a class require ≥${CONFIG.heroicTalentClassLevelReq} levels in that class.`
        : "Choose a class for this level, then pick an ability."
      }</div>
    </div>`;

  // Class chooser
  html += `<div class="step-section-label">Take a level in…</div>`;
  html += buildClassChooser(lv.classId, stepIndex);

  if (!classChosen) return html;

  const totalLevel = getTotalLevel();

  // Regular ability pick
  html += `<div class="step-section-label">Choose an ability</div>`;
  if (!abilityChosen) {
    const eligible = getEligibleAbilities(lv.classId, totalLevel);
    if (eligible.length === 0) {
      html += `<div class="no-abilities-hint">No eligible abilities available. You may need a lower-rank ability in this class first, or this class has no abilities yet at this rank.</div>`;
    } else {
      html += buildAbilityPicker(eligible, `pick-ability-${stepIndex}`);
    }
  } else {
    const ab = ABILITY_MAP[lv.abilityId];
    html += `<div class="step-chosen-ability">● ${ab?.name ?? lv.abilityId}
      <button class="undo-btn" data-action="undo-ability" data-step="${stepIndex}">✕</button>
    </div>`;
    const children = getSpecialChildren(lv.abilityId);
    if (children.length) {
      html += `<div style="padding:4px 0 0 14px">` +
        children.map(c => `<div class="child-ability">↳ <em>${c.name}</em> <span class="child-hint">(also granted)</span></div>`).join("") +
        `</div>`;
    }
  }

  // Heroic talent pick
  if (isHeroic && abilityChosen) {
    html += `<div class="step-section-label heroic-label">★ Choose a Heroic Talent</div>`;
    if (!heroicDone) {
      const eligible = getEligibleHeroicTalents();
      if (eligible.length === 0) {
        html += `<div class="no-abilities-hint">No heroic talents available yet.
          You need at least ${CONFIG.heroicTalentClassLevelReq} levels in a class to access its
          heroic talents. Generic heroic talents are always available.</div>`;
      } else {
        html += buildHeroicPicker(eligible, `pick-heroic-${stepIndex}`);
      }
    } else {
      const ht = ABILITY_MAP[lv.heroicTalentId];
      html += `<div class="step-chosen-ability heroic-chosen">★ ${ht?.name ?? ""}
        <button class="undo-btn" data-action="undo-heroic" data-step="${stepIndex}">✕</button>
      </div>`;
    }
  }

  if (complete) {
    html += `<div class="step-complete-msg">✓ Level ${levelNum} complete. Click <em>+ Add Level</em> or export.</div>`;
  }

  return html;
}

function buildClassChooser(selectedClassId, stepIndex) {
  const playable = (DATA.classes ?? []).filter(isPlayableClass);
  const pills = playable.map(cls => {
    const count = getClassLevel(cls.id);
    const sel   = cls.id === selectedClassId ? " selected" : "";
    const label = count > 0 ? `${cls.name} (${count})` : cls.name;
    return `<button class="class-pill${sel}"
      data-action="choose-class" data-classid="${cls.id}" data-step="${stepIndex}"
    >${label}</button>`;
  }).join("");
  return `<div class="class-chooser">${pills}</div>`;
}

// ── Ability picker ────────────────────────────────────────────────────────────

// Groups by rank; used for regular ability picks.
function buildAbilityPicker(abilities, pickerId) {
  const byRank = {};
  abilities.forEach(ab => {
    const r = ab.rank ?? 0;
    (byRank[r] = byRank[r] ?? []).push(ab);
  });

  const ranks = Object.keys(byRank).map(Number).sort((a, b) => a - b);
  let html = `<div class="ability-picker" data-picker="${pickerId}">`;
  ranks.forEach(r => {
    const label    = r === 0 ? "Basic" : `Rank ${r}`;
    const badgeCls = r === 0 ? "rank-basic" : `rank-${r}`;
    html += `<div class="picker-rank-group">
      <div class="picker-rank-label"><span class="rank-badge ${badgeCls}">${label}</span></div>`;
    byRank[r].forEach(ab => { html += buildPickerCard(ab, pickerId, false); });
    html += `</div>`;
  });
  return html + `</div>`;
}

// Groups by class; used for heroic talent picks.
function buildHeroicPicker(abilities, pickerId) {
  const genericIds = new Set(CLASS_MAP["heroic"]?.abilities ?? []);
  const byClass = {};

  abilities.forEach(ab => {
    const key = genericIds.has(ab.id) ? "__generic__" : (ab.class ?? "__generic__");
    (byClass[key] = byClass[key] ?? []).push(ab);
  });

  let html = `<div class="ability-picker heroic-picker" data-picker="${pickerId}">`;

  // Generic pool first
  if (byClass["__generic__"]) {
    html += `<div class="picker-rank-group">
      <div class="picker-rank-label"><span class="rank-badge rank-heroic">Generic Heroic Talents</span></div>`;
    byClass["__generic__"].forEach(ab => { html += buildPickerCard(ab, pickerId, true); });
    html += `</div>`;
  }

  // Class-specific pools
  Object.entries(byClass).forEach(([classId, abs]) => {
    if (classId === "__generic__") return;
    const cls = CLASS_MAP[classId];
    html += `<div class="picker-rank-group">
      <div class="picker-rank-label"><span class="rank-badge rank-heroic">${cls?.name ?? classId} Heroic Talents</span></div>`;
    abs.forEach(ab => { html += buildPickerCard(ab, pickerId, true); });
    html += `</div>`;
  });

  return html + `</div>`;
}

/**
 * One ability card. `opts.selectable === false` renders a read-only card
 * (auto-granted abilities): no "Choose" button, an "Auto" marker in its place,
 * but the same caret + .ab-details expansion as a selectable card.
 */
function buildPickerCard(ab, pickerId, isHeroic, opts = {}) {
  const selectable = opts.selectable !== false;
  const cost    = ab.cost ?? "1";
  const costCls = { passive: "cost-passive", reaction: "cost-reaction", "0": "cost-free" }[cost] ?? "cost-ap";
  const costTxt = costLabel(cost);

  const focusBadge = ab.focusCost > 0 ? `<span class="focus-badge">${ab.focusCost}F</span>` : "";
  const rangeBadge = ab.range      ? `<span class="range-badge">${ab.range}</span>`          : "";

  const DISPLAY_TAGS = new Set(["heroic", "special", "limitround", "limitencounter", "limitturn"]);
  const tagsHTML = (ab.tags ?? [])
    .filter(t => !DISPLAY_TAGS.has(t))
    .map(t => {
      const tag = TAG_MAP[t];
      const tip = tag?.description ? ` title="${tag.description}"` : "";
      return `<span class="ab-tag"${tip}>${tag?.name ?? t}</span>`;
    }).join("");

  const classBadge = isHeroic && ab.class && !new Set(CLASS_MAP["heroic"]?.abilities ?? []).has(ab.id)
    ? `<span class="class-badge">${CLASS_MAP[ab.class]?.name ?? ab.class}</span>` : "";

  const details  = buildDetailsHTML(ab);
  const hasDesc  = details.length > 0;
  const children = getSpecialChildren(ab.id);

  const childHTML = children.length
    ? `<div class="picker-children">${
        children.map(c => {
          const cCostTxt = costLabel(c.cost ?? "reaction");
          return `<div class="child-ability">↳ <em>${c.name}</em>
            <span class="cost-badge ${({ passive:"cost-passive", reaction:"cost-reaction", "0":"cost-free" }[c.cost ?? "reaction"] ?? "cost-ap")}" style="font-size:0.6rem;padding:0 5px">${cCostTxt}</span>
            <span class="child-hint">(also granted)</span></div>`;
        }).join("")
      }</div>` : "";

  const actionHTML = selectable
    ? `<button class="select-btn" data-picker="${pickerId}" data-abilityid="${ab.id}">
          ${isHeroic ? "★ Choose" : "Choose"}
        </button>`
    : `<span class="auto-badge">Auto</span>`;

  return `
    <div class="picker-ability-card${selectable ? "" : " auto-granted"}">
      <div class="ab-row-header ${hasDesc ? "has-desc" : ""}">
        <span class="ab-caret">${hasDesc ? "▶" : ""}</span>
        <span class="ab-name">${ab.name}</span>
        ${classBadge}
        <span class="cost-badge ${costCls}">${costTxt}</span>
        ${focusBadge}
        ${rangeBadge}
        <span class="ab-tags">${tagsHTML}</span>
        ${actionHTML}
      </div>
      ${hasDesc  ? `<div class="ab-details" hidden>${details}</div>` : ""}
      ${childHTML}
    </div>`;
}

function buildDetailsHTML(ab) {
  const parts = [];
  if (ab.isAttack && ab.damage)
    parts.push(dRow("Damage",    ab.damage));
  if (ab.hasGraze && ab.grazeDamage)
    parts.push(dRow("Graze",     ab.grazeDamage));
  if (ab.hasResistance) {
    parts.push(dRow("Resist DV", ab.resistanceDV ?? "10"));
    if (ab.resistanceDamage)
      parts.push(dRow("Resist Dmg", ab.resistanceDamage));
  }
  if (ab.description)
    parts.push(`<div class="ab-desc">${marked.parse(ab.description)}</div>`);
  return parts.join("");
}

function dRow(label, value) {
  return `<div class="d-row"><span class="d-label">${label}</span><span>${value}</span></div>`;
}

// ── Floating ability tooltip ─────────────────────────────────────────────────
//
// A single transient panel, anchored to a summary-panel ability row, so past
// levels' abilities can be read without leaving the builder. Only one exists at
// a time; any interaction outside it dismisses it.

const TOOLTIP_GAP    = 8;    // px between the anchor row and the tooltip
const TOOLTIP_MARGIN = 8;    // px minimum clearance from the viewport edges

let tooltipEl     = null;
let tooltipAnchor = null;   // the row the visible tooltip belongs to

function buildAbilityTooltipHTML(ab) {
  const cost    = ab.cost ?? "1";
  const costCls = { passive: "cost-passive", reaction: "cost-reaction", "0": "cost-free" }[cost] ?? "cost-ap";

  const focusBadge = ab.focusCost > 0 ? `<span class="focus-badge">${ab.focusCost}F</span>` : "";
  const rangeBadge = ab.range        ? `<span class="range-badge">${ab.range}</span>`       : "";

  const tagsHTML = (ab.tags ?? []).map(t => {
    const tag = TAG_MAP[t];
    const tip = tag?.description ? ` title="${tag.description}"` : "";
    return `<span class="ab-tag"${tip}>${tag?.name ?? t}</span>`;
  }).join("");

  // Provenance: rank, and the owning class unless it's a universal innate.
  const origin = [];
  if (ab.isHeroicTalent)     origin.push("Heroic Talent");
  else if (ab.rank === 0)    origin.push("Basic");
  else if (ab.rank)          origin.push(`Rank ${ab.rank}`);
  if (ab.isInnate)           origin.push("Innate");
  if (ab.class && CLASS_MAP[ab.class]) origin.push(CLASS_MAP[ab.class].name);
  if (ab.parent && ABILITY_MAP[ab.parent])
    origin.push(`granted by ${ABILITY_MAP[ab.parent].name}`);

  const children  = getSpecialChildren(ab.id);
  const childHTML = children.length
    ? `<div class="tt-children">${
        children.map(c => `<div class="child-ability">↳ <em>${c.name}</em>
          <span class="child-hint">(${costLabel(c.cost ?? "reaction")}, also granted)</span></div>`).join("")
      }</div>`
    : "";

  const details = buildDetailsHTML(ab);

  return `
    <div class="tt-header">
      <div class="tt-name">${ab.name}</div>
      <div class="tt-badges">
        <span class="cost-badge ${costCls}">${costLabel(cost)}</span>
        ${focusBadge}
        ${rangeBadge}
        ${tagsHTML}
      </div>
      ${origin.length ? `<div class="tt-origin">${origin.join(" · ")}</div>` : ""}
    </div>
    ${details || `<div class="tt-empty">No further details recorded.</div>`}
    ${childHTML}`;
}

function showAbilityTooltip(abilityId, anchorEl) {
  const ab = ABILITY_MAP[abilityId];
  if (!ab) return;

  if (!tooltipEl) {
    tooltipEl = document.createElement("div");
    tooltipEl.id = "ability-tooltip";
    document.body.appendChild(tooltipEl);
  }

  tooltipEl.innerHTML = buildAbilityTooltipHTML(ab);
  tooltipEl.hidden    = false;
  tooltipAnchor       = anchorEl;

  positionTooltip(anchorEl);
}

// Is the tooltip currently open for this exact row?
function isTooltipOpenFor(anchorEl) {
  return !!tooltipEl && !tooltipEl.hidden && tooltipAnchor === anchorEl;
}

// position:fixed, so viewport coordinates from getBoundingClientRect apply
// directly — no scroll-offset math, and no clipping by the sidebar's overflow.
function positionTooltip(anchorEl) {
  const anchor = anchorEl.getBoundingClientRect();
  const tip    = tooltipEl.getBoundingClientRect();

  // Prefer the right of the row; flip to the left if it would overflow.
  let left = anchor.right + TOOLTIP_GAP;
  if (left + tip.width > window.innerWidth - TOOLTIP_MARGIN) {
    left = anchor.left - TOOLTIP_GAP - tip.width;
  }
  left = Math.max(TOOLTIP_MARGIN,
                  Math.min(left, window.innerWidth - tip.width - TOOLTIP_MARGIN));

  // Top-align with the row, then lift it up if it would run off the bottom.
  let top = anchor.top;
  if (top + tip.height > window.innerHeight - TOOLTIP_MARGIN) {
    top = window.innerHeight - tip.height - TOOLTIP_MARGIN;
  }
  top = Math.max(TOOLTIP_MARGIN, top);

  tooltipEl.style.left = `${left}px`;
  tooltipEl.style.top  = `${top}px`;
}

function hideAbilityTooltip() {
  if (tooltipEl) tooltipEl.hidden = true;
  tooltipAnchor = null;
}

// ── Event delegation ─────────────────────────────────────────────────────────

document.addEventListener("click", e => {
  // Interacting inside the tooltip leaves it open.
  if (e.target.closest("#ability-tooltip")) return;

  // Any other click dismisses it first; a click on a summary ability row then
  // re-opens it for that ability — unless that row's tooltip was already the
  // one showing, in which case the second click just closes it. Handled here
  // rather than with per-row listeners so it survives re-renders and can't
  // race the dismissal.
  const abRow  = e.target.closest(".summary-ability[data-ability-id]");
  const toggle = abRow && isTooltipOpenFor(abRow);
  hideAbilityTooltip();
  if (abRow) {
    if (!toggle) showAbilityTooltip(abRow.dataset.abilityId, abRow);
    return;
  }

  // Buttons with data-action
  const actionBtn = e.target.closest("button[data-action]");
  if (actionBtn) {
    handleAction(actionBtn);
    return;
  }

  // Ability "Choose" buttons
  const selBtn = e.target.closest(".select-btn[data-picker]");
  if (selBtn) {
    handleAbilityPick(selBtn.dataset.picker, selBtn.dataset.abilityid);
    return;
  }
});

function handleAction(btn) {
  const action = btn.dataset.action;

  if (action === "change-base-class") {
    jumpToStep(0);
    return;
  }

  if (action === "choose-class") {
    const classId  = btn.dataset.classid;
    const stepIdx  = Number(btn.dataset.step);
    const lv       = STATE.levels[stepIdx - 2];
    if (lv && lv.classId !== classId) {
      lv.classId       = classId;
      lv.abilityId     = null;
      lv.heroicTalentId = null;
    } else if (lv) {
      lv.classId = classId;
    }
    render();
    return;
  }

  if (action === "undo-l1-pick") {
    const slot = Number(btn.dataset.slot);
    STATE.level1Picks.splice(slot);  // remove from slot onward
    render();
    return;
  }

  if (action === "undo-ability") {
    const lv = STATE.levels[Number(btn.dataset.step) - 2];
    if (lv) { lv.abilityId = null; render(); }
    return;
  }

  if (action === "undo-heroic") {
    const lv = STATE.levels[Number(btn.dataset.step) - 2];
    if (lv) { lv.heroicTalentId = null; render(); }
    return;
  }
}

function handleAbilityPick(pickerId, abilityId) {
  if (pickerId.startsWith("pick-l1-")) {
    // Level 1 slot pick
    const slot = Number(pickerId.split("-").pop());
    if (STATE.level1Picks.length === slot) {
      STATE.level1Picks.push({ abilityId, classId: STATE.baseClassId });
    }
  } else if (pickerId.startsWith("pick-ability-")) {
    const stepIdx = Number(pickerId.replace("pick-ability-", ""));
    const lv = STATE.levels[stepIdx - 2];
    if (lv) lv.abilityId = abilityId;
  } else if (pickerId.startsWith("pick-heroic-")) {
    const stepIdx = Number(pickerId.replace("pick-heroic-", ""));
    const lv = STATE.levels[stepIdx - 2];
    if (lv) lv.heroicTalentId = abilityId;
  }
  render();
}

// ── Export ────────────────────────────────────────────────────────────────────

function exportBuild() {
  if (!(isStepComplete(0) && isStepComplete(1))) {
    alert("Complete at least level 1 before exporting.");
    return;
  }

  // Class level totals
  const classLevelMap = {};
  const countClass = id => { classLevelMap[id] = (classLevelMap[id] ?? 0) + 1; };
  countClass(STATE.baseClassId);
  STATE.levels.forEach(lv => { if (lv.classId) countClass(lv.classId); });

  const classLevels = Object.entries(classLevelMap).map(([classId, level]) => ({
    classId,
    level,
    isBase: classId === STATE.baseClassId
  }));

  // Abilities list
  const abilities = [];

  function pushAb(sourceId, classId, rank, opts = {}) {
    abilities.push({ sourceId, classId, rank, ...opts });
    getSpecialChildren(sourceId).forEach(c =>
      abilities.push({ sourceId: c.id, classId, rank: c.rank, autoGranted: true, parentId: sourceId })
    );
  }

  // Innates
  getInnateAbilities().forEach(ab => pushAb(ab.id, null, ab.rank, { autoGranted: true }));

  // Base class basics
  getBasicAbilities(STATE.baseClassId).forEach(ab =>
    pushAb(ab.id, STATE.baseClassId, 0, { autoGranted: true })
  );

  // Level 1 picks
  STATE.level1Picks.forEach(p => {
    if (!p.abilityId) return;
    const ab = ABILITY_MAP[p.abilityId];
    if (ab) pushAb(ab.id, STATE.baseClassId, ab.rank);
  });

  // Level 2+ picks
  STATE.levels.forEach(lv => {
    if (lv.abilityId) {
      const ab = ABILITY_MAP[lv.abilityId];
      if (ab) pushAb(ab.id, lv.classId, ab.rank);
    }
    if (lv.heroicTalentId) {
      const ht = ABILITY_MAP[lv.heroicTalentId];
      if (ht) pushAb(ht.id, lv.classId, ht.rank, { isHeroicTalent: true });
    }
  });

  const descriptor = {
    _format:     "shard-character-builder",
    _version:    1,
    name:        STATE.name,
    baseClassId: STATE.baseClassId,
    classLevels,
    abilities
  };

  const blob   = new Blob([JSON.stringify(descriptor, null, 2)], { type: "application/json" });
  const url    = URL.createObjectURL(blob);
  const a      = document.createElement("a");
  a.href       = url;
  a.download   = `${STATE.name.toLowerCase().replace(/\s+/g, "-")}-build.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Formatting helpers ───────────────────────────────────────────────────────

function costLabel(cost) {
  if (cost === "passive")  return "Passive";
  if (cost === "reaction") return "Reaction";
  if (cost === "0")        return "Free";
  return `${cost} AP`;
}

// ── Entry point ───────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", init);
