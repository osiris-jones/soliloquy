/**
 * Soliloquy NPC Browser — browser.js
 *
 * Loads source.json, categories.json and tags.json, then renders a filterable
 * NPC reference suitable for GitHub Pages. Mirrors the class-browser layout.
 *
 * Data sources (relative to index.html):
 *   source.json      — the NPC compendium export (npc-compendium-data.json)
 *   categories.json  — NPC groupings for the sidebar (edit freely)
 *   tags.json        — tag id → name/description (copy of the class source tags)
 */

const DATA_URL       = "./source.json";
const CATEGORIES_URL = "./categories.json";
const TAGS_URL       = "./tags.json";

// ── Global state ───────────────────────────────────────────────────────────

let ENTRIES     = [];     // npcClasses + npcTemplates, normalised
let CATEGORIES  = [];     // parsed categories.json (may be empty)
let TAG_MAP     = {};     // tag id → tag object
let ABILITY_MAP = {};     // ability sourceId → normalised ability

let activeCategory = null;   // null = "All NPCs"
let searchQuery    = "";

// ── Boot ────────────────────────────────────────────────────────────────────

async function init() {
  const grid = document.getElementById("class-grid");
  let data;

  try {
    const [dataResp, catResp, tagResp] = await Promise.all([
      fetch(DATA_URL),
      fetch(CATEGORIES_URL).catch(() => null),
      fetch(TAGS_URL).catch(() => null)
    ]);

    if (!dataResp.ok) throw new Error(`source.json returned HTTP ${dataResp.status}`);
    data = await dataResp.json();

    CATEGORIES = (catResp?.ok) ? (await catResp.json()) : [];
    const tags = (tagResp?.ok) ? (await tagResp.json()) : [];
    TAG_MAP    = Object.fromEntries(tags.map(t => [t.id, t]));

  } catch (err) {
    grid.innerHTML = `
      <div class="load-error">
        <strong>Could not load data.</strong><br>
        ${err.message}<br><br>
        Make sure <code>source.json</code> is in the same directory as
        <code>index.html</code> and you are serving via HTTP, not
        <code>file://</code>. Try: <code>npx serve .</code>
      </div>`;
    return;
  }

  ABILITY_MAP = Object.fromEntries(
    (data.npcAbilities ?? []).map(a => [sourceId(a), normaliseAbility(a)])
  );

  ENTRIES = [
    ...(data.npcClasses   ?? []).map(e => normaliseEntry(e, "class")),
    ...(data.npcTemplates ?? []).map(e => normaliseEntry(e, "template"))
  ];

  buildSidebar();
  render();

  document.getElementById("search").addEventListener("input", e => {
    searchQuery = e.target.value.toLowerCase().trim();
    render();
  });
}

// ── Normalisation ───────────────────────────────────────────────────────────
// The compendium stores everything under Foundry-shaped `flags.shard` /
// `system` wrappers; flatten to the shape the renderer wants.

function sourceId(doc) {
  return doc.flags?.shard?.sourceId ?? "";
}

function normaliseEntry(doc, kind) {
  const sys = doc.system ?? {};
  // Ability lists can repeat an id (Minion lists Shove twice) — dedupe while
  // preserving the compendium's ordering.
  const seen = new Set();
  const abilities = (sys._abilityIds ?? [])
    .map(ref => ref.id)
    .filter(id => !seen.has(id) && seen.add(id));

  return {
    id:          sourceId(doc),
    name:        doc.name,
    kind,                              // "class" | "template"
    description: sys.description ?? "",
    stats:       sys.stats ?? null,    // templates carry no stat block
    abilities
  };
}

function normaliseAbility(doc) {
  const sys = doc.system ?? {};
  return {
    id:               sourceId(doc),
    name:             doc.name,
    tier:             sys.tier ?? "basic",
    cost:             String(sys.cost ?? "1"),
    charged:          !!sys.charged,
    isAttack:         !!sys.isAttack,
    damage:           sys.damage ?? "",
    hasGraze:         !!sys.hasGraze,
    grazeDamage:      sys.grazeDamage ?? "",
    hasResistance:    !!sys.hasResistance,
    resistanceDamage: sys.resistanceDamage ?? "",
    range:            sys.range ?? "",
    effect:           sys.effect ?? "",   // already HTML
    tags:             sys._tagIds ?? []
  };
}

// ── Sidebar ─────────────────────────────────────────────────────────────────

function buildSidebar() {
  const sidebar = document.getElementById("sidebar");

  sidebar.querySelector('[data-cat="all"]').addEventListener("click", () => {
    setCategory(null);
  });

  CATEGORIES.forEach(cat => {
    const btn = document.createElement("button");
    btn.className   = "cat-btn";
    btn.dataset.cat = cat.id;
    btn.textContent = cat.label;
    if (cat.description) btn.title = cat.description;
    if (cat.color) btn.style.setProperty("--cat-color", cat.color);
    btn.addEventListener("click", () => setCategory(cat.id));
    sidebar.appendChild(btn);
  });

  // Anything not listed in categories.json still needs a home
  const categorizedIds = new Set(CATEGORIES.flatMap(c => c.entries ?? []));
  const hasUncategorized = ENTRIES.some(e => !categorizedIds.has(e.id));
  if (hasUncategorized && CATEGORIES.length > 0) {
    const btn = document.createElement("button");
    btn.className   = "cat-btn";
    btn.dataset.cat = "__other__";
    btn.textContent = "Other";
    btn.title = "NPCs not assigned to any category";
    btn.addEventListener("click", () => setCategory("__other__"));
    sidebar.appendChild(btn);
  }
}

function setCategory(catId) {
  activeCategory = catId;
  document.querySelectorAll(".cat-btn").forEach(btn => {
    const isMatch = catId === null
      ? btn.dataset.cat === "all"
      : btn.dataset.cat === catId;
    btn.classList.toggle("active", isMatch);
  });
  render();
}

// ── Rendering ────────────────────────────────────────────────────────────────

function render() {
  const grid    = document.getElementById("class-grid");
  const entries = filterEntries();

  grid.innerHTML = "";

  if (entries.length === 0) {
    grid.innerHTML = `<p class="no-results">No NPCs match your search.</p>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  entries.forEach(entry => fragment.appendChild(buildEntryCard(entry)));
  grid.appendChild(fragment);
}

function filterEntries() {
  let entries = ENTRIES;

  // ── Category filter ──────────────────────────────────────
  if (activeCategory !== null) {
    if (activeCategory === "__other__") {
      const categorizedIds = new Set(CATEGORIES.flatMap(c => c.entries ?? []));
      entries = entries.filter(e => !categorizedIds.has(e.id));
    } else {
      const cat = CATEGORIES.find(c => c.id === activeCategory);
      const ids = new Set(cat?.entries ?? []);
      entries = entries.filter(e => ids.has(e.id));
    }
  }

  // ── Order: follow categories.json order, then alphabetical ──
  const catOrder = new Map(
    CATEGORIES.flatMap((cat, ci) =>
      (cat.entries ?? []).map((id, li) => [id, ci * 10000 + li])
    )
  );
  entries = [...entries].sort((a, b) => {
    const oa = catOrder.get(a.id) ?? Infinity;
    const ob = catOrder.get(b.id) ?? Infinity;
    if (oa !== ob) return oa - ob;
    return a.name.localeCompare(b.name);
  });

  // ── Search filter ────────────────────────────────────────
  if (searchQuery) entries = entries.filter(entryMatchesSearch);

  return entries;
}

function entryMatchesSearch(entry) {
  const q = searchQuery;
  if (entry.name.toLowerCase().includes(q))        return true;
  if (entry.description.toLowerCase().includes(q)) return true;
  return entry.abilities.some(id => {
    const ab = ABILITY_MAP[id];
    if (!ab) return false;
    return ab.name.toLowerCase().includes(q)
        || stripHTML(ab.effect).toLowerCase().includes(q);
  });
}

// ── NPC Card ──────────────────────────────────────────────────────────────────

function buildEntryCard(entry) {
  const card = document.createElement("article");
  card.className     = "class-card";
  card.dataset.npcId = entry.id;

  const cat = CATEGORIES.find(c => (c.entries ?? []).includes(entry.id));

  card.innerHTML = `
    ${buildCardHeader(entry, cat)}
    ${entry.stats ? buildNpcStats(entry.stats) : ""}
    ${buildDesc(entry.description)}
    <div class="card-abilities">
      ${buildAllTierGroups(entry)}
    </div>`;

  card.querySelectorAll(".rank-group-header").forEach(header => {
    header.addEventListener("click", () => toggleTierGroup(header.parentElement));
  });

  card.querySelectorAll(".ability-row.has-details").forEach(row => {
    row.addEventListener("click", () => toggleAbilityRow(row));
  });

  return card;
}

function buildCardHeader(entry, cat) {
  const badge = cat
    ? `<span class="cat-badge" ${cat.color ? `style="--cat-color:${cat.color}"` : ""}>${cat.label}</span>`
    : "";
  return `
    <header class="card-header">
      <h2 class="class-name">${entry.name}</h2>
      ${badge}
    </header>`;
}

function buildNpcStats(s) {
  // hpBonus is the extra HP the NPC gains per tier as it scales up.
  const hp = s.hpBonus
    ? `${s.hp ?? "—"} <span class="stat-sub">+${s.hpBonus}/tier</span>`
    : `${s.hp ?? "—"}`;
  return `
    <div class="class-stats">
      <span class="stat hp" title="Base HP (plus bonus per tier)">&#9829; ${hp}</span>
      <span class="stat"    title="Defense">DEF ${s.def   ?? "—"}</span>
      <span class="stat"    title="Speed">SPD ${s.spd     ?? "—"}</span>
      <span class="stat"    title="Armor">Armor ${s.armor ?? 0}</span>
    </div>`;
}

function buildDesc(description) {
  if (!description) return "";
  return `<div class="class-desc">${description}</div>`;
}

// ── Ability grouping ──────────────────────────────────────────────────────────
// NPC abilities carry a tier of "basic" (always available) or "optional"
// (picked when building the NPC), so group on that rather than on rank.

const TIER_ORDER = ["basic", "optional"];

function buildAllTierGroups(entry) {
  const abilities = entry.abilities.map(id => ABILITY_MAP[id]).filter(Boolean);

  if (abilities.length === 0) {
    return `<p class="no-abilities">No abilities defined.</p>`;
  }

  const byTier = {};
  abilities.forEach(ab => (byTier[ab.tier] = byTier[ab.tier] ?? []).push(ab));

  const tiers = Object.keys(byTier).sort((a, b) => {
    const oa = TIER_ORDER.indexOf(a), ob = TIER_ORDER.indexOf(b);
    return (oa < 0 ? 99 : oa) - (ob < 0 ? 99 : ob);
  });

  return tiers.map(t => buildTierGroup(t, byTier[t])).join("");
}

function buildTierGroup(tier, abilities) {
  const isBasic = tier === "basic";
  const label   = isBasic ? "Basic" : tier.charAt(0).toUpperCase() + tier.slice(1);
  const hint    = isBasic ? "always available"
                : tier === "optional" ? "chosen at creation" : "";

  const rows = abilities.map(buildAbilityRow).join("");

  return `
    <div class="rank-group${isBasic ? "" : " rank-group-optional"}">
      <div class="rank-group-header">
        <span class="caret">&#9654;</span>
        <span class="rank-badge ${isBasic ? "rank-basic" : "rank-optional"}">${label}</span>
        ${hint ? `<span class="rank-hint">${hint}</span>` : ""}
        <span class="rank-count">${abilities.length}</span>
      </div>
      <div class="rank-abilities" hidden>${rows}</div>
    </div>`;
}

// ── Ability Row ───────────────────────────────────────────────────────────────

function buildAbilityRow(ab) {
  const costCls  = { passive: "cost-passive", reaction: "cost-reaction", "0": "cost-free" }[ab.cost] ?? "cost-ap";
  const costText = costLabel(ab.cost);

  const chargedBadge = ab.charged
    ? `<span class="charged-badge" title="Charged action">&#9889;</span>` : "";

  const rangeBadge = ab.range
    ? `<span class="range-badge">${ab.range}</span>` : "";

  const tagsHTML = ab.tags.map(tid => {
    const tag = TAG_MAP[tid];
    const tip = tag?.description ? ` title="${escapeAttr(plainText(tag.description))}"` : "";
    return `<span class="ab-tag"${tip}>${tag?.name ?? tid}</span>`;
  }).join("");

  const detailHTML = buildAbilityDetails(ab);
  const hasDetails = detailHTML.length > 0;

  return `
    <div class="ability-row ${hasDetails ? "has-details" : ""}">
      <span class="ab-caret">${hasDetails ? "&#9654;" : ""}</span>
      <span class="ab-name">${displayName(ab.name)}</span>
      <span class="cost-badge ${costCls}">${costText}</span>
      ${chargedBadge}
      ${rangeBadge}
      <span class="ab-tags">${tagsHTML}</span>
    </div>
    ${hasDetails ? `<div class="ability-details" hidden>${detailHTML}</div>` : ""}`;
}

function buildAbilityDetails(ab) {
  const parts = [];

  if (ab.isAttack && ab.damage)      parts.push(detailRow("Damage", ab.damage));
  if (ab.hasGraze && ab.grazeDamage) parts.push(detailRow("Graze", ab.grazeDamage));
  if (ab.hasResistance && ab.resistanceDamage)
                                     parts.push(detailRow("Resist Dmg", ab.resistanceDamage));
  if (ab.effect)                     parts.push(`<div class="ab-desc">${ab.effect}</div>`);

  return parts.join("");
}

function detailRow(label, value) {
  return `<div class="d-row"><span class="d-label">${label}</span>${value}</div>`;
}

// ── Toggle helpers ────────────────────────────────────────────────────────────

function toggleTierGroup(group) {
  const isOpen = group.classList.contains("open");
  group.classList.toggle("open", !isOpen);
  group.querySelector(".rank-abilities").hidden = isOpen;
  group.querySelector(".caret").innerHTML = isOpen ? "&#9654;" : "&#9660;";
}

function toggleAbilityRow(row) {
  const details = row.nextElementSibling;
  if (!details?.classList.contains("ability-details")) return;
  const isOpen = !details.hidden;
  details.hidden = isOpen;
  row.querySelector(".ab-caret").innerHTML = isOpen ? "&#9654;" : "&#9660;";
}

// ── Formatting ─────────────────────────────────────────────────────────────

function costLabel(cost) {
  if (cost === "passive")  return "Passive";
  if (cost === "reaction") return "Reaction";
  if (cost === "0")        return "Free";
  return `${cost} AP`;
}

// Ability names are stored prefixed with their owner ("Minion: Shove"); the
// card header already says who owns them.
function displayName(name) {
  const i = name.indexOf(": ");
  return i > -1 ? name.slice(i + 2) : name;
}

function stripHTML(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent ?? "";
}

// Tag descriptions are Markdown, but tooltips can't render it — drop the
// emphasis markers rather than showing raw asterisks.
function plainText(md) {
  return md.replace(/\*\*|\*|__|_/g, "").replace(/\s+/g, " ").trim();
}

function escapeAttr(str) {
  return str.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

// ── Entry point ────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", init);
