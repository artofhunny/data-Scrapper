/**
 * SHARED AGENT LOGIC
 * ---------------------------------------------------------
 * Works for ANY Google Maps search - mechanics, tuition teachers, web
 * development companies, salons, clinics, etc. The query is entirely
 * user-supplied; nothing here is hardcoded to a specific business type.
 *
 * This file has the exact same 4 steps that used to run in the terminal:
 *   1) scrapeGoogleMaps    - Puppeteer scrapes raw listing text
 *   2) extractStructuredData - Gemini turns raw text into structured JSON
 *   3) deduplicateRecords  - removes duplicate listings
 *   4) saveToExcel         - writes the final Excel file
 *
 * Both index.js (CLI) and server.js (Web UI) import runFullPipeline() from here,
 * so the process is guaranteed to be identical either way - only the "log" function
 * differs (console.log for CLI, Server-Sent Events for the web UI).
 *
 * NOTE ON LOG LEVELS:
 * log(message, level) is now called with a level: "info" | "warn" | "error".
 * - "info"  -> normal progress line
 * - "warn"  -> something recoverable happened (e.g. a single retry)
 * - "error" -> something failed in a way the user should notice
 * Callers that don't care can ignore the second argument (it defaults to "info").
 * ---------------------------------------------------------
 */

import "dotenv/config";
import path from "path";
import puppeteer from "puppeteer";
import ExcelJS from "exceljs";
import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// gemini-3.5-flash-lite is the current GA model, available on the free tier (Aug 2026)
// If this ever gets retired too, put the new model name from the error message here
const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash-lite" });

const TARGET_RESULTS = parseInt(process.env.TARGET_RESULTS || "25", 10);
const HEADLESS = process.env.HEADLESS !== "false";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------
// STEP 1: Scrape raw listing text from Google Maps
// ------------------------------------------------------------------
export async function scrapeGoogleMaps(query, targetCount = TARGET_RESULTS, log = console.log) {
  log(`Starting Google Maps search: "${query}"`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });

  const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
  await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

  const feedSelector = 'div[role="feed"]';
  await page.waitForSelector(feedSelector, { timeout: 30000 }).catch(() => {
    log("Could not find the results feed - Google Maps layout may have changed.", "warn");
  });

  let collectedCards = [];
  let previousCount = 0;
  let stagnantRounds = 0;

  // ---- AGENTIC LOOP: decides on its own how long to keep scrolling ----
  while (collectedCards.length < targetCount && stagnantRounds < 4) {
    collectedCards = await page.evaluate((sel) => {
      const feed = document.querySelector(sel);
      if (!feed) return [];
      const cards = Array.from(feed.querySelectorAll("div[role='article']"));
      return cards
        .map((c) => {
          // the card's "Website" button (if the business has one)
          const scope = c.parentElement || c;
          const siteLink =
            c.querySelector('a[data-value="Website"]') ||
            scope.querySelector('a[data-value="Website"]') ||
            Array.from(c.querySelectorAll("a[aria-label]")).find((a) =>
              /website/i.test(a.getAttribute("aria-label") || "")
            );
          // link to the listing's own Maps page (used later if the card has no website button)
          const placeLink = c.querySelector('a[href*="/maps/place/"]');
          return {
            text: c.innerText,
            website: siteLink ? siteLink.href : null,
            placeUrl: placeLink ? placeLink.href : null,
          };
        })
        .filter((c) => c.text);
    }, feedSelector);

    log(`Found ${collectedCards.length} listings so far...`);

    if (collectedCards.length === previousCount) {
      stagnantRounds++;
    } else {
      stagnantRounds = 0;
    }
    previousCount = collectedCards.length;

    await page.evaluate((sel) => {
      const feed = document.querySelector(sel);
      if (feed) feed.scrollBy(0, 1000);
    }, feedSelector);

    await sleep(1500);
  }

  await browser.close();
  log(`Scraping complete. Total raw cards: ${collectedCards.length}`);
  return collectedCards.slice(0, targetCount);
}

// ------------------------------------------------------------------
// STEP 1.5: Find email IDs by visiting each listing's website
// ------------------------------------------------------------------
// Google Maps never shows emails, so for every listing we:
//   a) take the website from the card, or open the listing's Maps page to find it
//   b) open the website's homepage and look for emails (mailto links, plain text,
//      "name [at] domain [dot] com", Cloudflare-protected emails)
//   c) if none found, open up to 3 contact/about pages on the same site and look there
// Listings with no website (very common for small local shops) can't get an email.

const EMAIL_TARGET = parseInt(process.env.EMAIL_TARGET || "15", 10);
const MAX_SCAN_RESULTS = parseInt(process.env.MAX_SCAN_RESULTS || "60", 10);
const EMAIL_CONCURRENCY = 3;

// sites where an email can't realistically be scraped (login walls / directories)
const SKIP_SITE_HOSTS =
  /(^|\.)(facebook|instagram|wa\.me|whatsapp|linkedin|twitter|x|youtube|google|goo\.gl|justdial|indiamart|sulekha|yelp)\./i;

const EMAIL_REGEX = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;
const JUNK_EMAIL =
  /\.(png|jpe?g|gif|svg|webp|avif|css|js)$|example\.|ejemplo|misitio|mysite\.|yoursite\.|sitename\.|sentry|wixpress|domain\.com|yourdomain|yourname|youremail|email@email|user@|name@|test@|@2x|u00/i;

function unwrapGoogleRedirect(url) {
  try {
    const u = new URL(url);
    if (/google\./.test(u.hostname) && u.searchParams.get("q")) return u.searchParams.get("q");
    return url;
  } catch {
    return null;
  }
}

function decodeCfEmail(hex) {
  try {
    const key = parseInt(hex.slice(0, 2), 16);
    let out = "";
    for (let i = 2; i < hex.length; i += 2) {
      out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    }
    return out;
  } catch {
    return "";
  }
}

function cleanEmail(raw) {
  let e = decodeURIComponent(String(raw || ""))
    .replace(/^mailto:/i, "")
    .split("?")[0]
    .trim()
    .toLowerCase()
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, "");
  // a phone number printed right before the email gets glued on by the text regex
  // (e.g. "7982807107name@gmail.com") -> strip a leading 10+ digit run
  e = e.replace(/^(\+?91)?\d{10,}(?=[a-z])/, "");
  if (!e || e.length > 80 || JUNK_EMAIL.test(e)) return null;
  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) return null;
  return e;
}

async function newLightPage(browser) {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    if (["image", "media", "font", "stylesheet"].includes(type)) req.abort().catch(() => {});
    else req.continue().catch(() => {});
  });
  page.setDefaultNavigationTimeout(20000);
  return page;
}

// pulls every email-looking string out of the currently open page
async function readEmailsFromPage(page) {
  const data = await page.evaluate(() => {
    const mailtos = Array.from(document.querySelectorAll('a[href^="mailto:" i]')).map((a) =>
      a.getAttribute("href")
    );
    const cf = [
      ...Array.from(document.querySelectorAll("[data-cfemail]")).map((e) =>
        e.getAttribute("data-cfemail")
      ),
      ...Array.from(document.querySelectorAll('a[href*="/cdn-cgi/l/email-protection#"]')).map(
        (a) => a.getAttribute("href").split("#")[1]
      ),
    ];
    const text = document.body ? document.body.innerText : "";
    const html = document.documentElement.outerHTML.slice(0, 2000000);
    const links = Array.from(document.querySelectorAll("a[href]")).map((a) => ({
      href: a.href,
      text: (a.innerText || "").trim().slice(0, 60),
    }));
    return { mailtos, cf, text, html, links };
  });

  const deobfuscated = data.text
    .replace(/\s*[\[\(\{]\s*at\s*[\]\)\}]\s*/gi, "@")
    .replace(/\s*[\[\(\{]\s*dot\s*[\]\)\}]\s*/gi, ".");

  const found = [
    ...data.mailtos,
    ...data.cf.map(decodeCfEmail),
    ...(deobfuscated.match(EMAIL_REGEX) || []),
    ...(data.html.match(EMAIL_REGEX) || []),
  ]
    .map(cleanEmail)
    .filter(Boolean);

  return { emails: [...new Set(found)], links: data.links };
}

// best emails first: same domain as the website, then info@/contact@ style addresses
function rankEmails(emails, siteHost) {
  const base = siteHost.replace(/^www\./, "");
  const score = (e) => {
    let s = 0;
    const domain = e.split("@")[1];
    if (domain === base || base.endsWith("." + domain) || domain.endsWith("." + base)) s += 10;
    if (/^(info|contact|hello|enquir|inquir|sales|support|office|admin|mail|hr|careers)/.test(e)) s += 3;
    return -s;
  };
  return [...emails].sort((a, b) => score(a) - score(b));
}

async function findWebsiteFromPlacePage(browser, placeUrl) {
  const page = await newLightPage(browser);
  try {
    await page.goto(placeUrl, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('a[data-item-id="authority"]', { timeout: 8000 }).catch(() => {});
    return await page.evaluate(() => {
      const a = document.querySelector('a[data-item-id="authority"]');
      return a ? a.href : null;
    });
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

async function findEmailOnWebsite(browser, website) {
  let start;
  try {
    start = new URL(website);
  } catch {
    return [];
  }
  const page = await newLightPage(browser);
  try {
    await page.goto(start.href, { waitUntil: "domcontentloaded" }).catch(() => {});
    await sleep(1500); // let JS-rendered sites fill in
    const home = await readEmailsFromPage(page).catch(() => ({ emails: [], links: [] }));
    if (home.emails.length) return rankEmails(home.emails, start.hostname);

    // no email on the homepage -> try contact / about pages on the same site
    const sameSite = (href) => {
      try {
        return new URL(href).hostname.replace(/^www\./, "") === start.hostname.replace(/^www\./, "");
      } catch {
        return false;
      }
    };
    let candidates = home.links
      .filter((l) => sameSite(l.href))
      .filter((l) => /contact|about|reach|enquir|inquir|get-in-touch|support|connect/i.test(l.href + " " + l.text))
      .map((l) => l.href.split("#")[0]);
    candidates = [...new Set(candidates)];
    if (!candidates.length) {
      candidates = [new URL("/contact-us", start).href, new URL("/contact", start).href];
    }

    for (const url of candidates.slice(0, 3)) {
      await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
      await sleep(1200);
      const res = await readEmailsFromPage(page).catch(() => ({ emails: [] }));
      if (res.emails.length) return rankEmails(res.emails, start.hostname);
    }
    return [];
  } finally {
    await page.close().catch(() => {});
  }
}

async function enrichOneListing(browser, card) {
  let website = card.website ? unwrapGoogleRedirect(card.website) : null;
  if (!website && card.placeUrl) {
    const fromPlace = await findWebsiteFromPlacePage(browser, card.placeUrl);
    website = fromPlace ? unwrapGoogleRedirect(fromPlace) : null;
  }
  card.website = website || null;
  card.email = null;
  if (!website) return card;

  let host = "";
  try {
    host = new URL(website).hostname;
  } catch {
    return card;
  }
  if (SKIP_SITE_HOSTS.test(host)) return card;

  const emails = await findEmailOnWebsite(browser, website).catch(() => []);
  // keep up to 2 emails per listing (best one first)
  card.email = emails.length ? emails.slice(0, 2).join(", ") : null;
  return card;
}

// Processes listings in order until we have `emailTarget` emails (and at least
// `minListings` checked), or we run out of listings.
export async function enrichWithEmails(cards, minListings, emailTarget = EMAIL_TARGET, log = console.log) {
  // Google Maps sometimes repeats the same listing while scrolling - drop repeats
  // before visiting websites so one business isn't counted twice
  const seen = new Set();
  cards = cards.filter((c) => {
    let key = (c.text || "").split("\n")[0].trim().toLowerCase();
    if (c.placeUrl) {
      // Google's unique place id (e.g. "!1s0x390d...:0x5a1b...") - different branches with the same name stay separate
      const id = c.placeUrl.match(/!1s(0x[0-9a-f]+:0x[0-9a-f]+)/i);
      key = id ? id[1] : c.placeUrl.split("?")[0];
    }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  log(`Looking for email IDs on listing websites (target: ${emailTarget} emails)...`);
  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
  });

  const processed = [];
  let emailCount = 0;
  try {
    for (let i = 0; i < cards.length; i += EMAIL_CONCURRENCY) {
      if (emailCount >= emailTarget && processed.length >= minListings) break;

      const batch = cards.slice(i, i + EMAIL_CONCURRENCY);
      const results = await Promise.all(
        batch.map((card) =>
          Promise.race([
            enrichOneListing(browser, card),
            sleep(60000).then(() => ({ ...card, email: card.email || null })), // hard cap per listing
          ]).catch(() => ({ ...card, email: null }))
        )
      );

      results.forEach((r, j) => {
        const name = (r.text || "").split("\n")[0].slice(0, 50);
        if (r.email) {
          emailCount++;
          log(`Email found (${emailCount}): ${name} -> ${r.email}`);
        } else {
          log(`No email for: ${name}${r.website ? "" : " (no website)"}`);
        }
        processed.push({ ...r, _index: i + j });
      });
    }
  } finally {
    await browser.close().catch(() => {});
  }

  log(`Email search done: ${emailCount} email(s) found across ${processed.length} listings checked.`);
  return processed;
}

// ------------------------------------------------------------------
// STEP 2: Raw text -> structured JSON via Gemini (the AI part)
// ------------------------------------------------------------------
// `stats` (optional) lets the caller track how many failures were caused
// specifically by rate-limit/quota errors, so the pipeline can report a
// clear warning instead of silently producing an empty result.
export async function extractStructuredData(rawText, log = console.log, retry = 0, stats = null) {
  const prompt = `You are a data-extraction agent. You are given the messy raw text of a single Google Maps listing.
Extract ONLY these fields and return STRICT JSON, nothing else:

{
  "name": "business name",
  "category": "e.g. Car Mechanic, Tuition/Coaching Center, Web Development Company, Salon",
  "phone": "phone number if found, else null",
  "address": "address if found, else null",
  "rating": "rating number if found, else null",
  "reviews_count": "number of reviews if found, else null"
}

IMPORTANT RULES:
- The listing can be for ANY kind of business or service (e.g. mechanic, tuition/coaching
  center, web development company, salon, restaurant, clinic) - extract the same fields
  regardless of category, and set "category" to whatever this specific listing actually is.
- The "address" field MUST be written in English / Roman script only. If any part of the
  address in the raw text is in Hindi (Devanagari) or another script, transliterate it into
  English letters instead of copying the script as-is. Do not mix scripts in one field.
- If a field is not present in the text, set its value to null.
- Return ONLY the JSON object. No explanation, no markdown code fences.

RAW TEXT:
${rawText}`;

  let result;
  try {
    result = await model.generateContent(prompt);
  } catch (err) {
    const is429 = err?.status === 429 || /429|quota|rate limit/i.test(err?.message || "");

    if (is429 && retry < 5) {
      const waitMs = 20000;
      log(
        `Rate limit hit, waiting ${waitMs / 1000}s before retrying (attempt ${retry + 1}/5)...`,
        "warn"
      );
      await sleep(waitMs);
      return await extractStructuredData(rawText, log, retry + 1, stats);
    }

    if (is429) {
      // Retries are exhausted and it's still a 429 -> this is almost certainly
      // the free-tier quota being exhausted, not just a momentary blip.
      log(
        `Gemini quota/rate limit still exceeded after 5 retries - skipping this listing.`,
        "error"
      );
      if (stats) stats.rateLimitFailures++;
    } else {
      log(`Extraction failed, skipping this entry: ${err.message}`, "warn");
      if (stats) stats.otherFailures++;
    }
    return null;
  }

  let jsonStr = result.response.text().trim();
  jsonStr = jsonStr.replace(/```json|```/g, "").trim();

  try {
    const parsed = JSON.parse(jsonStr);
    // ---- SELF-CHECK: if the name is missing and a retry is available, try again ----
    if (!parsed.name && retry < 1) {
      log("Name field missing, retrying extraction...", "warn");
      return await extractStructuredData(rawText, log, retry + 1, stats);
    }
    return parsed;
  } catch (err) {
    log("Failed to parse JSON, skipping this entry.", "warn");
    if (stats) stats.otherFailures++;
    return null;
  }
}

// ------------------------------------------------------------------
// STEP 3: Remove duplicate listings
// ------------------------------------------------------------------
export function deduplicateRecords(records, log = console.log) {
  const seen = new Set();
  const unique = [];

  for (const r of records) {
    if (!r || !r.name) continue;

    const normalizedName = r.name.trim().toLowerCase();
    const normalizedPhone = (r.phone || "").replace(/\D/g, "");
    const normalizedAddress = (r.address || "").trim().toLowerCase();
    const key = normalizedPhone
      ? `${normalizedName}|${normalizedPhone}`
      : `${normalizedName}|${normalizedAddress}`;

    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }

  const removedCount = records.filter(Boolean).length - unique.length;
  if (removedCount > 0) {
    log(`Removed ${removedCount} duplicate listing(s).`);
  }

  return unique;
}

// ------------------------------------------------------------------
// STEP 4: Save to Excel
// ------------------------------------------------------------------
export async function saveToExcel(records, query, outputDir = ".", log = console.log) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Leads");

  sheet.columns = [
    { header: "Name", key: "name", width: 30 },
    { header: "Category", key: "category", width: 22 },
    { header: "Phone", key: "phone", width: 18 },
    { header: "Email", key: "email", width: 32 },
    { header: "Website", key: "website", width: 35 },
    { header: "Address", key: "address", width: 40 },
    { header: "Rating", key: "rating", width: 10 },
    { header: "Reviews Count", key: "reviews_count", width: 15 },
  ];
  sheet.getRow(1).font = { bold: true };

  records.forEach((r) => {
    if (r) sheet.addRow(r);
  });

  const safeName = query.replace(/[^a-z0-9]/gi, "_").toLowerCase();
  const filename = `leads_${safeName}_${Date.now()}.xlsx`;
  const filepath = path.join(outputDir, filename);
  await workbook.xlsx.writeFile(filepath);
  log(`Excel file created: ${filename}`);
  return filepath;
}

// ------------------------------------------------------------------
// FULL PIPELINE: exact same steps every time, used by both CLI and Web UI
// ------------------------------------------------------------------
export async function runFullPipeline(query, log = console.log, outputDir = ".") {
  // scrape a bigger pool than we need, so listings without email can be swapped
  // for ones that do have an email
  const pool = await scrapeGoogleMaps(query, Math.max(MAX_SCAN_RESULTS, TARGET_RESULTS), log);

  const checked = await enrichWithEmails(pool, TARGET_RESULTS, EMAIL_TARGET, log);

  // final list: listings with an email first, then fill up with the rest; keep Maps order
  const withEmail = checked.filter((c) => c.email);
  const withoutEmail = checked.filter((c) => !c.email);
  const rawCards = [
    ...withEmail.slice(0, TARGET_RESULTS),
    ...withoutEmail.slice(0, Math.max(0, TARGET_RESULTS - withEmail.length)),
  ].sort((a, b) => a._index - b._index);

  const finalEmailCount = rawCards.filter((c) => c.email).length;
  if (finalEmailCount < EMAIL_TARGET) {
    log(
      `Only ${finalEmailCount} email(s) could be found (target ${EMAIL_TARGET}). Most of the remaining ` +
        `businesses have no website, or don't publish an email on it.`,
      "warn"
    );
  }

  log(`Extracting ${rawCards.length} listings with AI...`);
  const structuredRecords = [];
  const stats = { rateLimitFailures: 0, otherFailures: 0 };

  for (let i = 0; i < rawCards.length; i++) {
    log(`Processing ${i + 1}/${rawCards.length}`);
    const record = await extractStructuredData(rawCards[i].text, log, 0, stats);
    if (record) {
      // email & website come from the website visit, not from Gemini
      record.email = rawCards[i].email || null;
      record.website = rawCards[i].website || null;
    }
    structuredRecords.push(record);
    // free tier limit: 15 requests/minute -> need at least 4000ms between requests
    await sleep(4500);
  }

  const validRecords = structuredRecords.filter(Boolean);
  log(`${validRecords.length}/${rawCards.length} listings successfully extracted.`);

  // ---- Make rate-limit problems visible instead of letting them hide inside a quiet "success" ----
  if (stats.rateLimitFailures > 0) {
    log(
      `${stats.rateLimitFailures}/${rawCards.length} listing(s) failed because the Gemini API ` +
        `quota/rate limit was still exceeded even after retries. If this number is high, your ` +
        `free-tier quota is likely exhausted - check https://aistudio.google.com/apikey or wait ` +
        `before running again.`,
      "error"
    );
  }

  const uniqueRecords = deduplicateRecords(validRecords, log);
  log(`${uniqueRecords.length} unique listings after removing duplicates.`);

  // ---- Don't silently hand back an empty file and call it "done" ----
  if (uniqueRecords.length === 0) {
    const reason =
      stats.rateLimitFailures > 0
        ? "This was caused by the Gemini API quota/rate limit being exceeded for every listing."
        : rawCards.length === 0
        ? "No listings were found on Google Maps for this search - the page layout may have changed, or the search returned nothing."
        : "Every listing failed AI extraction, so there is nothing to save.";
    throw new Error(`No listings could be extracted - refusing to save an empty file. ${reason}`);
  }

  const filepath = await saveToExcel(uniqueRecords, query, outputDir, log);
  return filepath;
}