// Headless Foundry clients for the #96 spike. Each join() is a separate browser context, i.e. a separate socket.
import { chromium } from "playwright-core";

export const URL = "http://localhost:30001";
const exe = `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

export const browser = await chromium.launch({ executablePath: exe, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"] });

export async function join(userName) {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  page.on("pageerror", e => console.log(`[${userName} pageerror]`, e.message));
  await page.goto(`${URL}/join`);
  await page.fill("input[name=username]", userName);
  await page.click("button[name=join]");
  await page.waitForFunction(() => globalThis.game?.ready, null, { timeout: 60_000 });
  return page;
}

export const ev = (page, fn, arg) => page.evaluate(fn, arg);
export const show = (label, v) => console.log(`\n=== ${label}\n${JSON.stringify(v, null, 2)}`);
