// save-trimmed.js
// Usage: node save-trimmed.js session24.json gemini-session-6.json https://gemini.google.com/app
const { chromium } = require("playwright");
const fs = require("fs");
const readline = require("readline");

const inFile = process.argv[2];
const outFile = process.argv[3];
const url = process.argv[4] || "about:blank";

if (!inFile || !outFile) {
  console.log("Use: node save-trimmed.js <input.json> <output.json> [url]");
  process.exit(1);
}

(async () => {
  const browser = await chromium.launch({ headless: false });
  const ctx = await browser.newContext({ storageState: inFile });
  const page = await ctx.newPage();
  await page.goto(url);

  console.log("Browser খুলেছে। দরকারি কাজ শেষে ফিরে এসে এখানে Enter চাপ।");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  await new Promise((r) => rl.question("", r));
  rl.close();

  // পুরো state নেই, তারপর শুধু google.com-related cookie/origin রাখি
  const full = await ctx.storageState();
  const isGoogle = (host) =>
    /\.?google\.com$|\.?gstatic\.com$|\.?googleusercontent\.com$/.test(host);

  const trimmed = {
    cookies: (full.cookies || []).filter((c) =>
      isGoogle(c.domain.replace(/^\./, "")),
    ),
    origins: (full.origins || []).filter((o) =>
      isGoogle(new URL(o.origin).hostname),
    ),
  };

  fs.writeFileSync(outFile, JSON.stringify(trimmed, null, 2));
  console.log(
    `Cookies: ${trimmed.cookies.length}, Origins: ${trimmed.origins.length}`,
  );
  console.log(`Saved (trimmed): ${outFile}`);

  await browser.close();
  process.exit(0);
})();
