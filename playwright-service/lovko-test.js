/**
 * Lovko Chat test (runs on YOUR PC, not on GitHub).
 * Every run opens a brand-new browser profile, so Lovko sees a fresh guest each time.
 * The picture is NOT saved with a download button: it is taken from the page's network traffic
 * (any answer that really is a picture, even if the server calls it something else) or from the <img> itself.
 *
 *   node lovko-test.js photo.jpg "make the background white" --pre "Images"   -> automatic try
 *   node lovko-test.js --manual                                               -> you click by hand, the script only records
 *
 * Optional: --pre "Images"  (button text(s) to click first, comma separated)
 *           --input "<css selector of the text box>"  --send "<css selector of the send button>"
 *           --file-input "<css selector of the file input>"  --close (close the browser at the end)
 * Results are saved in the folder  lovko-out  next to this file.
 */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const readline = require("readline");

const OUT = path.join(__dirname, "lovko-out");
const URL = "https://lovko.chat/chat/";
const WAIT_MS = Number(process.env.LOVKO_WAIT_MS || 150000);
const MIN_IMAGE_BYTES = 15000;
// Used when you do not type a prompt: white studio background + polo t-shirt + straight, front-facing pose.
const STUDIO_PROMPT =
  "Turn this photo into a professional studio portrait. Keep the person's face, hairstyle, skin tone and expression exactly the same, do not change the face. " +
  "Replace the background with a plain pure white studio background. Dress the person in a plain polo t-shirt with a collar. " +
  "Make the pose straight and front-facing like a formal studio photo: head upright, shoulders level, looking straight at the camera, centered, chest-up framing, soft even studio lighting.";
const DEFAULT_INPUT = 'textarea, [contenteditable="true"], input[type="text"], input:not([type])';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const opt = (name, def = "") => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : def;
};
const positional = args.filter((a, i) => !a.startsWith("--") && !(args[i - 1] || "").startsWith("--"));
const imagePath = positional[0] ? path.resolve(positional[0]) : "";
const prompt = positional[1] || "";
const MANUAL = flag("manual");

// Shows how long every step takes:  [seconds since start | seconds since the previous step]
const T0 = Date.now();
let lastT = T0;
const step = (label) => {
  const now = Date.now();
  console.log(`  [${((now - T0) / 1000).toFixed(1)}s | +${((now - lastT) / 1000).toFixed(1)}s] ${label}`);
  lastT = now;
};

const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitEnter = (msg) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(msg, () => { rl.close(); resolve(); });
  });

// Looks at the first bytes: is this really a picture? (the server's content-type can be wrong)
function sniff(buf) {
  if (!buf || buf.length < 12) return "";
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf.slice(0, 4).toString() === "RIFF" && buf.slice(8, 12).toString() === "WEBP") return "image/webp";
  if (buf.slice(0, 4).toString() === "GIF8") return "image/gif";
  return "";
}
const extOf = (type) => (type.includes("png") ? "png" : type.includes("webp") ? "webp" : type.includes("gif") ? "gif" : "jpg");

async function launch() {
  try {
    return await chromium.launch({ channel: "chrome", headless: false });
  } catch (error) {
    console.log("Google Chrome not found, using the bundled Chromium instead:", String(error.message).split("\n")[0]);
    return await chromium.launch({ headless: false });
  }
}

// Lists the buttons / text boxes of the page, so we can see what Lovko offers.
async function dumpUi(page) {
  return page.evaluate(() => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
    };
    const nodes = Array.from(
      document.querySelectorAll('textarea, input, [contenteditable="true"], button, [role="button"], a, select, label'),
    );
    return nodes.slice(0, 250).map((el) => ({
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type") || "",
      text: (el.innerText || el.value || "").trim().slice(0, 60),
      aria: el.getAttribute("aria-label") || "",
      title: el.getAttribute("title") || "",
      placeholder: el.getAttribute("placeholder") || "",
      id: el.id || "",
      cls: (el.className && String(el.className).slice(0, 70)) || "",
      visible: visible(el),
    }));
  });
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (!MANUAL && imagePath && !fs.existsSync(imagePath)) throw new Error(`Image not found: ${imagePath}`);
  if (!MANUAL && !prompt) console.log("Note: no prompt given. Example: node lovko-test.js photo.jpg \"make the background white\" --pre \"Images\"");

  const inputHash = imagePath && fs.existsSync(imagePath) ? sha(fs.readFileSync(imagePath)) : "";
  const browser = await launch();
  const context = await browser.newContext({ viewport: { width: 1366, height: 860 }, locale: "en-US" }); // fresh guest
  const page = await context.newPage();

  const netLog = [];
  const images = []; // every real picture the page received, in arrival order
  let counter = 0;
  const addImage = (url, type, body) => {
    if (!body || body.length < MIN_IMAGE_BYTES) return;
    const hash = sha(body);
    if (images.some((i) => i.hash === hash)) return;
    counter += 1;
    images.push({ n: counter, url, type, size: body.length, hash, body });
    console.log(`  [picture #${counter}] ${type} ${Math.round(body.length / 1024)} KB  ${url.slice(0, 90)}`);
  };

  page.on("response", async (res) => {
    try {
      const url = res.url();
      const type = (res.headers()["content-type"] || "").toLowerCase();
      netLog.push(`${res.status()} ${res.request().method()} ${type.split(";")[0]} ${url.slice(0, 220)}`);
      if (res.status() < 200 || res.status() >= 300) return;
      // Read only answers that can be a picture: image/*, binary/unknown types, or a picture-looking address.
      const maybe =
        type.startsWith("image/") ||
        type.includes("octet-stream") ||
        type.includes("binary") ||
        type === "" ||
        /\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(url);
      if (!maybe || type.includes("svg")) return;
      const body = await res.body().catch(() => null);
      const real = sniff(body);
      if (real) addImage(url, real, body);
    } catch { /* ignore */ }
  });

  console.log("Opening Lovko ...");
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 60000 });
  // Wait only until the chat is really ready (the text box exists), not a fixed time.
  await page
    .waitForFunction(
      (sel) =>
        Array.from(document.querySelectorAll(sel)).some((el) => {
          const r = el.getBoundingClientRect();
          const st = getComputedStyle(el);
          return r.width > 0 && r.height > 0 && st.visibility !== "hidden" && st.display !== "none";
        }),
      DEFAULT_INPUT,
      { timeout: 30000 },
    )
    .catch(() => {});
  step("chat is open");
  await page.screenshot({ path: path.join(OUT, "01-opened.png") });
  const ui = await dumpUi(page);
  fs.writeFileSync(path.join(OUT, "ui-dump.json"), JSON.stringify(ui, null, 2));
  console.log(`Saved ui-dump.json (${ui.length} elements) and 01-opened.png`);

  const save = async () => {
    fs.writeFileSync(path.join(OUT, "network.log"), netLog.join("\n"));
    await page.screenshot({ path: path.join(OUT, "03-end.png") }).catch(() => {});
  };

  if (MANUAL) {
    console.log("\nMANUAL MODE: now use Lovko by hand (upload a photo, type the prompt, wait for the picture).");
    console.log("The script records the network and every picture. Press Enter here when you are finished.");
    await waitEnter("");
    images
      .filter((i) => i.hash !== inputHash)
      .forEach((img) => fs.writeFileSync(path.join(OUT, `manual-picture-${img.n}.${extOf(img.type)}`), img.body));
    await save();
    console.log(`Saved ${images.length} picture(s) and network.log in ${OUT}`);
    await browser.close();
    return;
  }

  // ---- automatic try ----
  // Lovko is a chat bot: first press the menu button(s) given with --pre (for example "Images").
  for (const label of opt("pre").split(",").map((t) => t.trim()).filter(Boolean)) {
    try {
      await page.getByText(label, { exact: true }).last().click({ timeout: 8000 });
      console.log(`Clicked "${label}".`);
      await sleep(2000);
    } catch {
      console.log(`! Could not find a button with the text "${label}".`);
    }
  }

  const inputSel = opt("input", DEFAULT_INPUT);
  let box = null;
  for (const handle of await page.locator(inputSel).all()) {
    if (await handle.isVisible().catch(() => false)) { box = handle; break; }
  }
  if (!box) {
    console.log("! No visible text box found. Check ui-dump.json and pass --input \"<selector>\".");
    await save();
    if (!flag("close")) await waitEnter("Browser stays open. Press Enter to close ... ");
    await browser.close();
    return;
  }

  step("text box found");
  // Type the prompt FIRST (instant), then attach the photo.
  await box.click();
  await box.fill(prompt || STUDIO_PROMPT);
  step("prompt typed");

  if (imagePath) {
    const fileSel = opt("file-input", 'input[type="file"]');
    if ((await page.locator(fileSel).count()) === 0) {
      console.log("! No file input found on the page. Pass --file-input \"<selector>\".");
    } else {
      const beforeAttach = counter;
      await page.locator(fileSel).first().setInputFiles(imagePath);
      // Wait only until the page shows the photo preview (max 5 s), not a fixed time.
      for (let w = 0; w < 33 && counter === beforeAttach; w += 1) await sleep(150);
      await sleep(300);
      step("photo attached");
    }
  }
  await page.screenshot({ path: path.join(OUT, "02-ready.png") });

  const srcsBefore = new Set(await page.evaluate(() => Array.from(document.images).map((i) => i.currentSrc || i.src)));
  const countBeforeSend = counter;

  // Send. Lovko ignores "send" while the photo is still uploading, so we try again until the text box is empty
  // (= the message really left). Attempts alternate between the Enter key and a click on the round send button.
  const boxIsEmpty = async () => {
    const text = await box.inputValue().catch(async () => await box.innerText().catch(() => ""));
    return String(text).trim() === "";
  };
  // The send button is the right-most button next to the text box (the microphone is left of it).
  const clickSendButton = async () => {
    const sendSel = opt("send");
    if (sendSel) { await page.locator(sendSel).first().click({ timeout: 3000 }); return true; }
    const rect = await box.boundingBox();
    if (!rect) return false;
    const spot = await page.evaluate((r) => {
      let best = null;
      for (const b of document.querySelectorAll('button, [role="button"]')) {
        const q = b.getBoundingClientRect();
        if (q.width < 20 || q.height < 20) continue;
        const cy = q.top + q.height / 2;
        if (q.left >= r.x + r.width - 4 && cy >= r.y - 20 && cy <= r.y + r.height + 20) {
          if (!best || q.left > best.left) best = { left: q.left, x: q.left + q.width / 2, y: cy };
        }
      }
      return best;
    }, rect);
    if (!spot) return false;
    await page.mouse.click(spot.x, spot.y);
    return true;
  };

  let sent = false;
  for (let attempt = 1; attempt <= 25 && !sent; attempt += 1) {
    if (attempt % 2 === 1) await box.press("Enter").catch(() => {});
    else await clickSendButton().catch(() => {});
    await sleep(1200);
    sent = await boxIsEmpty();
    if (!sent) console.log(`  send attempt ${attempt}: not accepted yet (photo still uploading?), trying again ...`);
  }
  if (!sent) console.log("! The message could not be sent. Press the send button by hand in the browser.");
  step(sent ? "sent, waiting for the picture" : "NOT sent (see the browser)");

  const tried = new Set();
  const t0 = Date.now();
  let lastChange = Date.now();
  let seen = 0;
  let readyAt = 0;
  while (Date.now() - t0 < WAIT_MS) {
    await sleep(700);

    // Pictures shown in the page that were not there before: read their bytes.
    const domImgs = await page.evaluate(() =>
      Array.from(document.images)
        .map((i) => ({ src: i.currentSrc || i.src, w: i.naturalWidth, h: i.naturalHeight }))
        .filter((i) => i.src && i.w >= 300 && i.h >= 300),
    );
    for (const item of domImgs) {
      if (srcsBefore.has(item.src) || tried.has(item.src)) continue;
      tried.add(item.src);
      let bytes = null;
      try {
        if (/^https?:/i.test(item.src)) {
          // From Node, not from the page: no browser cross-site (CORS) limit.
          bytes = await (await context.request.get(item.src, { timeout: 30000 })).body();
        } else {
          const b64 = await page.evaluate(async (src) => {
            const r = await fetch(src);
            const buf = new Uint8Array(await r.arrayBuffer());
            let s = "";
            for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode.apply(null, buf.subarray(i, i + 0x8000));
            return btoa(s);
          }, item.src);
          bytes = Buffer.from(b64, "base64");
        }
      } catch { /* try the next one */ }
      const real = sniff(bytes);
      if (real) addImage(item.src, real, bytes);
    }

    const fresh = images.filter((i) => i.n > countBeforeSend && i.hash !== inputHash);
    if (fresh.length !== seen) { seen = fresh.length; lastChange = Date.now(); }

    // Lovko writes "Image ready" when it has finished.
    if (!readyAt && (await page.getByText(/Image ready/i).count().catch(() => 0)) > 0) {
      readyAt = Date.now();
      console.log("  Lovko says: Image ready.");
    }
    // The finished picture comes from Lovko's "generated-images" address: stop as soon as it has arrived.
    if (fresh.some((i) => /generated-images/i.test(i.url)) && Date.now() - lastChange > 800) break;
    if (readyAt && seen > 0 && Date.now() - Math.max(readyAt, lastChange) > 1500) break;
    if (!readyAt && seen > 0 && Date.now() - lastChange > 12000) break;
    if (readyAt && seen === 0 && Date.now() - readyAt > 10000) break;
  }

  // Everything that arrived after "Send" is saved, the LAST one is the result (the first ones are previews of your own photo).
  const fresh = images.filter((i) => i.n > countBeforeSend && i.hash !== inputHash);
  fresh.forEach((img) => fs.writeFileSync(path.join(OUT, `candidate-${img.n}.${extOf(img.type)}`), img.body));
  if (fresh.length) {
    const best = fresh[fresh.length - 1];
    const file = path.join(OUT, `result-${Date.now()}.${extOf(best.type)}`);
    fs.writeFileSync(file, best.body);
    step("picture saved");
    console.log(`\nTOTAL: ${((Date.now() - T0) / 1000).toFixed(1)} s`);
    console.log(`OK: picture saved -> ${file}  (${Math.round(best.size / 1024)} KB, ${fresh.length} candidate(s) saved as candidate-N)`);
  } else {
    // Last resort: a screenshot of the biggest picture on screen (lower quality, but something to work with).
    const shot = path.join(OUT, `result-screenshot-${Date.now()}.png`);
    const ok = await page
      .locator("img")
      .last()
      .screenshot({ path: shot, timeout: 8000 })
      .then(() => true)
      .catch(() => false);
    console.log(ok ? `\nNo picture file was received; saved a screenshot of the last image: ${shot}` : "\nNo generated picture was found.");
    console.log("Send me the folder lovko-out (network.log, ui-dump.json, screenshots).");
  }
  await save();
  if (!flag("close")) await waitEnter("Browser stays open so you can look. Press Enter to close ... ");
  await browser.close();
}

main().catch((error) => {
  console.error("FAILED:", error.message);
  process.exit(1);
});
