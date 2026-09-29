/**
 * The design conformance checker's scoring (#145): how a rendered shop window is compared with a
 * shop.pen frame, node by node. The browser half (collecting boxes and styles) is live-only; this is
 * the half that decides pass or fail.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { checksFor, deltaE2000, pairNodes, parseColor, scoreFrame } from "./design-check.mjs";

test("colours parse from the forms a browser's computed style gives", () => {
  assert.deepEqual(parseColor("rgb(241, 235, 232)"), { r: 241, g: 235, b: 232, a: 1 });
  assert.deepEqual(parseColor("rgba(0, 0, 0, 0.25)"), { r: 0, g: 0, b: 0, a: 0.25 });
  assert.deepEqual(parseColor("#9f9275"), { r: 159, g: 146, b: 117, a: 1 });
  assert.deepEqual(parseColor("#00000040"), { r: 0, g: 0, b: 0, a: 64 / 255 });
  assert.equal(parseColor("transparent").a, 0);
  assert.equal(parseColor("nonsense"), null);
});

test("ΔE2000 is 0 for one colour and grows with the difference (Sharma's reference pairs)", () => {
  const c = { r: 120, g: 30, b: 40, a: 1 };
  assert.equal(deltaE2000(c, c), 0);
  assert.ok(deltaE2000({ r: 0, g: 0, b: 0, a: 1 }, { r: 255, g: 255, b: 255, a: 1 }) > 99);
  // Off by one step in one channel is well under the 2 the check allows.
  assert.ok(deltaE2000({ r: 159, g: 146, b: 117, a: 1 }, { r: 160, g: 146, b: 117, a: 1 }) < 0.5);
  // A different brand red is not.
  assert.ok(deltaE2000({ r: 122, g: 28, b: 40, a: 1 }, { r: 150, g: 30, b: 40, a: 1 }) > 2);
});

const node = (name, over = {}) => ({ name, box: { x: 0, y: 0, w: 10, h: 10 }, sets: [], style: {}, text: "", icon: null, ...over });

test("design nodes pair with app elements by layer name, in document order", () => {
  const design = [node("Row"), node("Name"), node("Row"), node("Name"), node("Only in design")];
  const app = [node("Name"), node("Row"), node("Row"), node("Name"), node("Only in app")];
  const pairs = pairNodes(design, app);
  assert.deepEqual(pairs.map(p => [p.design.name, p.index, p.app?.name ?? null]), [
    ["Row", 0, "Row"], ["Name", 0, "Name"], ["Row", 1, "Row"], ["Name", 1, "Name"], ["Only in design", 0, null]
  ]);
  // The app's first "Name" is paired with the design's first, whatever sits between them.
  assert.equal(pairs[1].app, app[0]);
});

test("a node is checked only on what the design sets on it", () => {
  const text = node("Title", { text: "Armourer & Blacksmith", sets: ["color", "font-family", "font-size", "font-weight"] });
  assert.deepEqual(checksFor(text), ["exists", "x", "y", "w", "h", "text", "color", "font-family", "font-size", "font-weight"]);
  const panel = node("Card", { sets: ["background-color", "border-radius", "outline"] });
  assert.deepEqual(checksFor(panel), ["exists", "x", "y", "w", "h", "background-color", "border-radius", "border-color"]);
  const icon = node("Chip icon", { icon: "scale", sets: ["color"] });
  assert.deepEqual(checksFor(icon), ["exists", "x", "y", "w", "h", "icon", "color"]);
});

test("the score is checks passed over checks, and each failure names the node, the check and both values", () => {
  const design = [
    node("Title", { box: { x: 10, y: 5, w: 100, h: 20 }, text: "Settings", sets: ["color", "font-size"],
      style: { color: "rgb(25, 24, 19)", "font-size": "13px" } }),
    node("Card", { box: { x: 0, y: 40, w: 420, h: 48 }, sets: ["background-color"], style: { "background-color": "rgb(255, 255, 255)" } }),
    node("Missing", { box: { x: 0, y: 0, w: 5, h: 5 } })
  ];
  const app = [
    node("Title", { box: { x: 11, y: 5, w: 101.5, h: 20 }, text: "Settings", style: { color: "rgb(25, 24, 19)", "font-size": "13px" } }),
    node("Card", { box: { x: 0, y: 44, w: 420, h: 48 }, style: { "background-color": "rgba(0, 0, 0, 0)" } })
  ];
  const result = scoreFrame(pairNodes(design, app));
  // Title 8/8; Card: y off by 4 and no fill, 4/6; Missing: exists fails and nothing else can be checked, 0/5.
  assert.equal(result.total, 8 + 6 + 5);
  assert.equal(result.passed, 8 + 4);
  assert.equal(result.score, 12 / 19);
  assert.deepEqual(result.failures.find(f => f.check === "y"), { node: "Card", index: 0, check: "y", expected: 40, actual: 44 });
  assert.ok(result.failures.some(f => f.node === "Card" && f.check === "background-color"));
  assert.equal(result.failures.filter(f => f.node === "Missing").length, 5);
});

test("text compares trimmed and with runs of space collapsed, and a true minus is not a hyphen", () => {
  const d = node("Badge", { text: "Buying −10%", sets: [] });
  assert.equal(scoreFrame(pairNodes([d], [node("Badge", { text: "  Buying   −10% " })])).failures.length, 0);
  assert.equal(scoreFrame(pairNodes([d], [node("Badge", { text: "Buying -10%" })])).failures[0].check, "text");
});

test("text a window cuts off matches a design that draws the cut: its start, then an ellipsis (#151)", () => {
  const score = (design, app, truncated) => scoreFrame(pairNodes([node("(frame)"), node("Name", { text: design })],
    [node("(frame)"), node("Name", { text: app, truncated })])).failures;
  const full = "Protection from Evil and Good";
  assert.deepEqual(score("Protection from Evil and G…", full, true), []);
  // Paragraphs that run on have no space between them in the window's text.
  assert.deepEqual(score("to carry. Spellcasting here…", "to carry.Spellcasting here draws on the divine lists.", true), []);
  // Only where the window really cuts it, and only a true start of it.
  assert.equal(score("Protection from Evil and G…", full, false).length, 1);
  assert.equal(score("Protection from Good…", full, true).length, 1);
  assert.equal(score("Protection", full, true).length, 1, "no ellipsis, no cut");
});
