# Soliloquy NPC Browser 👹

A static site for browsing Soliloquy NPC classes, templates, and their abilities.
Same layout and styling as the Class Browser.

## Files

| File | Purpose |
| --- | --- |
| `source.json` | Copy of `npc-compendium-data.json` from the repo root |
| `categories.json` | Sidebar groupings (`entries` lists `flags.shard.sourceId` values) |
| `tags.json` | Tag id → name/description, copied from `class-browser/source.json` |

Serve over HTTP (`npx serve .`) — `fetch` will not read the JSON over `file://`.

To refresh the data: `cp ../npc-compendium-data.json source.json`
