# Local Lead AI Agent Scraper

Ye ek **AI-powered scraping agent** hai jo Google Maps se **kisi bhi business/service ki listings**
collect karta hai — mechanic, tuition teacher, web development company, salon, clinic, kuch bhi —
aur unhe Excel sheet me save karta hai. Ab isme ek **Web UI** bhi hai — search box me query daalo,
aur end me ek "Download Excel" button mil jayega. Andar wahi exact process chalta hai jo pehle
terminal me chalta tha (scrape → AI extraction → duplicate removal → Excel file).

Query bilkul aapki marzi ka ho sakta hai, e.g.:
- `car mechanic in Delhi`
- `tuition teacher in Shahdara Delhi`
- `web development company in Noida`

Koi bhi business category hardcoded nahi hai — jo bhi search karoge, wahi scrape hoga.

## Setup (ek baar karna hai)

```bash
npm install
cp .env.example .env
```

`.env` file kholo aur apni **Gemini API key** daalo (free hai, credit card nahi chahiye):
```
GEMINI_API_KEY=AIzaxxxxxxxxxxxxxxxxxxxx
```
API key yahan se milegi: https://aistudio.google.com/apikey

## Option A — Web UI (senior ko demo dene ke liye ye use karo)

```bash
npm run web
```

Terminal me ek line dikhegi: `Mechanic Lead Scraper UI running at http://localhost:3000`

Browser me `http://localhost:3000` kholo. Wahan:
1. Search box me query daalo (e.g. "car mechanic in Delhi")
2. "Start search" dabao
3. Neeche ek live console dikhega jisme wahi progress lines aayengi jo pehle terminal me aati thi
   ("Processing 5/25", "Removed 2 duplicate listing(s)", etc.)
4. Jab process complete ho jaye, "Download Excel" button aa jayega — click karke file mil jayegi

Server chalta rehta hai jab tak terminal band na karo (Ctrl+C se rok sakte ho).

## Option B — Terminal/CLI (agar UI nahi chahiye)

```bash
npm start
```
Terminal me hi query poochega aur wahin folder me Excel file bana dega. Behavior bilkul same hai
Web UI jaisa — dono ek hi engine (`lib/agent.js`) use karte hain.

## Purane scraper se ye kaise alag hai?

| | Purana Scraper (Rule-based) | Ye Naya AI Agent |
|---|---|---|
| Data nikalne ka tarika | Fixed CSS selectors (`.class-name`) | Gemini (LLM) raw text padh kar khud samajhta hai |
| Website layout badle to? | Scraper toot jata hai | Kaam karta rehta hai, kyunki AI text ko "samajh" raha hai, selector pe depend nahi karta |
| Multiple sources (Maps, JustDial, IndiaMart) | Har site ke liye alag scraper likhna padega | Same AI extraction logic sab jagah reuse ho sakta hai |
| Missing/incomplete data | Jo mila wahi output | Agent khud retry karta hai agar koi zaroori field (jaise naam) miss ho jaye |
| "Agentic" behavior | Nahi — fixed steps | Haan — khud decide karta hai kitna scroll karna hai, kab rukna hai, kab retry karna hai |

Simple shabdon me: **purana scraper "instructions follow" karta hai, ye AI agent "samajh kar decide" karta hai.**

**Free tier limits (jaan lena zaroori hai):**
- Model use ho raha hai: `gemini-3.5-flash-lite`
- Free tier me is model ki limit hai: **15 requests/minute**
- Isliye code me har listing ke baad **4.5 second** ka gap rakha gaya hai (15 req/min ke hisaab se safe)
- Agar phir bhi kabhi "429 Too Many Requests" error aaye, agent khud 20 second wait karke retry karega (max 5 baar) — na CLI, na Web UI crash hogi, bas thoda slow ho jayegi
- Free tier ka data Google apne product improve karne ke liye use kar sakta hai — agar sensitive data hai to paid tier lena (wo bhi bahut sasta hai)

Web UI me file `mechanics_<query>_<timestamp>.xlsx` naam se `generated/` folder me save hoti hai
aur download button se milti hai. CLI me file usi folder me ban jaati hai jahan se command chalayi thi.
Dono jagah columns same rahenge: Name, Category, Phone, Email, Website, Address, Rating, Reviews Count.

## Recent fixes

- **Address language:** Ab AI ko explicitly bola gaya hai ki address hamesha English/Roman
  script me do — agar raw text me Hindi (Devanagari) mix ho, to usko transliterate karke English
  me convert karega, script mix nahi karega.
- **Email IDs:** Google Maps par email nahi hota, isliye agent har listing ki website (card se,
  ya listing ka Maps page khol ke) par jaata hai aur homepage + contact/about pages se email
  nikalta hai. Email wali listings ko final list me priority milti hai; target poora karne ke liye
  agent zaroorat pade to `MAX_SCAN_RESULTS` tak aur listings check karta hai. Jin businesses ki
  website hi nahi hai, unka email nahi mil sakta.
- **Duplicate listings:** Agent ab automatically duplicate entries hata deta hai (same name +
  phone number wali listings ek hi baar rakhi jaati hain).
- **Console messages:** Ab pura terminal output English me hai (jaise "25/25 listings successfully
  extracted"), sirf code comments Hindi me hain taaki aap khud samajh sako.

## Config options (.env me)

- `TARGET_RESULTS` — kitni listings collect karni hain (default 25)
- `EMAIL_TARGET` — kam se kam kitni listings me email chahiye (default 15)
- `MAX_SCAN_RESULTS` — email dhoondne ke liye max kitni listings scan karni hain (default 60)
- `HEADLESS` — `false` karoge to browser dikhega, dekhne me achha lagta hai demo ke liye

## Demo dete waqt senior ko kya batana hai

1. Pehle wala scraper ek fixed website structure pe depend tha.
2. Ye naya wala AI (Gemini) use karta hai jo messy/unstructured text se bhi data nikal leta hai.
3. Isliye future me agar Google Maps ka layout change ho, ya JustDial/IndiaMart jaisi
   dusri site add karni ho, sirf scraping part badalna padega — AI extraction logic wahi rahega.
4. Agent khud retry/self-correct karta hai jab data incomplete lagta hai — ye "AI agent"
   wala differentiator hai jo unhone maanga tha.

## Important note

Google Maps ka HTML structure kabhi-kabhi change hota rehta hai, isliye agar feed selector
kaam na kare to `lib/agent.js` me `feedSelector` aur `div[role='article']` wale selectors ko
DevTools se check karke update karna padega. Real production use ke liye Google Places API
(official, paid) use karna zyada stable rahega — ye scraping approach demo/prototype ke liye hai.

## Agar kabhi "model not found" / 404 error aaye

Google apne Gemini models ko time-time pe retire/upgrade karta rehta hai (jaise abhi `gemini-2.5-flash`
retire ho gaya). Agar aisa error dikhe:

```
[404 Not Found] This model models/xxxx is no longer available
```

Toh:
1. `lib/agent.js` me `gemini-3.5-flash-lite` wali line dhoondo (dono CLI aur Web UI isi file ko use karte hain)
2. https://aistudio.google.com/apikey pe jaake current free-tier models ki list check karo
3. Us naye model ka naam yahan replace kar do — baaki poora code same rahega, sirf ye ek line badalti hai

## Project structure

```
mechanic-ai-agent/
├── server.js       -> Web UI server (npm run web)
├── index.js        -> CLI version (npm start)
├── lib/agent.js    -> shared logic dono use karte hain (scrape, AI extract, dedupe, excel)
├── public/index.html -> search page jo browser me dikhta hai
├── generated/      -> Web UI se banayi hui Excel files yahan save hoti hain
├── .env            -> apni API key (ye file khud banani hai .env.example se)
└── package.json
```

## Cost summary

- **Puppeteer (scraping):** free, apne system pe chalta hai
- **Gemini API (AI extraction):** free tier — koi card nahi, bas rate-limit hai
- **Excel generation (exceljs):** free, local library
- Total cost = **₹0** demo/prototype ke liye