#!/bin/sh
# Copies the Foundry core icons the mockups use from a local Foundry install.
# They are Foundry's artwork, licensed for use inside Foundry, so they are not
# committed; assets/items/ is gitignored. Run once after cloning.
set -eu
APP="${FOUNDRY_APP:-/Applications/Foundry Virtual Tabletop.app/Contents/Resources/app}"
DEST="$(dirname "$0")/assets/items"
mkdir -p "$DEST"
while read -r rel; do
  [ -n "$rel" ] && cp "$APP/public/$rel" "$DEST/$(basename "$rel")"
done <<'LIST'
icons/environment/settlement/blacksmith.webp
icons/environment/settlement/sewer-entrance.webp
icons/weapons/swords/greatsword-guard.webp
icons/weapons/axes/axe-broad-black.webp
icons/weapons/polearms/javelin-flared.webp
icons/equipment/chest/breastplate-metal-scaled-grey.webp
icons/equipment/chest/breastplate-collared-steel-grey.webp
icons/equipment/shield/round-wooden-boss-steel-brown.webp
icons/tools/fasteners/nails-steel-brown.webp
icons/skills/trades/smithing-tongs-metal-red.webp
icons/weapons/daggers/dagger-straight-blue.webp
icons/sundries/lights/lantern-iron-yellow.webp
icons/equipment/finger/ring-ball-gold.webp
icons/sundries/misc/lock-bronze-reinforced.webp
icons/consumables/potions/bottle-round-corked-orante-red.webp
icons/consumables/food/berries-ration-round-red.webp
icons/equipment/chest/breastplate-scale-grey.webp
icons/environment/settlement/tavern.webp
icons/environment/settlement/tavern-tan.webp
icons/environment/settlement/house-manor.webp
icons/consumables/drinks/alcohol-beer-mug-yellow.webp
icons/consumables/drinks/wine-amphora-clay-red.webp
icons/consumables/grains/bread-loaf-boule-rustic-brown.webp
icons/consumables/food/cheese-wedge-swiss-yellow.webp
icons/consumables/food/bowl-stew-brown.webp
icons/consumables/food/bowl-ribs-meat-rice-mash-brown-white.webp
icons/magic/water/water-drop-swirl-blue.webp
icons/equipment/finger/ring-band-copper.webp
icons/environment/settlement/church.webp
icons/environment/settlement/stables-horses.webp
icons/magic/symbols/runes-star-blue.webp
icons/magic/symbols/fleur-de-lis-yellow.webp
icons/magic/light/torch-fire-orange.webp
icons/magic/perception/third-eye-blue-red.webp
icons/consumables/potions/bottle-round-empty-glass.webp
icons/sundries/survival/bedroll-brown.webp
icons/environment/settlement/farm-silo-windmill.webp
icons/environment/settlement/stable.webp
icons/commodities/treasure/figurine-camel.webp
icons/creatures/mammals/ox-bull-horned-glowing-orange.webp
icons/creatures/mammals/deer-antlers-blue.webp
icons/creatures/mammals/dog-husky-white-blue.webp
icons/magic/symbols/triangle-glowing-green.webp
icons/magic/death/skull-fire-white-yellow.webp
icons/tools/scribal/magnifying-glass.webp
LIST
echo "copied $(find "$DEST" -type f | wc -l | tr -d ' ') icons to $DEST"
