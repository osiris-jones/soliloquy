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
let searchQuery    = "";  // raw text from the search box
let searchTerms    = [];  // parsed query — see parseQuery()

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

  const searchBox = document.getElementById("search");
  searchBox.addEventListener("input", e => {
    setSearch(e.target.value);
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
  const results = filterClasses();

  grid.innerHTML = "";

  if (results.length === 0) {
    grid.innerHTML = `<p class="no-results">No classes match your search.</p>`;
    return;
  }

  const fragment = document.createDocumentFragment();
  results.forEach(res => fragment.appendChild(buildClassCard(res)));
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
  // Each surviving class carries its own search result so the card can
  // render only the abilities that matched.
  return classes
    .map(cls => searchClass(cls))
    .filter(res => res.visible);
}

// ── Search ──────────────────────────────────────────────────────────────────
//
// The query is a space-separated list of terms, ANDed together:
//
//   guard            free text — ability name, description, class name/desc,
//                    or the name of one of the ability's tags
//   tag:spell        tag term — matches only against the ability's tags
//   #spell           shorthand for tag:spell
//
// A tag term never matches a class by itself, so `tag:aura` narrows every
// class down to its aura abilities rather than showing whole classes.

function setSearch(raw) {
  searchQuery = raw.toLowerCase().trim();
  searchTerms = parseQuery(searchQuery);
  renderQueryChips();
  render();
}

function parseQuery(q) {
  return q
    .split(/\s+/)
    .filter(Boolean)
    .map(tok => {
      if (tok.startsWith("tag:")) return { kind: "tag",  value: tok.slice(4) };
      if (tok.startsWith("#"))    return { kind: "tag",  value: tok.slice(1) };
      return                             { kind: "text", value: tok };
    })
    .filter(t => t.value.length > 0);
}

/** Tag ids + names for one ability, lowercased, for matching. */
function abilityTagText(ab) {
  return (ab.tags ?? []).flatMap(tid => [
    tid.toLowerCase(),
    (TAG_MAP[tid]?.name ?? "").toLowerCase()
  ]);
}

function abilityMatchesTerm(ab, term) {
  const tagText = abilityTagText(ab);
  if (term.kind === "tag") {
    return tagText.some(t => t.includes(term.value));
  }
  return ab.name.toLowerCase().includes(term.value)
      || (ab.description ?? "").toLowerCase().includes(term.value)
      || tagText.some(t => t.includes(term.value));
}

function abilityMatchesSearch(ab) {
  return searchTerms.every(term => abilityMatchesTerm(ab, term));
}

/**
 * A class matches on its own name/description only when every term is free
 * text — a tag term describes an ability, never a class.
 */
function classMatchesSearch(cls) {
  if (searchTerms.some(t => t.kind === "tag")) return false;
  const hay = `${cls.name} ${cls.description ?? ""}`.toLowerCase();
  return searchTerms.every(t => hay.includes(t.value));
}

/**
 * Resolve a class against the active query.
 *
 *   { cls, visible, abilities, filtered, matchCount, totalCount }
 *
 * `abilities` is what the card should render: the matching subset when the
 * class was reached through its abilities, the full list when the class
 * itself matched (or when there is no query at all).
 */
function searchClass(cls) {
  const abilities = (cls.abilities ?? [])
    .map(id => ABILITY_MAP[id])
    .filter(Boolean);

  const base = { cls, visible: true, abilities, filtered: false,
                 matchCount: abilities.length, totalCount: abilities.length };

  if (searchTerms.length === 0) return base;

  const hits = abilities.filter(abilityMatchesSearch);
  if (hits.length > 0) {
    return { cls, visible: true, abilities: hits, filtered: true,
             matchCount: hits.length, totalCount: abilities.length };
  }

  // No ability hit — the class survives only if it matched by name/description,
  // and then it shows everything it has.
  if (classMatchesSearch(cls)) return base;

  return { cls, visible: false };
}

// ── Class Card ────────────────────────────────────────────────────────────────

function buildClassCard(res) {
  const cls  = res.cls;
  const card = document.createElement("article");
  card.className    = "class-card";
  card.dataset.classId = cls.id;
  card.classList.toggle("is-filtered", !!res.filtered);

  // Category metadata for this class
  const cat = CATEGORIES.find(c => (c.classes ?? []).includes(cls.id));

  card.innerHTML = `
    ${buildCardHeader(cls, cat)}
    ${buildClassStats(cls.stats ?? {})}
    ${buildClassDesc(cls.description)}
    ${buildFilterNote(res)}
    <div class="card-abilities">
      ${buildAllRankGroups(res)}
    </div>`;

  // Wire up rank group toggles
  card.querySelectorAll(".rank-group-header").forEach(header => {
    header.addEventListener("click", () => toggleRankGroup(header.parentElement));
  });

  // Wire up ability row toggles
  card.querySelectorAll(".ability-row.has-details").forEach(row => {
    row.addEventListener("click", () => toggleAbilityRow(row));
  });

  // Tag chips are search shortcuts — clicking one adds it to the query.
  card.querySelectorAll(".ab-tag[data-tag-id]").forEach(chip => {
    chip.addEventListener("click", e => {
      e.stopPropagation();      // don't toggle the ability row underneath
      addTagTerm(chip.dataset.tagId);
    });
  });

  return card;
}

/** "Showing 3 of 21 abilities" banner, only while a query is narrowing the card. */
function buildFilterNote(res) {
  if (!res.filtered) return "";
  return `
    <div class="card-filter-note">
      Showing ${res.matchCount} of ${res.totalCount} abilities
    </div>`;
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

function buildAllRankGroups(res) {
  const cls       = res.cls;
  const abilities = res.abilities;

  // Full roster, used for the "n of m" counts on a filtered card.
  const allAbilities = (cls.abilities ?? [])
    .map(id => ABILITY_MAP[id])
    .filter(Boolean);

  if (allAbilities.length === 0) {
    return `<p class="no-abilities">No abilities defined.</p>`;
  }

  const bucket = list => {
    const heroic = list.filter(ab => ab.isHeroicTalent);
    const byRank = {};
    list.filter(ab => !ab.isHeroicTalent).forEach(ab => {
      const r = ab.rank ?? 0;
      (byRank[r] = byRank[r] ?? []).push(ab);
    });
    return { heroic, byRank };
  };

  const shown = bucket(abilities);      // what the query left standing
  const total = bucket(allAbilities);   // what the class actually has

  // Ranks come from the full roster so a filtered card keeps its shape; empty
  // groups are dropped further down.
  const ranks    = Object.keys(total.byRank).map(Number).sort((a, b) => a - b);
  const sections = [];
  let heroicPlaced = false;

  const pushHeroic = () => {
    sections.push(buildHeroicGroup(
      shown.heroic, total.heroic.length, res.filtered
    ));
    heroicPlaced = true;
  };

  for (const r of ranks) {
    sections.push(buildRankGroup(
      r, shown.byRank[r] ?? [], total.byRank[r].length, res.filtered
    ));
    // Heroic section goes immediately after Basic (rank 0); if there are no
    // basics it goes before the first ranked group instead.
    if (!heroicPlaced && r === 0) pushHeroic();
  }

  // No rank-0 basics — place the heroic section before rank 1.
  if (!heroicPlaced) {
    sections.unshift(buildHeroicGroup(
      shown.heroic, total.heroic.length, res.filtered
    ));
  }

  const html = sections.filter(Boolean).join("");
  return html || `<p class="no-abilities">No abilities match your search.</p>`;
}

/**
 * A rank group's body holds only `abilities` — the matching subset while a
 * query is active — so expanding a rank during a search reveals just the hits.
 * `total` is the unfiltered size, shown alongside as "2 / 7". Groups with no
 * matches are dropped from a filtered card entirely (return "").
 */
function buildRankGroupShell({ groupCls, badgeCls, label, hint, abilities, total, filtered }) {
  if (filtered && abilities.length === 0) return "";

  const rows = abilities.length
    ? abilities.map(buildAbilityRow).join("")
    : `<p class="no-abilities">${hint.empty}</p>`;

  const count = filtered
    ? `<span class="rank-count is-filtered">${abilities.length} / ${total}</span>`
    : `<span class="rank-count">${total}</span>`;

  return `
    <div class="rank-group ${groupCls}">
      <div class="rank-group-header">
        <span class="caret">&#9654;</span>
        <span class="rank-badge ${badgeCls}">${label}</span>
        ${hint.text ? `<span class="rank-hint">${hint.text}</span>` : ""}
        ${count}
      </div>
      <div class="rank-abilities" hidden>${rows}</div>
    </div>`;
}

function buildHeroicGroup(abilities, total, filtered) {
  return buildRankGroupShell({
    groupCls: "rank-group-heroic",
    badgeCls: "rank-heroic",
    label:    "Heroic Talent",
    hint:     { text: "every 4th level", empty: "No heroic talents defined yet." },
    abilities, total, filtered
  });
}

function buildRankGroup(rank, abilities, total, filtered) {
  const isBasic = rank === 0;
  return buildRankGroupShell({
    groupCls: "",
    badgeCls: isBasic ? "rank-basic" : `rank-${rank}`,
    label:    isBasic ? "Basic" : `Rank ${rank}`,
    hint:     { text: isBasic ? "auto-granted" : "", empty: "No abilities defined." },
    abilities, total, filtered
  });
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
      const hit = tagMatchesQuery(tid) ? " is-hit" : "";
      return `<span class="ab-tag${hit}" data-tag-id="${tid}"${tip}>${tag?.name ?? tid}</span>`;
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

// ── Tag search UI ──────────────────────────────────────────────────────────

/** True when an active tag term targets this tag id — used to light up chips. */
function tagMatchesQuery(tagId) {
  const name = (TAG_MAP[tagId]?.name ?? "").toLowerCase();
  const id   = tagId.toLowerCase();
  return searchTerms.some(t =>
    t.kind === "tag" && (id.includes(t.value) || name.includes(t.value))
  );
}

/** Clicking a tag chip appends `tag:<id>` to the query (or removes it again). */
function addTagTerm(tagId) {
  const term    = `tag:${tagId.toLowerCase()}`;
  const present = searchTerms.some(t => t.kind === "tag" && t.value === tagId.toLowerCase());

  const rest = searchQuery
    .split(/\s+/)
    .filter(Boolean)
    .filter(tok => tok !== term && tok !== `#${tagId.toLowerCase()}`);

  const next = present ? rest.join(" ") : [...rest, term].join(" ");
  applySearch(next);
}

function removeTerm(raw) {
  const next = searchQuery
    .split(/\s+/)
    .filter(Boolean)
    .filter(tok => tok !== raw)
    .join(" ");
  applySearch(next);
}

/** Push a query into the search box and re-render. */
function applySearch(next) {
  const box = document.getElementById("search");
  box.value = next;
  setSearch(next);
}

/** Renders the active query as removable chips under the top bar. */
function renderQueryChips() {
  const bar = document.getElementById("query-chips");
  if (!bar) return;

  const raw = searchQuery.split(/\s+/).filter(Boolean);
  if (raw.length === 0) {
    bar.innerHTML = "";
    bar.hidden = true;
    return;
  }

  bar.hidden = false;
  bar.innerHTML = raw.map((tok, i) => {
    const term  = searchTerms[i];
    const isTag = term?.kind === "tag";
    const label = isTag
      ? (TAG_MAP[term.value]?.name ?? term.value)
      : tok;
    return `
      <button class="query-chip ${isTag ? "query-chip-tag" : ""}" data-term="${tok}">
        ${isTag ? "#" : ""}${label}
        <span class="query-chip-x">&times;</span>
      </button>`;
  }).join("") + `<button class="query-chip query-chip-clear" data-clear="1">Clear all</button>`;

  bar.querySelectorAll("[data-term]").forEach(chip => {
    chip.addEventListener("click", () => removeTerm(chip.dataset.term));
  });
  bar.querySelector("[data-clear]")?.addEventListener("click", () => applySearch(""));
}

// ── Entry point ────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", init);
