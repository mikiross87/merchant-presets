/**
 * The design conformance checker's in-page half (#145): `collect` runs inside both pages, the
 * frame's export and the shop window, through Playwright's `page.evaluate`, so it uses nothing
 * from outside its own body.
 */
/* global document, getComputedStyle, Node -- `collect` runs inside the pages */

/**
 * Runs in the page: `root`, then every rendered element under it carrying `attr`, in document
 * order, as the scoring core's Node. The root is named "(frame)" on both sides, since the frame's
 * layer name ("03 Settings (GM) — Light") is no name a window could carry. An element with no box
 * (a hidden tab's), or one wholly outside an ancestor that clips it (a shelf row scrolled below
 * the fold, which the frame doesn't draw either), is left out, so it can't take a namesake's place. Boxes are from `root`'s
 * top-left; styles are computed, so both sides compare alike. Layer names are trimmed (the canvas
 * keeps a stray trailing space on some). An element's text is what it shows: its own text, a
 * field's value, or all of a rich-text block's (a description's paragraphs) when nothing inside it
 * is named; in capitals where CSS sets them.
 */
export function collect({ rootSelector, attr, iconAttr }) {
  const textOf = (el, cs) => {
    // A field shows its value, or its placeholder while empty.
    let text = el.tagName === "INPUT" ? (el.value || el.placeholder)
      : [...el.childNodes].filter(n => n.nodeType === Node.TEXT_NODE).map(n => n.textContent).join(" ");
    if (!text.trim() && el.children.length && !el.querySelector(`[${attr}]`) && !el.querySelector("svg")) text = el.textContent;
    return cs.textTransform === "uppercase" ? text.toUpperCase() : text;
  };
  const root = document.querySelector(rootSelector);
  if (!root) return { error: `no ${rootSelector}` };
  const origin = root.getBoundingClientRect();
  const clipped = el => {
    const r = el.getBoundingClientRect();
    for (let a = el.parentElement; a && a !== root.parentElement; a = a.parentElement) {
      const cs = getComputedStyle(a);
      // A clip-path inset clips too: the shelf's padding band, which scrolled rows pass under.
      const inset = /^inset\(([^)]*)\)$/.exec(cs.clipPath)?.[1].split(/\s+/).map(parseFloat);
      if (cs.overflowX === "visible" && cs.overflowY === "visible" && !inset) continue;
      const b = a.getBoundingClientRect();
      const [top = 0, right = top, bottom = top, left = right] = inset ?? [];
      const c = { top: b.top + top, right: b.right - right, bottom: b.bottom - bottom, left: b.left + left };
      if (r.bottom <= c.top || r.top >= c.bottom || r.right <= c.left || r.left >= c.right) return true;
    }
    return false;
  };
  const nodes = [root, ...[...root.querySelectorAll(`[${attr}]`)].filter(el => el.getClientRects().length > 0 && !clipped(el))];
  // An empty field shows its placeholder: measured as that text, its width and its colour.
  const placeholder = el => el.tagName === "INPUT" && !el.value && el.placeholder;
  const textWidth = (text, cs) => {
    const ctx = document.createElement("canvas").getContext("2d");
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    return ctx.measureText(text).width;
  };
  return nodes.map(el => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const shown = placeholder(el);
    const inline = el.getAttribute("style") ?? "";
    const outline = cs.outlineStyle !== "none" && parseFloat(cs.outlineWidth) > 0;
    const sets = [...inline.matchAll(/(?:^|;)\s*([a-z-]+)\s*:/g)].map(m => m[1]);
    // An icon's colour: the export fills its outlined paths; the window strokes in currentColor.
    const icon = el.getAttribute(iconAttr) || null;
    const fill = icon && el.querySelector("path")?.getAttribute("fill");
    const color = icon && fill && fill !== "none" ? fill : shown ? getComputedStyle(el, "::placeholder").color : cs.color;
    if (icon) sets.push("color");
    return {
      name: el === root ? "(frame)" : el.getAttribute(attr).trim(),
      box: { x: r.left - origin.left, y: r.top - origin.top, w: shown ? textWidth(el.placeholder, cs) : r.width, h: r.height },
      sets,
      style: {
        color, "background-color": cs.backgroundColor, "border-radius": cs.borderTopLeftRadius,
        "border-color": outline ? cs.outlineColor : cs.borderTopColor,
        "font-family": cs.fontFamily, "font-size": cs.fontSize, "font-weight": cs.fontWeight
      },
      text: textOf(el, cs),
      // Text the element hides past its edge (an ellipsis, a clamped paragraph).
      truncated: cs.overflowX !== "visible" && (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1),
      icon
    };
  });
}
