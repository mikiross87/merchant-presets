# Shop design (#109)

`shop.pen` is the design for the 2.0 shop window and its trade flows. Open it in [Pencil](https://pencil.dev). #103 builds against this file and this README. The file is the spec; changes to the design happen here first, then in code.

`design/` is excluded from `module.zip`.

## Canvas layout

Frames sit on a grid, numbered by band, and the layer order matches it. Light variants go in the left column (x 800), dark in the next (x 1800), further variants to the right, with at least 80 px between columns (the columns keep their x even beside the narrower 480 px frames) and 120 px between bands. Keep new screens on the grid.

| Band | Frames |
|---|---|
| 00 | Components: the reusable parts and the price states. Window Parts sits above the light column (x 760), over the screens that use it |
| 01 | Storefront — Light / Dark / Player (Light); Terms of Trade popover, light and dark |
| 02 | Sell — Light / Dark |
| 03 | Settings (GM) — Light / Dark; Settings (GM) · Restock — Light / Dark |
| 04 | Closed — Light / Dark |
| 05 | Inn — Light / Dark |
| 06 | Storefront — Narrow (Light) / (Dark) |
| 07 | Buyer Picker and Trade Chat Card, light and dark |
| 08 | Trade States boards, light and dark |
| X | Explore lane: ideas, not agreed design (see below) |

A new agreed screen goes in the next band (09, at y 6405) and gets a row here.

Every window mockup except **01 Storefront — Player (Light)** draws the GM's window (the popover, picker, chat card and trade-state frames draw no window): three tabs, the third badged `GM`, and the NPC sheet button in the window bar. That one frame draws the same window as a player gets it, with two tabs and no NPC sheet button.

**Edit the light frames only.** Each light frame is a reusable master. Every dark frame is an instance of its light frame with the theme set to dark, and the Player storefront is an instance of **01 Storefront — Light** with the Settings tab and the NPC sheet button switched off. An edit to a light frame reaches its dark twin and the player view on its own. That's why the screens show up in Pencil's component list beside the parts in band 00. A new screen follows the same pattern: build the light frame, mark it reusable, and add the dark frame as an instance with `theme: {mode: "dark"}`.

The six 920 px screens draw their window bar, hero and tabs as instances of the **Window Parts** components, and every Bill of Sale draws its heading from **Slip Head**. A screen overrides only what differs: its active tab, the Inn's name and portrait, the Closed chip, or the slip's kicker. The narrow screen's header is built differently and stays its own drawing.

### Explore lane

Ideas and rough mocks go in the **Explore** lane, starting at x 4800, to the right of every band. Nothing there is agreed design, and #103 doesn't build from it.

- **Place:** level with the band the idea explores, so it reads beside the screen it challenges.
- **Name:** `X<band> <Screen> · <idea> (#issue)`, e.g. `X02 Sell · Haggle (#112)`.
- **Build:** light only, not reusable. Start from a detached copy of the master: its contents as a plain frame, not an instance, so you can add and remove nodes. Through Pencil's `execute` API that's `Insert(document, Get(masterId))` with `reusable` and `id` removed. Its window parts stay live instances.
- **Accepted:** move it into its band (or the next new one), make it a reusable master with a dark instance, and write the decision here.
- **Rejected:** delete the frame and record why under the relevant section's "Rejected" list. Git history keeps the drawing.

Draw explorations on their own branch, so a PR of agreed design doesn't carry half-finished ideas.

## Source of truth

The shop sits beside dnd5e's own sheets, so its tokens are dnd5e's, measured from the installed stylesheets. The design does not invent a palette.

- dnd5e **6.0.5** `dnd5e.css`: the `@scope (.theme-light)` and `@scope (.theme-dark)` blocks, plus `:root`.
- Foundry **14.368** `public/css/foundry2.css`: text and status colours.

| Design token | Light | Dark | Build with (CSS variable) |
|---|---|---|---|
| `surface-app` | `#f1ebe8` parchment | `#0d0b0b` (+ denim texture) | `--dnd5e-application-background` |
| `surface-card` | `#ffffff` | `#252830` | `--dnd5e-background-card` |
| `surface-row-alt` | `#f1ebe8` | `#212329` | `--dnd5e-color-table-row-even` |
| `text-primary` | `#191813` | `#ffffff` | `--color-text-primary` |
| `text-secondary` | `#666666` | `#999999` | `--color-text-secondary` |
| `text-title` | `#191813` | `#9f9275` | `--color-text-title` |
| `accent-gold` | `#9f9275` | `#9f9275` | `--dnd5e-color-gold` |
| `border` | `#9f9275` | `#242731` | `--dnd5e-border-gold` |
| `border-faint` | `#bbbbbb` | `#434857` | `--dnd5e-border-dotted` |
| `header-1` / `header-2` | `#401f25` / `#741b2b` | `#491d25` / `#311b1f` | `--dnd5e-card-header-1/2` |
| `success` | `#26b231` | `#26b231` | `--color-level-success` |
| `warning` | `#ee9b3a` | `#ee9b3a` | `--color-level-warning` |
| `danger` | `#ce0707` | `#ce0707` | `--color-level-error` |
| `text-on-dark` | `#ffffff` | `#ffffff` | `--color-text-light-0` |
| `text-on-dark-muted` | `#c9c7b8` | `#c9c7b8` | `--color-text-light-heading` |
| `accent-on-dark` | `#e3ce9e` | `#e3ce9e` | `--dnd5e-color-gold` under `.dnd5e-flag-high-contrast` only |
| `text-on-dark-soft` | `#efe6d8` | `#efe6d8` | `--color-light-2` |
| `seal-mark` | `#e7d1b1` | `#e7d1b1` | `--color-light-3` |

Notes:

- The three `on-dark` tokens (`text-on-dark`, `text-on-dark-muted`, `accent-on-dark`) colour text and icons on fills that are dark in both themes: the maroon header and its chips, the chat card's strip, the primary and seal buttons, the `GM` badge, and selected pills and rows. Shapes and translucent tints still carry their hex values.
- dnd5e only defines `#e3ce9e` in its high-contrast sheet, so the build needs a module variable for `accent-on-dark`.
- `text-on-dark-soft` (the shop description) and `seal-mark` (the wax seal's mark) were drawn as `#e8dcd6` and `#f3dcb0`, which have no source. Decided 2026-09-25 (#125): snap both to the nearest Foundry colour. Foundry's sci-fi theme overrides `--color-light-2/3` with blues. The standard light and dark themes don't.
- The light app background is a paper texture over parchment, and the dark one is a denim texture over `#0d0b0b`. Both textures are transparent overlays, so the mockups use the base colours. The build uses the variable, which brings the texture with it.
- `surface-row-alt` in dark is `color-mix(in oklab, #252830, black 10%)`, rounded.

## Typography

| Role | Font | Build with |
|---|---|---|
| Titles, shop name, section headers | Modesto Condensed (Foundry core ships it; dnd5e's fallback is Palatino) | `--dnd5e-font-modesto` |
| Body, item names | Roboto | `--dnd5e-font-roboto` |
| Prices, quantities, compact labels | Roboto Condensed | `--dnd5e-font-roboto-condensed` |
| The ledger hand (`font-slip`): the Bill of Sale's lines and date, footnotes, and plain readings such as "½ of value" | Crimson Pro, italic | A module `@font-face`: the module bundles it |

Neither Foundry nor dnd5e ships Crimson Pro. Decided 2026-09-25 (#125): the module bundles it (SIL OFL 1.1, so the licence ships with the font files) rather than substituting. Foundry's Amiri has no italic, and dnd5e's Roboto Slab is upright, so either would lose the ledger hand.

Pencil only offers Google Fonts, so the mockups draw titles in **Alegreya SC Bold**. It was picked by comparison with a render of Foundry's own `modesto-condensed-bold.woff2`. It's wider than Modesto, so allow for the build's titles to come out narrower than the mockups.

## Coins

Prices show coin glyphs, not "12.5 gp". The glyphs are dnd5e's `icons/currency/{copper,silver,electrum,gold,platinum}.webp`, by mikiko.art under **CC BY-NC-SA 4.0**.

- The build reads each coin's icon and conversion rate from `CONFIG.DND5E.currencies` (#101), so homebrew currencies work and the art is loaded from dnd5e, never bundled.
- `design/assets/` holds copies for the mockups only; attribution as above.

## The merchant is the NPC

Decided 2026-09-24: **the shop is the NPC actor, nothing more.** Import the Apothecary and that NPC is the shop: its name is the title, its image is the portrait, its coins are the till. A GM who wants a person behind the counter renames the NPC and gives it a portrait. There is no separate shopkeeper and no module actor type.

- **Title:** the actor's name. A trailing size tier such as "(Town)" moves out of the title into its own chip.
- **Voice: impersonal, always.** "Buys at ½ of value", "Won't buy food", "You receive", "The till holds 212 gp". Never a pronoun, and never the actor's name as a speaker, so the text stays right however the GM renames the shop.

Rejected:
- A linked shopkeeper NPC. Chosen briefly, then dropped by the owner: renaming the NPC covers it, with no links to maintain.
- A module-defined "Shop" actor type. dnd5e's items and currency expect dnd5e's own actor types, and it would force a world migration.

## Opening the shop (#104)

The shop window **is the NPC's sheet**. It's registered as an actor sheet (never the default), and each shop sets itself to use it (`flags.core.sheetClass`). Core's own double-click, the sidebar and the token HUD all open it, with no patching.

- **Players** need Limited permission, because core only opens a sheet on double-click for Limited or above. The GM tab's **"Players can visit"** switch sets it; off hides the shop entirely.
- **GM:** the same window plus the Settings tab. An **NPC sheet** button in the window bar opens dnd5e's own sheet for stats.

## Buying as (#103)

The purse panel in the header reads **BUYING AS · Aria ▾** above the coins. The picker lists:

- **player:** only the actors this user owns, each with its purse total ("Fighter 5 · 78 gp 5 sp"); actors with no currency are dimmed ("no purse"). The assigned character is the default.
- **GM:** a search field, then player characters, then other actors. Coins come from, and goods go to, whoever is picked.

## Item and shop images

The mockups use the real `img` of each good and each shop (`merchantImage`). Those are Foundry core icons, licensed for use inside Foundry, so they aren't committed. Run `design/fetch-icons.sh` once after cloning; it copies them from a local Foundry install into the gitignored `design/assets/items/`. Without it, the rows show empty icon frames.

## The Bill of Sale (basket)

The basket is a **Bill of Sale**: a parchment slip with ledger lines, dotted leaders, a double rule over the sum, and a wax-seal button ("Seal the bargain · 30 gp"). The same slip turns around on the Sell tab: "She buys", "She pays you".

- Each line: quantity × name, the line total in coins, then the unit price and a stepper.
- Under the sum: the buyer's purse after the bargain, so nobody has to do coin arithmetic.
- The heading shows the world date and time of day, from the world clock.
- Idea, not yet decided: the slip's name could follow the shop kind, such as "Your tab" at an inn or tavern and "Offering" at a temple.

## Terms of trade

Prices on screen **always include the shop's terms**. Terms show in three places, from general to specific:

1. **Header chip**, e.g. "Sells at list · Buys at ½". This is the shop-wide rule (`buyPriceModifier` / `sellPriceModifier`). It opens the Terms of Trade panel.
2. **Terms of Trade panel:** the sell and buy rates with a worked example, any category overrides (Valuables at full value), and what the merchant won't buy (from its item filters). Every line comes from the shop's data. Nothing is flavour-invented.
3. **The row:** only when an item's price differs from its list price. The list price is struck through above the adjusted one, with a tag:
   - amber `+25%` for a markup
   - green `−10%` for a discount
   - green `Full value` for a category override
   - neutral `per 10` for a bundle (`quantityForPrice`)
   - neutral `½` on the Sell tab, where every row shows the offer ratio

   A shop-wide markup is not struck on every row. The chip carries it, so the list doesn't turn into a wall of strikethroughs. Rows are struck only when their price differs from what the chip says.

On the Sell tab, a side card states the ratio ("She pays ½ of value") and how much of the merchant's purse is left, since a finite purse caps a sale. Items the merchant won't take are listed separately with the reason ("Won't buy food") rather than hidden.

Prices that come out fractional show in mixed coins, e.g. 10 gp at +25% is 12 gp 5 sp. The rounding rule itself is #101's.

## GM Settings tab (#110, #111)

A third tab, **Settings**, marked with a `GM` badge. Only GMs see it. Players' clients never receive the shop's config.

- **Left:** the sections: Terms, Deals, Won't buy, Hours, Restock. "Reset to preset" sits at the bottom.
- **Terms:** "Sells at" and "Buys at" as percentages, each with its plain reading ("list price", "½ of value") and a "World default" box. A live example underneath ("Longsword (15 gp) sells for 15 gp · buys back for 7 gp 5 sp") recomputes as the GM types. Category rules are listed here, with "+ Add rule".
- **Deals:** one card per character, holding the adjustment tag (green), the GM's note, the end ("Until the shop closes", "No end"), and edit and delete. The footer states the cap: no deal can make selling pay more than buying.
- **Right, "Players see":** a live preview. "Everyone" shows the terms chip and a sample row. "Only Aria" shows a deal as that character sees it: the chip reads "Your price −10%", and the row shows the list price struck through with a `−10%` tag (15 gp → 13 gp 5 sp).
- World-wide defaults (rates, trade chat mode) stay in Foundry's Configure Settings.

## Restock (#105)

Restocking is **on by default and runs on a schedule per shop**. A restock replaces only the goods it drew itself; goods the GM added by hand stay.

- **GM (Settings → Restock):**
  - the stock table (for the Town smith: 49 goods, each at a rolled quantity such as 2d6+4)
  - **Restocks every N days when the shop opens.** A dropdown plus quick pills: Daily · 3 days · 7 days · 14 days · Dice… (e.g. 1d4+2) · Never. Underneath, the preset default ("Town smith: 7 days (Village: 14)").
  - what a restock does: **Re-roll the shelf** (the default) or **Top up** (only drawn goods that sold out come back)
  - the till refill (800 gp for the Town smith)
  - the last and next restock ("Next: 21 Mirtul at 7:00, in 7 days")
  - **Restock now**
- **Players:**
  - a "Fresh stock today" chip beside the shop name, and a **New** badge on goods that were sold out before the restock; both clear at closing
  - the closed card shows the next restock date

Preset schedules by trade are listed on #105. Days follow the world calendar, not calendar weeks.

## Services and unidentified items

- **Services** (the Inn mockup, with the real Town inn data): meals and lodging rows carry a neutral `Service` tag, and "Always" in place of a stock count. Free goods (Water) show "Free" in green. On the Bill of Sale, a service line has an icon and a short note beside its stepper: "Feeds Aria" for meals, "From tonight" for a room, where the stepper counts nights.
- **Unidentified items** (Sell tab, #102): listed under "Won't buy" as **Unidentified Ring · The Arcane Store casts Identify for 150 gp.**, with "Unidentified" in the warning colour. No offer is ever shown.

## Trade states

The Bill of Sale carries the whole trade. The "Trade States" board shows it in each state; the Sell tab mirrors each one.

| State | The slip shows | The seal button |
|---|---|---|
| Sealing | ledger dimmed, steppers inert | "Counting coin…" with a spinner, disabled |
| Sealed | a red "SEALED" stamp with the date; "Paid"; the purse as it is now; what landed in the pack | replaced by "Keep shopping" |
| Can't afford | the sum in red; "Aria is short by 346 gp 5 sp" instead of the purse-after line | "Not enough coin", disabled |
| No GM connected | an amber notice: trades run on the GM's client, and the bill is kept until one connects | "Waiting for a GM", disabled |
| Till too low (selling) | the sum in red; a red notice: "The till holds 40 gp…"; no purse-after line | "The till can't cover this", disabled |
| Stock changed | an amber notice at the top; the sold-out line struck and dimmed; the sum recomputed | active, with the new sum |

A disabled seal always says why, in the button itself. The slip never shows a purse-after figure for a trade that can't happen.

**Closed:** the stock stays visible but dimmed, with no add buttons. The slip becomes a "Shutters are down" card showing when it opens ("Opens at 7:00, in about 4 hours") and the hours table (open, close, restock).

## Trade chat card

A 300 px message in the chat log, in the same parchment. It has:

- the shop as speaker (image, name, in-world date)
- a visibility pill: "Public" or "GM only"
- a maroon strip: "Aria bought" or "Aria sold"
- one line per item: icon, "qty × name", coins
- a rule, then "Paid" or "Received" with the total
- a footnote: "Exact change, counted from Aria's coins." or "At ½ of value. The till holds 154 gp 5 sp."

The world setting from #102 chooses off, GM only or public.

## Window sizes

- Shop window: 920 × 680 by default; the GM Settings tab asks for 760 tall. Columns: 180 (categories or sections), flexible (stock or form), 280 (slip or preview).
- **Narrow (below about 760 px; drawn at 480 px):**
  - the header shrinks to portrait, name and short chips; the description moves behind an info button
  - the buyer and the purse move to a strip under the header
  - the category column becomes a dropdown
  - rows already on the bill show a filled check instead of "+"
  - the Bill of Sale docks at the bottom as a summary bar (the lines as text, the sum, an expand chevron) with the seal button always visible

## Components

Reusable in `shop.pen` (the Components frame):

- Coin Price: amount plus coin glyph
- Button Primary (maroon)
- Button Secondary
- Quantity Stepper
- Item Row: art, name, meta, stock, a price block with an optional struck list price, a terms tag and a second coin, and an add button
- Slip Head: the Bill of Sale's kicker, title and date

Reusable in the Window Parts frame:

- Window Bar: title, the NPC sheet button and close
- Hero: portrait, name with the "Fresh stock today" chip, description, the chips row, and the purse panel
- Tabs: Buy, Sell and Settings with its `GM` badge; Buy active

The rest of the window (category nav, the Bill of Sale's lines, notices, the Terms popover, the Settings form, the chat card) is built from these and the tokens above.

## Motion

Short, and only where something changed hands.

- **Adding to the bill:** the new line slides in and fades in over 150 ms. The sum counts up over 300 ms.
- **Sealing:** on press, the wax seal presses down (scale 0.92, 120 ms). While the GM's client answers, the spinner turns. On success, the SEALED stamp lands (scale 1.3 → 1, rotation 20° → 14°, 180 ms, ease-out). The purse figures count to their new values over 400 ms.
- **Stock changed:** the struck line flashes amber once, over 400 ms.
- **`prefers-reduced-motion`:** all of the above become instant state changes. The spinner becomes the static "Counting coin…" text.

