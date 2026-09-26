/**
 * The approved frames of design/shop.pen that the shop window is checked against (#145), and for
 * each the fixture state that reproduces it: who is logged in, the theme, the window's size, and
 * `open`, an in-page function (run as that user, as a string) that opens the shop window in the
 * frame's state and returns its application id. A frame without `open` has no fixture yet and is
 * skipped by tools/design-check-run.mjs.
 *
 * Exports are regenerated from the canvas with the Pencil MCP:
 *   Export([id], "html-css", "design/export/<id>.html", {includeLayerIds: true, includeLayerNames: true})
 */

const frame = (name, theme, width, height, user = "Gamemaster") => ({ name, theme, width, height, user, open: null });

export const FRAMES = {
  y6iNf: frame("01 Storefront — Light", "light", 920, 680),
  wvmqF: frame("01 Storefront — Dark", "dark", 920, 680),
  zie5W: frame("01 Storefront — Player (Light)", "light", 920, 680, "P1"),
  ChoNd: frame("01 Terms of Trade — Popover (Light)", "light", 340, 251),
  S0ugn: frame("01 Terms of Trade — Popover (Dark)", "dark", 340, 251),
  TGXBN: frame("02 Sell — Light", "light", 920, 680),
  BZh1r: frame("02 Sell — Dark", "dark", 920, 680),
  v8ap9: frame("03 Settings (GM) — Light", "light", 920, 760),
  dpdpS: frame("03 Settings (GM) — Dark", "dark", 920, 760),
  aaJcp: frame("03 Settings (GM) · Restock — Light", "light", 920, 760),
  dVt0a: frame("03 Settings (GM) · Restock — Dark", "dark", 920, 760),
  x9IX9: frame("04 Closed — Light", "light", 920, 680),
  nnHdO: frame("04 Closed — Dark", "dark", 920, 680),
  mRg3y: frame("05 Inn — Light", "light", 920, 680),
  lvVv2: frame("05 Inn — Dark", "dark", 920, 680),
  r7HIUl: frame("06 Storefront — Narrow (Light)", "light", 480, 780),
  grlFX: frame("06 Storefront — Narrow (Dark)", "dark", 480, 780),
  n9I5aQ: frame("07 Buyer Picker — Light", "light", 656, 430),
  JNHkU: frame("07 Buyer Picker — Dark", "dark", 656, 430),
  z5RBkd: frame("07 Trade Chat Card — Light", "light", 688, 387),
  b4iPYc: frame("07 Trade Chat Card — Dark", "dark", 688, 387),
  WNYhA: frame("08 Trade States — Light", "light", 1900, 755),
  mWJYP: frame("08 Trade States — Dark", "dark", 1900, 755)
};
