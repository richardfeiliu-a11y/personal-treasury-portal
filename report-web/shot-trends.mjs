import { chromium } from "playwright";

const browser = await chromium.launch({ headless: true });

async function capture(path, { width, height, dark }) {
  const context = await browser.newContext({
    viewport: { width, height },
    colorScheme: dark ? "dark" : "light",
  });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:4173/trends", { waitUntil: "networkidle", timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path, fullPage: true, animations: "disabled" });
  await context.close();
  console.log("Saved:", path);
}

const VIEWPORTS = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "mobile-390x844", width: 390, height: 844 },
];

const THEMES = [
  { name: "light", dark: false },
  { name: "dark", dark: true },
];

for (const vp of VIEWPORTS) {
  for (const theme of THEMES) {
    const file = "screenshots/trends-" + vp.name + "-" + theme.name + ".png";
    await capture(file, { width: vp.width, height: vp.height, dark: theme.dark });
  }
}

await browser.close();
