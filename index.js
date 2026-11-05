// /**
//  * MECHANIC AI AGENT SCRAPER
//  * ---------------------------------------------------------
//  * How this differs from the old rule-based scraper:
//  *   - Old scraper -> fixed CSS selectors (breaks if the site's layout changes)
//  *   - This AI Agent -> sends raw messy text to Gemini (LLM), which understands
//  *                       it and returns clean structured JSON (name, phone, address, rating..)
//  *
//  * Flow:
//  *   1) Ask user for a search query (e.g. "car mechanic in Delhi")
//  *   2) Open Google Maps with Puppeteer and scroll to load results
//  *   3) Grab each listing's raw text (whatever format it comes in)
//  *   4) Send that raw text to Gemini -> get back structured JSON
//  *   5) If a field is missing, the agent retries itself (self-correcting = "agentic")
//  *   6) Remove duplicate listings
//  *   7) Save everything to an Excel sheet
//  * ---------------------------------------------------------
//  */

// import "dotenv/config";
// import puppeteer from "puppeteer";
// import ExcelJS from "exceljs";
// import { GoogleGenerativeAI } from "@google/generative-ai";
// import prompts from "prompts";

// const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
// // gemini-3.5-flash-lite is the current GA model, available on the free tier (Aug 2026)
// // If this ever gets retired too, put the new model name from the error message here
// const model = genAI.getGenerativeModel({ model: "gemini-3.5-flash-lite" });

// const TARGET_RESULTS = parseInt(process.env.TARGET_RESULTS || "25", 10);
// const HEADLESS = process.env.HEADLESS !== "false";

// // ------------------------------------------------------------------
// // STEP 1: Scrape raw listing text from Google Maps
// // ------------------------------------------------------------------
// async function scrapeGoogleMaps(query, targetCount) {
//   console.log(`\n[Agent] Starting Google Maps search: "${query}"`);

//   const browser = await puppeteer.launch({
//     headless: HEADLESS,
//     args: ["--no-sandbox", "--disable-setuid-sandbox"],
//   });
//   const page = await browser.newPage();
//   await page.setViewport({ width: 1366, height: 900 });

//   const url = `https://www.google.com/maps/search/${encodeURIComponent(query)}`;
//   await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });

//   // Google Maps results panel selector
//   const feedSelector = 'div[role="feed"]';
//   await page.waitForSelector(feedSelector, { timeout: 30000 }).catch(() => {
//     console.log("[Agent] Could not find the results feed - Google Maps layout may have changed.");
//   });

//   let collectedCards = [];
//   let previousCount = 0;
//   let stagnantRounds = 0;

//   // ---- AGENTIC LOOP: decides on its own how long to keep scrolling ----
//   while (collectedCards.length < targetCount && stagnantRounds < 4) {
//     collectedCards = await page.evaluate((sel) => {
//       const feed = document.querySelector(sel);
//       if (!feed) return [];
//       const cards = Array.from(feed.querySelectorAll("div[role='article']"));
//       return cards.map((c) => c.innerText).filter(Boolean);
//     }, feedSelector);

//     console.log(`[Agent] Found ${collectedCards.length} listings so far...`);

//     if (collectedCards.length === previousCount) {
//       stagnantRounds++; // no new results loaded, list may be ending
//     } else {
//       stagnantRounds = 0;
//     }
//     previousCount = collectedCards.length;

//     // scroll the feed to load more listings
//     await page.evaluate((sel) => {
//       const feed = document.querySelector(sel);
//       if (feed) feed.scrollBy(0, 1000);
//     }, feedSelector);

//     await new Promise((r) => setTimeout(r, 1500));
//   }

//   await browser.close();
//   console.log(`[Agent] Scraping complete. Total raw cards: ${collectedCards.length}`);
//   return collectedCards.slice(0, targetCount);
// }

// // ------------------------------------------------------------------
// // STEP 2: Raw text -> structured JSON via Gemini (the AI part)
// // ------------------------------------------------------------------
// async function extractStructuredData(rawText, retry = 0) {
//   const prompt = `You are a data-extraction agent. You are given the messy raw text of a single Google Maps listing.
// Extract ONLY these fields and return STRICT JSON, nothing else:

// {
//   "name": "business name",
//   "category": "e.g. Car Mechanic, Auto Repair Shop",
//   "phone": "phone number if found, else null",
//   "address": "address if found, else null",
//   "rating": "rating number if found, else null",
//   "reviews_count": "number of reviews if found, else null"
// }

// IMPORTANT RULES:
// - The "address" field MUST be written in English / Roman script only. If any part of the
//   address in the raw text is in Hindi (Devanagari) or another script, transliterate it into
//   English letters instead of copying the script as-is. Do not mix scripts in one field.
// - If a field is not present in the text, set its value to null.
// - Return ONLY the JSON object. No explanation, no markdown code fences.

// RAW TEXT:
// ${rawText}`;

//   let result;
//   try {
//     result = await model.generateContent(prompt);
//   } catch (err) {
//     // ---- RATE LIMIT HANDLING: 429 on the free tier is normal, wait and retry automatically ----
//     const is429 = err?.status === 429 || /429|quota|rate limit/i.test(err?.message || "");
//     if (is429 && retry < 5) {
//       const waitMs = 20000; // wait ~20s for the free tier quota window to reset
//       console.log(`[Agent] Rate limit hit, waiting ${waitMs / 1000}s before retrying (attempt ${retry + 1}/5)...`);
//       await new Promise((r) => setTimeout(r, waitMs));
//       return await extractStructuredData(rawText, retry + 1);
//     }
//     console.log("[Agent] Extraction failed, skipping this entry:", err.message);
//     return null;
//   }

//   let jsonStr = result.response.text().trim();
//   jsonStr = jsonStr.replace(/```json|```/g, "").trim();

//   try {
//     const parsed = JSON.parse(jsonStr);
//     // ---- SELF-CHECK: if the name is missing and a retry is available, try again ----
//     if (!parsed.name && retry < 1) {
//       console.log("[Agent] Name field missing, retrying extraction...");
//       return await extractStructuredData(rawText, retry + 1);
//     }
//     return parsed;
//   } catch (err) {
//     console.log("[Agent] Failed to parse JSON, skipping this entry.");
//     return null;
//   }
// }

// // ------------------------------------------------------------------
// // STEP 3: Remove duplicate listings
// // ------------------------------------------------------------------
// function deduplicateRecords(records) {
//   const seen = new Set();
//   const unique = [];

//   for (const r of records) {
//     if (!r || !r.name) continue;

//     // build a key from name + phone (falls back to name + address if phone is missing)
//     const normalizedName = r.name.trim().toLowerCase();
//     const normalizedPhone = (r.phone || "").replace(/\D/g, ""); // digits only
//     const normalizedAddress = (r.address || "").trim().toLowerCase();
//     const key = normalizedPhone
//       ? `${normalizedName}|${normalizedPhone}`
//       : `${normalizedName}|${normalizedAddress}`;

//     if (seen.has(key)) continue;
//     seen.add(key);
//     unique.push(r);
//   }

//   const removedCount = records.filter(Boolean).length - unique.length;
//   if (removedCount > 0) {
//     console.log(`[Agent] Removed ${removedCount} duplicate listing(s).`);
//   }

//   return unique;
// }

// // ------------------------------------------------------------------
// // STEP 4: Save to Excel
// // ------------------------------------------------------------------
// async function saveToExcel(records, query) {
//   const workbook = new ExcelJS.Workbook();
//   const sheet = workbook.addWorksheet("Mechanics");

//   sheet.columns = [
//     { header: "Name", key: "name", width: 30 },
//     { header: "Category", key: "category", width: 22 },
//     { header: "Phone", key: "phone", width: 18 },
//     { header: "Address", key: "address", width: 40 },
//     { header: "Rating", key: "rating", width: 10 },
//     { header: "Reviews Count", key: "reviews_count", width: 15 },
//   ];
//   sheet.getRow(1).font = { bold: true };

//   records.forEach((r) => {
//     if (r) sheet.addRow(r);
//   });

//   const safeName = query.replace(/[^a-z0-9]/gi, "_").toLowerCase();
//   const filename = `mechanics_${safeName}_${Date.now()}.xlsx`;
//   await workbook.xlsx.writeFile(filename);
//   console.log(`\n[Agent] Excel file created: ${filename}`);
//   return filename;
// }

// // ------------------------------------------------------------------
// // MAIN: ties everything together
// // ------------------------------------------------------------------
// async function main() {
//   if (!process.env.GEMINI_API_KEY) {
//     console.error("ERROR: GEMINI_API_KEY is not set in .env. Copy .env.example to .env and add your key.");
//     process.exit(1);
//   }

//   const response = await prompts({
//     type: "text",
//     name: "query",
//     message: 'Enter a search query (e.g. "car mechanic in Delhi")',
//   });

//   const query = response.query;
//   if (!query) {
//     console.log("No query entered, exiting.");
//     return;
//   }

//   const rawCards = await scrapeGoogleMaps(query, TARGET_RESULTS);

//   console.log(`\n[Agent] Extracting ${rawCards.length} listings with AI...`);
//   const structuredRecords = [];
//   for (let i = 0; i < rawCards.length; i++) {
//     console.log(`[Agent] Processing ${i + 1}/${rawCards.length}`);
//     const record = await extractStructuredData(rawCards[i]);
//     structuredRecords.push(record);
//     // free tier limit: 15 requests/minute -> need at least 4000ms between requests
//     await new Promise((r) => setTimeout(r, 4500));
//   }

//   const validRecords = structuredRecords.filter(Boolean);
//   console.log(`\n[Agent] ${validRecords.length}/${rawCards.length} listings successfully extracted.`);

//   const uniqueRecords = deduplicateRecords(validRecords);
//   console.log(`[Agent] ${uniqueRecords.length} unique listings after removing duplicates.`);

//   await saveToExcel(uniqueRecords, query);
// }

// main().catch((err) => {
//   console.error("[Agent] Error occurred:", err);
//   process.exit(1);
// });







/**
 * CLI VERSION - runs the exact same pipeline as the Web UI (server.js),
 * just through the terminal instead of a browser.
 *
 * Works for any Google Maps search, not just mechanics - e.g. "tuition
 * teacher in Shahdara Delhi", "web development company in Noida", etc.
 *
 * Log lines now carry a level (info | warn | error); the CLI prefixes
 * warnings and errors so rate-limit / quota issues stand out instead of
 * blending in with normal progress lines.
 */
import "dotenv/config";
import prompts from "prompts";
import { runFullPipeline } from "./lib/agent.js";

function logToConsole(msg, level = "info") {
  const prefix = level === "error" ? "[Agent] \u274C" : level === "warn" ? "[Agent] \u26A0" : "[Agent]";
  console.log(`${prefix} ${msg}`);
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error("ERROR: GEMINI_API_KEY is not set in .env. Copy .env.example to .env and add your key.");
    process.exit(1);
  }

  const response = await prompts({
    type: "text",
    name: "query",
    message: 'Enter a search query (e.g. "car mechanic in Delhi", "tuition teacher in Shahdara Delhi", "web development company in Noida")',
  });

  const query = response.query;
  if (!query) {
    console.log("No query entered, exiting.");
    return;
  }

  await runFullPipeline(query.trim(), logToConsole, ".");
}

main().catch((err) => {
  console.error("[Agent] Error occurred:", err.message);
  process.exit(1);
});