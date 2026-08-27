# Soliloquy Class Browser 🎲

A static site for browsing Soliloquy classes and their abilities. View classes and prepare them for export to Foundry.

## Search

The search box takes space-separated terms, ANDed together:

| Term | Matches |
|---|---|
| `guard` | free text — ability name/description, the name of one of its tags, or the class name/description |
| `tag:aura` | tag term — only the ability's tags (id or display name), partial match |
| `#aura` | shorthand for `tag:aura` |

A tag term never matches a class on its own, so `tag:aura` narrows every class
down to its aura abilities rather than listing whole classes.

**Within a class, a search filters the abilities, not just the cards.** A card
reached through its abilities shows only the matching ones: rank groups with no
match disappear, the remaining ones count `2 / 4` instead of `4`, and expanding
a rank reveals just the hits. A card reached through its *own* name or
description still shows its full ability list.

Tag chips on an ability row are clickable — clicking one adds `tag:<id>` to the
query (clicking a lit chip removes it again). The chip bar under the header
shows the active query, one removable chip per term.
