import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = 3000;

const types = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".mp4": "video/mp4",
};

/* ===== live creator rewards tracker =====
   pump.fun's swap-api only returns real data when the request originates
   from a real browser session that has loaded pump.fun itself (their API
   gateway 404s on plain server-to-server or cross-origin fetches). So we
   run a real headless browser in the background, let pump.fun's own page
   make its normal API calls, and capture the response — same data their
   UI shows, just re-served from our own /api/rewards endpoint. */

const CJ_WALLET = "8L4fLVBHNDMx5k3K7eidsGA4amy4kkvNcJQZXbTbjbLF";
const CJ_MINT = "Bmv7ho39ijT6ur3GSN3GK4bxZnwM7qrf1ReF5qYfpump";
const MANUAL_USD = 4850; // sent directly to Young Maylay outside of pump.fun rewards
const REFRESH_MS = 90_000;

let rewardsCache = {
  ok: false,
  creatorRewardsUsd: null,
  claimedUsd: 0,
  claimed: false,
  manualUsd: MANUAL_USD,
  totalUsd: MANUAL_USD,
  updatedAt: null,
  error: "not scraped yet",
};
let scraping = false;

function findChrome() {
  const candidates = [
    "C:/Users/User/.cache/puppeteer/chrome/win64-151.0.7922.71/chrome-win64/chrome.exe",
    "C:/Users/User/.cache/puppeteer/chrome/win64-148.0.7778.167/chrome-win64/chrome.exe",
  ];
  return candidates.find((p) => fs.existsSync(p));
}

async function scrapeRewards() {
  if (scraping) return;
  scraping = true;
  let browser;
  try {
    const executablePath = findChrome();
    browser = await puppeteer.launch({ executablePath, headless: true });
    const page = await browser.newPage();

    let coinsData = null;
    page.on("response", async (res) => {
      const url = res.url();
      if (url.includes("/fee-sharing/account/") && url.includes("/coins")) {
        try {
          coinsData = await res.json();
        } catch {}
      }
    });

    await page.goto(`https://pump.fun/profile/${CJ_WALLET}?tab=creator-rewards`, {
      waitUntil: "networkidle2",
      timeout: 45000,
    });
    await new Promise((r) => setTimeout(r, 2000));

    if (coinsData && Array.isArray(coinsData.items) && coinsData.items.length) {
      const cj = coinsData.items.find((i) => i.mint === CJ_MINT) || coinsData.items[0];
      const earnedUsd = parseFloat(cj.totalEarned?.usd ?? "0");
      const claimedUsd = parseFloat(cj.totalClaimed?.usd ?? "0");
      rewardsCache = {
        ok: true,
        creatorRewardsUsd: earnedUsd,
        claimedUsd,
        claimed: claimedUsd > 0,
        manualUsd: MANUAL_USD,
        totalUsd: earnedUsd + MANUAL_USD,
        updatedAt: new Date().toISOString(),
        error: null,
      };
      console.log(`[rewards] updated: $${earnedUsd.toFixed(2)} earned, $${claimedUsd.toFixed(2)} claimed`);
    } else {
      rewardsCache = { ...rewardsCache, ok: false, error: "no data captured from pump.fun", updatedAt: new Date().toISOString() };
      console.log("[rewards] scrape ran but captured no data");
    }
  } catch (e) {
    rewardsCache = { ...rewardsCache, ok: false, error: String(e.message || e), updatedAt: new Date().toISOString() };
    console.log("[rewards] scrape failed:", e.message || e);
  } finally {
    if (browser) await browser.close();
    scraping = false;
  }
}

scrapeRewards();
setInterval(scrapeRewards, REFRESH_MS);

http
  .createServer((req, res) => {
    const reqUrl = req.url.split("?")[0];

    if (reqUrl === "/api/rewards") {
      res.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
      });
      res.end(JSON.stringify(rewardsCache));
      return;
    }

    let reqPath = decodeURIComponent(reqUrl);
    if (reqPath === "/") reqPath = "/index.html";
    const filePath = path.join(root, reqPath);
    if (!filePath.startsWith(root)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }
    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("Not found");
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      res.writeHead(200, { "Content-Type": types[ext] || "application/octet-stream" });
      res.end(data);
    });
  })
  .listen(port, () => {
    console.log(`Serving ${root} at http://localhost:${port}`);
  });
