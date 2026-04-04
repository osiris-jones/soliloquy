/**
 * Shard Class Browser — browser.js
 *
 * Loads source.json and categories.json, then renders a filterable
 * class reference suitable for GitHub Pages.
 *
 * Data sources (relative to index.html):
 *   source.json      — the Shard compendium source (copy from system root)
 *   categories.json  — class groupings for the sidebar (edit freely)
 */

const DATA_URL       = "./source.json";
const CATEGORIES_URL = "./categories.json";

// ── Global state ───────────────────────────────────────────────────────────

let DATA        = null;   // parsed source.json
let CATEGORIES  = [];     // parsed categories.json (may be empty)
let TAG_MAP     = {};     // tag id → tag object
let ABILITY_MAP = {};     // ability id → ability object

let activeCategory = null;   // null = "All Classes"
let searchQuery    = "";

// ── Boot ────────────────────────────────────────────────────────────────────

async function init() {
  const grid = document.getElementById("class-grid");

  try {
    // Fetch both files in parallel; categories.json is optional
    const [dataResp, catResp] = await Promise.all([
      fetch(DATA_URL),
      fetch(CATEGORIES_URL).catch(() => null)
    ]);

    if (!dataResp.ok) throw new Error(`source.json returned HTTP ${dataResp.status}`);
    DATA = await dataResp.json();

    CATEGORIES = (catResp?.ok) ? (await catResp.json()) : [];

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

  // Build fast-lookup maps
  TAG_MAP     = Object.fromEntries((DATA.tags      ?? []).map(t => [t.id, t]));
  ABILITY_MAP = Object.fromEntries((DATA.abilities ?? []).map(a => [a.id, a]));

  buildSidebar();
  render();

  document.getElementById("search").addEventListener("input", e => {
    searchQuery = e.target.value.toLowerCase().trim();
    render();
  });
}

// ── Sidebar ─────────────────────────────────────────────────────────────────

function buildSidebar() {
  const sidebar = document.getElementById("sidebar");

  // Wire up the pre-existing "All Classes" button
  sidebar.querySelector('[data-cat="all"]').addEventListener("click", () => {
    setCategory(null);
  });

  // One button per defined category
  CATEGORIES.forEach(cat => {
    const btn = document.createElement("button");
    btn.className  = "cat-btn";
    btn.dataset.cat = cat.id;
    btn.textContent = cat.label;
    if (cat.description) btn.title = cat.description;
    if (cat.color) btn.style.setProperty("--cat-color", cat.color);
    btn.addEventListener("click", () => setCategory(cat.id));
    sidebar.appendChild(btn);
  });

  // If any classes fall outside all categories, offer an "Other" bucket
  const categorizedIds = new Set(CATEGORIES.flatMap(c => c.classes ?? []));
  const hasUncategorized = (DATA.classes ?? []).some(c => !categorizedIds.has(c.id));
  if (hasUncategorized && CATEGORIES.length > 0) {
    const btn = document.createElement("button");
    btn.className   = "cat-btn";
    btn.dataset.cat = "__other__";
    btn.textContent = "Other";
    btn.title = "Classes not assigned to any category";
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
  const classes = filterClasses();

  grid.innerHTML = "";

  if (classes.length === 0) {
    grid.innerHTML = `<p class="no-results">No classes match your search.</p>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  classes.forEach(cls => fragment.appendChild(buildClassCard(cls)));
  grid.appendChild(fragment);
}

function filterClasses() {
  let classes = DATA.classes ?? [];

  // ── Category filter ──────────────────────────────────────
  if (activeCategory !== null) {
    if (activeCategory === "__other__") {
      const categorizedIds = new Set(CATEGORIES.flatMap(c => c.classes ?? []));
      classes = classes.filter(c => !categorizedIds.has(c.id));
    } else {
      const cat = CATEGORIES.find(c => c.id === activeCategory);
      const ids = new Set(cat?.classes ?? []);
      classes = classes.filter(c => ids.has(c.id));
    }
  }

  // ── Order: follow categories.json order, then alphabetical ──
  const catOrder = new Map(
    CATEGORIES.flatMap((cat, ci) =>
      (cat.classes ?? []).map((id, li) => [id, ci * 10000 + li])
    )
  );
  classes = [...classes].sort((a, b) => {
    const oa = catOrder.get(a.id) ?? Infinity;
    const ob = catOrder.get(b.id) ?? Infinity;
    if (oa !== ob) return oa - ob;
    return a.name.localeCompare(b.name);
  });

  // ── Search filter ────────────────────────────────────────
  if (searchQuery) {
    classes = classes.filter(cls => classMatchesSearch(cls));
  }

  return classes;
}

function classMatchesSearch(cls) {
  const q = searchQuery;
  if (cls.name.toLowerCase().includes(q))        return true;
  if ((cls.description ?? "").toLowerCase().includes(q)) return true;
  return (cls.abilities ?? []).some(id => {
    const ab = ABILITY_MAP[id];
    if (!ab) return false;
    return ab.name.toLowerCase().includes(q)
        || (ab.description ?? "").toLowerCase().includes(q);
  });
}

// ── Class Card ────────────────────────────────────────────────────────────────

function buildClassCard(cls) {
  const card = document.createElement("article");
  card.className    = "class-card";
  card.dataset.classId = cls.id;

  // Category metadata for this class
  const cat = CATEGORIES.find(c => (c.classes ?? []).includes(cls.id));

  card.innerHTML = `
    ${buildCardHeader(cls, cat)}
    ${buildClassStats(cls.stats ?? {})}
    ${buildClassDesc(cls.description)}
    <div class="card-abilities">
      ${buildAllRankGroups(cls)}
    </div>`;

  // Wire up rank group toggles
  card.querySelectorAll(".rank-group-header").forEach(header => {
    header.addEventListener("click", () => toggleRankGroup(header.parentElement));
  });

  // Wire up ability row toggles
  card.querySelectorAll(".ability-row.has-details").forEach(row => {
    row.addEventListener("click", () => toggleAbilityRow(row));
  });

  return card;
}

function buildCardHeader(cls, cat) {
  const badge = cat
    ? `<span class="cat-badge" ${cat.color ? `style="--cat-color:${cat.color}"` : ""}>${cat.label}</span>`
    : "";
  return `
    <header class="card-header">
      <h2 class="class-name">${cls.name}</h2>
      ${badge}
    </header>`;
}

function buildClassStats(s) {
  return `
    <div class="class-stats">
      <span class="stat hp"    title="Max HP">&#9829; ${s.maxHP   ?? "—"}</span>
      <span class="stat"       title="ATK die">ATK ${s.atk        ?? "—"}</span>
      <span class="stat"       title="MAG die">MAG ${s.mag        ?? "—"}</span>
      <span class="stat"       title="Defense">DEF ${s.def        ?? "—"}</span>
      <span class="stat"       title="Speed">SPD ${s.spd          ?? "—"}</span>
      <span class="stat"       title="Armor">Armor ${s.armor      ?? 0}</span>
      <span class="stat"       title="Focus Pool">Focus ${s.focusPool ?? 0}</span>
    </div>`;
}

function buildClassDesc(description) {
  if (!description) return "";
  return `<div class="class-desc">${marked.parse(description)}</div>`;
}

function buildAllRankGroups(cls) {
  const abilityIds = cls.abilities ?? [];
  const abilities  = abilityIds.map(id => ABILITY_MAP[id]).filter(Boolean);

  if (abilities.length === 0) {
    return `<p class="no-abilities">No abilities defined.</p>`;
  }

  // Separate heroic talents from regular abilities
  const heroicAbilities  = abilities.filter(ab => ab.isHeroicTalent);
  const regularAbilities = abilities.filter(ab => !ab.isHeroicTalent);

  // Group regular abilities by rank
  const byRank = {};
  regularAbilities.forEach(ab => {
    const r = ab.rank ?? 0;
    (byRank[r] = byRank[r] ?? []).push(ab);
  });

  const ranks    = Object.keys(byRank).map(Number).sort((a, b) => a - b);
  const sections = [];
  let heroicPlaced = false;

  for (const r of ranks) {
    sections.push(buildRankGroup(r, byRank[r]));
    // Heroic section goes immediately after Basic (rank 0); if there are no
    // basics it goes before the first ranked group instead.
    if (!heroicPlaced && r === 0) {
      sections.push(buildHeroicGroup(heroicAbilities));
      heroicPlaced = true;
    }
  }

  // No rank-0 basics — place the heroic section before rank 1.
  if (!heroicPlaced) {
    sections.unshift(buildHeroicGroup(heroicAbilities));
  }

  return sections.join("");
}

function buildHeroicGroup(abilities) {
  const rows = abilities.length
    ? abilities.map(buildAbilityRow).join("")
    : `<p class="no-abilities">No heroic talents defined yet.</p>`;
  return `
    <div class="rank-group rank-group-heroic">
      <div class="rank-group-header">
        <span class="caret">&#9654;</span>
        <span class="rank-badge rank-heroic">Heroic Talent</span>
        <span class="rank-hint">every 4th level</span>
        <span class="rank-count">${abilities.length}</span>
      </div>
      <div class="rank-abilities" hidden>${rows}</div>
    </div>`;
}

function buildRankGroup(rank, abilities) {
  const isBasic  = rank === 0;
  const label    = isBasic ? "Basic" : `Rank ${rank}`;
  const badgeCls = isBasic ? "rank-basic" : `rank-${rank}`;

  const rows = abilities.map(buildAbilityRow).join("");

  return `
    <div class="rank-group">
      <div class="rank-group-header">
        <span class="caret">&#9654;</span>
        <span class="rank-badge ${badgeCls}">${label}</span>
        ${isBasic ? '<span class="rank-hint">auto-granted</span>' : ""}
        <span class="rank-count">${abilities.length}</span>
      </div>
      <div class="rank-abilities" hidden>${rows}</div>
    </div>`;
}

// ── Ability Row ───────────────────────────────────────────────────────────────

function buildAbilityRow(ab) {
  const cost      = ab.cost ?? "1";
  const costCls   = { passive: "cost-passive", reaction: "cost-reaction", "0": "cost-free" }[cost] ?? "cost-ap";
  const costText  = costLabel(cost);

  const focusBadge = (ab.focusCost > 0)
    ? `<span class="focus-badge">${ab.focusCost}F</span>` : "";

  const rangeBadge = ab.range
    ? `<span class="range-badge">${ab.range}</span>` : "";

  const tagsHTML = (ab.tags ?? [])
    .map(tid => {
      const tag = TAG_MAP[tid];
      const tip = tag?.description ? ` title="${tag.description}"` : "";
      return `<span class="ab-tag"${tip}>${tag?.name ?? tid}</span>`;
    })
    .join("");

  const detailHTML = buildAbilityDetails(ab);
  const hasDetails = detailHTML.length > 0;

  return `
    <div class="ability-row ${hasDetails ? "has-details" : ""}">
      <span class="ab-caret">${hasDetails ? "&#9654;" : ""}</span>
      <span class="ab-name">${ab.name}</span>
      <span class="cost-badge ${costCls}">${costText}</span>
      ${focusBadge}
      ${rangeBadge}
      <span class="ab-tags">${tagsHTML}</span>
    </div>
    ${hasDetails ? `<div class="ability-details" hidden>${detailHTML}</div>` : ""}`;
}

function buildAbilityDetails(ab) {
  const parts = [];

  if (ab.isAttack && ab.damage)
    parts.push(detailRow("Damage", ab.damage));
  if (ab.hasGraze && ab.grazeDamage)
    parts.push(detailRow("Graze", ab.grazeDamage));
  if (ab.hasResistance) {
    parts.push(detailRow("Resist DV", ab.resistanceDV));
    if (ab.resistanceDamage)
      parts.push(detailRow("Resist Dmg", ab.resistanceDamage));
  }
  if (ab.description)
    parts.push(`<div class="ab-desc">${marked.parse(ab.description)}</div>`);

  return parts.join("");
}

function detailRow(label, value) {
  return `<div class="d-row"><span class="d-label">${label}</span>${value}</div>`;
}

// ── Toggle helpers ────────────────────────────────────────────────────────────

function toggleRankGroup(group) {
  const isOpen  = group.classList.contains("open");
  const body    = group.querySelector(".rank-abilities");
  const caret   = group.querySelector(".caret");
  group.classList.toggle("open", !isOpen);
  body.hidden       = isOpen;
  caret.innerHTML   = isOpen ? "&#9654;" : "&#9660;";
}

function toggleAbilityRow(row) {
  const details = row.nextElementSibling;
  if (!details?.classList.contains("ability-details")) return;
  const isOpen  = !details.hidden;
  details.hidden           = isOpen;
  row.querySelector(".ab-caret").innerHTML = isOpen ? "&#9654;" : "&#9660;";
}

// ── Formatting ─────────────────────────────────────────────────────────────

function costLabel(cost) {
  if (cost === "passive")  return "Passive";
  if (cost === "reaction") return "Reaction";
  if (cost === "0")        return "Free";
  return `${cost} AP`;
}

// ── Entry point ────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", init);
