# Shard Class Browser

A static site for browsing Shard classes and their abilities. No build step required — deploy directly to GitHub Pages.

---

## Setup

### 1. Copy source data

The browser reads `source.json` from its own directory. Copy it from the system root each time you update content:

```bash
# macOS / Linux
cp ../source.json ./source.json

# Windows (PowerShell)
Copy-Item ..\source.json .\source.json
```

### 2. Serve locally

Browsers block `fetch()` over `file://`, so you need a local HTTP server during development:

```bash
npx serve .
# or: python -m http.server 8080
# or: VS Code Live Server extension
```

Then open `http://localhost:3000` (or whichever port is shown).

---

## Deploying to GitHub Pages

1. Push this directory to a GitHub repository (or include it as a folder in a repo).
2. Go to **Settings → Pages** and set the source to the branch and folder containing `index.html`.
3. Make sure `source.json` is committed alongside the other files.

The browser has no server-side dependencies — it's entirely static.

---

## Customizing Categories

Edit `categories.json` to define how classes are grouped in the sidebar:

```json
[
  {
    "id": "martial",
    "label": "Martial",
    "description": "Shown as a tooltip on the sidebar button.",
    "color": "#7a3500",
    "classes": ["warrior", "fighter", "ranger"]
  },
  {
    "id": "arcane",
    "label": "Arcane",
    "description": "Spellcasting classes.",
    "color": "#3d2b8a",
    "classes": ["mage", "sorcerer"]
  },
  {
    "id": "support",
    "label": "Support",
    "color": "#1a5a6b",
    "classes": ["cleric", "bard"]
  }
]
```

| Field | Required | Purpose |
|-------|----------|---------|
| `id` | Yes | Internal identifier (must be unique) |
| `label` | Yes | Display name shown in the sidebar and on class cards |
| `description` | No | Tooltip text on the sidebar button |
| `color` | No | CSS color for the category badge and sidebar highlight |
| `classes` | Yes | List of class `id` values from `source.json` |

**Category ordering** — classes appear in the order they are listed in each category's `classes` array, and categories appear in the order they appear in `categories.json`.

**Uncategorized classes** — any class whose `id` does not appear in any category's `classes` array is still visible under "All Classes" and gets its own "Other" sidebar entry (only shown when at least one category is defined).

**No categories** — if `categories.json` is empty (`[]`) or missing, all classes are shown as a flat list with no sidebar filtering.

---

## Updating Content

After editing `source.json` (or running the tools pipeline):

```bash
cp ../source.json ./source.json
```

Refresh the browser. No rebuild needed.

---

## File Structure

```
class-browser/
├── index.html        Main page
├── style.css         All styles (Shard color palette)
├── browser.js        Data loading, filtering, rendering
├── categories.json   Class groupings — edit this freely
├── source.json       Copy of system source data (not checked in by default)
└── README.md         This file
```
