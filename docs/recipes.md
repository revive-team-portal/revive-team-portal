# Recipes — `/recipes/`

**Purpose:** Cafe recipe manager: ingredients with costs, recipes with ingredient lines and method steps, printable development sheet.

**Who uses it:** Kitchen leads + admins (portal grant `recipes`).

## Key features
- Ingredient library (cost, unit)
- Recipes with ingredient lines, method steps, costing
- Recipe development sheet print
- AI helper via `ai-proxy`
- Meals (combining recipes) — built but never used (0 rows)

## Data
Revive Apps schema `recipes`: `ingredients`, `recipes`, `recipe_ingredients`, `recipe_steps`, `meals`, `meal_components`.

## Functions
`recipes-session` (signs browser into `recipes-app@` shared account), `ai-proxy`.

## Programming points (keep future changes consistent)
- LEGACY pattern: browser reads/writes tables directly under a shared login (policies `USING(true)`). Don't add new tables this way — add a `recipes-data.js` action instead.
- On edit, load everything you save (a partial load once wiped recipe steps).
- Distinct from Production's Wopples recipes (versioned, costed per pack) — don't merge casually.

## Open items / review notes (Sep 2026)
- Meals tab unused: hide or delete.
- Candidate to move to the function-only pattern (medium job).
