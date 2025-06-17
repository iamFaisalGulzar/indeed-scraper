import dotenv from 'dotenv';
dotenv.config();

import { launch } from 'puppeteer';
import { Solver } from '@2captcha/captcha-solver';
import { readFileSync, existsSync } from 'fs';
import { normalizeUserAgent } from './normalize-ua.js';
import XLSX from 'xlsx';
import OpenAI from 'openai';

const solver = new Solver(process.env.APIKEY);
const openai = new OpenAI({
  baseURL: 'https://api.deepseek.com',
  apiKey: process.env.DEESEEK_API_KEY
});

const wait = ms => new Promise(r => setTimeout(r, ms));

// ──────────────────────────────────────────────────────────────────────────────
// PHASE 1.5: Check Skills tags, Licenses, and ignore‐company list
// ──────────────────────────────────────────────────────────────────────────────

// List of companies to ignore
const ignore_companies = [
  "Fidelity Investments",
  "FIS Global",
  "EY",
  "Disney",
  "Lockheed Martin",
  "Lockheed Martin Corporation",
  "Jacobs Engineering Group Inc.",
  "NTT DATA",
  "PayPal",
  "Dialysis Clinic, Inc.",
  "Discover Financial Services",
  "Coalition Technologies",
  "American Partner Solutions",
  "General Dynamics Information Technology",
  "Booz Allen",
  "Amex",
  "BAE Systems",
  "Capgemini",
  "CEDENT",
  "Infosys",
  "Peraton",
  "SAIC",
  "CVS Health",
  "Lowe's",
  "Wipro Limited",
  "Piper Companies",
  "Mochi Health",
  "JPMorganChase",
  "ECS Federal, LLC",
  "Disney Entertainment",
  "Cognizant",
  "Capital One",
  "ASRC Federal",
  "Apple",
  "Robert Half",
  "Ebay",
  "Amazon",
  "Google/Alpha",
  "Facebook/Meta",
  "Microsoft"
];

// Extract skill tags and licenses from the job details page. Returns an object:
// { skills: Array<String>, hasLicense: Boolean, companyName: String }
async function scrapeSkillsAndCheckLicenses(detailPage) {
  const result = await detailPage.evaluate(() => {
    // 1) Scrape skill tags. Indeed often uses data‐testid for skill tiles :contentReference[oaicite:1]{index=1}
    const skillElements = Array.from(
      document.querySelectorAll('[data-testid*="skill-tile"], .jobCardShelfItem--skill, .job‐tag‐list li')
    );
    const skills = skillElements.map(el => el.innerText.trim()).filter(s => s.length > 0);

    // 2) Check for license tiles (e.g., TS/SCI, Secret Clearance, Top Secret) by data‐testid
    const licenseTiles = Array.from(
      document.querySelectorAll(
        '[data-testid*="TS/SCI"], [data-testid*="Secret Clearance"], [data-testid*="Top Secret Clearance"]'
      )
    );
    const hasLicense = licenseTiles.length > 0;

    return { skills, hasLicense };
  });

  return result;
}

// ──────────────────────────────────────────────────────────────────────────────
// DeepSeek Classification (phase 3 + updated prompt logic)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * Uses deepseek-chat model to classify a job based on description AND skills array.
 * Job families:
 *   • JavaScript-family: JavaScript, TypeScript, Node.js, Nest.js, React, Next.js, Angular, Vue,
 *       MySQL, SQL, Postgres, Web development, Web design, MongoDB, AWS, Azure, GraphQL, GitHub,
 *       RestAPI, API's, AJAX, HTML, CSS, Agile, SCRUM, Jira, Debugging, DevOps,
 *       Linux, Windows, OOP, Docker, XML, Application development, communication skills
 *   • WordPress-family: WordPress, Webflow, Web development, Web design, Agile, SCRUM, Jira,
 *       Debugging, DevOps, Linux, Windows, OOP, Docker, XML, Application development, communication skills
 *   • PHP-family: PHP, Laravel, MySQL, SQL, Postgres, MongoDB, Drupal, LAMP Stack, Apache, Git,
 *       Organizational skills, Web development, Web design, MongoDB, AWS, Azure, GraphQL, GitHub,
 *       RestAPI, API's, AJAX, HTML, CSS, Agile, SCRUM, Jira, Debugging, DevOps,
 *       Linux, Windows, OOP, Docker, XML, Application development, communication skills
 *
 * RULES:
 *   1) If the “skills” array contains a majority of tags from exactly one family, choose that family.
 *   2) If the full “description” (Required Skills, Must Have, Responsibilities) also mentions EXACTLY one family, confirm that family.
 *   3) If skills and description each indicate different families, or if either mentions >1 family, OR if neither mentions any, return "OTHER".
 */
async function classifyDescriptionWithDeepSeek(description, skillsArray) {
  // 1) Convert the scraped skill tags into a comma-separated string
  const skillsListStr = skillsArray.join(", ");

  // 2) Build the system prompt. First look for any “any of the following technologies” line,
  //    and if found, assign a matching family immediately. Otherwise, fall back to skills + description logic.
  const systemPrompt = [
    {
      role: "system",
      content:
        "You are a job‐technology classification assistant. " +
        "You will receive TWO inputs in the user message:\n\n" +
        "1) A list of skill tags (comma‐separated) scraped from the job’s skill‐tag section.\n" +
        "2) The full job description text (including 'Required Skills', 'Must have', 'Responsibilities', etc.).\n\n" +
        "FIRST, look for any sentence like “Experience with any of the following technologies: X, Y, Z, …”. " +
        "If you see exactly one keyword from the following three families in that sentence, " +
        "IMMEDIATELY assign that family’s profile and skip Steps TWO and THREE. Otherwise, proceed.\n\n" +
        "FAMILIES OF KEYWORDS:\n" +
        "  • JavaScript-family: JavaScript, TypeScript, Node.js, Nest.js, React, Next.js, Angular, Vue, " +
        "MySQL, SQL, Postgres, Web development, Web design, MongoDB, AWS, Azure, Digital Ocean, GraphQL, UI development, GitHub, RestAPI, RESTful API, API's, AJAX, Relational databases, HTML, CSS, Google Cloud Platform, Software development, Databases, Computer science, Git, Visual Studio, Product management, Linux, Responsive web design,, Microsoft SQL Server, Distributed systems, Kubernetes, Terraform, Software troubleshooting, " +
        "Agile, SCRUM, Jira, Debugging, DevOps, Windows, OOP, Docker, XML, Application development, JavaScript frameworks, communication skills, Microsoft Office, Tailwind CSS, jQuery, MVC \n\n" +
        "  • WordPress-family: WordPress, Webflow, Web development, Web design, Agile, SCRUM, Jira, Google Cloud Platform, Software development, Databases, Computer science, Git, Visual Studio, Product management, Linux, Responsive web design, Software troubleshooting, " +
        "Debugging, DevOps, Windows, OOP, Docker, XML, Application development, communication skills  Microsoft Office,\n\n" +
        "  • PHP-family: PHP, Laravel, MySQL, SQL, Postgres, MongoDB, Drupal, LAMP Stack, Apache, Git, " +
        "Organizational skills, Web development, Web design, MongoDB, AWS, Azure, Digital Ocean, GraphQL, GitHub, RestAPI, RESTful API, API's, AJAX, Relational databases, HTML, CSS, Google Cloud Platform, Software development, Databases, Computer science, Git, Visual Studio, Product management, Microsoft SQL Server, Distributed systems, Kubernetes, Terraform, Software troubleshooting, " +
        "Agile, SCRUM, Jira, Debugging, DevOps, Linux, Windows, OOP, Database design, Docker, XML, Application development, communication skills, Microsoft Office, Tailwind CSS, jQuery, MVC \n\n" +
        "RULES:\n" +
        "STEP TWO (if no clear “any of the following” match):\n" +
        "  1) Examine the SKILLS LIST. If a majority of tags belong to exactly one family, that strongly indicates that profile.\n" +
        "  2) Examine DESCRIPTION sections ('Required Skills', 'Must have', 'Responsibilities', etc.). " +
        "If those sections mention exactly one family, confirm that family.\n" +
        "  3) If SKILLS tags point to one family but DESCRIPTION mentions multiple families (or vice versa), OR if both mention >1 family, OR if neither mentions any, return OTHER.\n\n" +
        "Reply exactly as: PROFILE: JS, PROFILE: WORDPRESS, PROFILE: PHP, or PROFILE: OTHER."
    }
  ];

  const userPrompt = [{
    role: "user",
    content: `Skills: ${skillsListStr}\n\nDescription:\n${description}`
  }];

  const resp = await openai.chat.completions.create({
    model: "deepseek-chat",
    messages: [...systemPrompt, ...userPrompt]
  });

  const out = resp.choices[0].message.content.trim().toUpperCase();
  if (out.includes("PROFILE: JS")) return "JS";
  if (out.includes("PROFILE: WORDPRESS")) return "WORDPRESS";
  if (out.includes("PROFILE: PHP")) return "PHP";
  return "OTHER";
}

// ————————————————————————————————————————————————————————————————————————
// Main scraping + cron + Excel de‑dupe
// ————————————————————————————————————————————————————————————————————————
async function scrapeIndeed() {
  const initialUA = await normalizeUserAgent();
  const browser = await launch({
    headless: false,
    userDataDir: './user_data',
    defaultViewport: null,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--window-size=1280,800',
      '--disable-infobars',
    ]
  });
  const [page] = await browser.pages();
  const injectJS = readFileSync('./inject.js', 'utf8');
  await page.evaluateOnNewDocument(injectJS);

  // — Phase 1: CAPTCHA solve
  let capResolve;
  const capPromise = new Promise(r => { capResolve = r; });
  let sawCap = false;
  page.on('console', async msg => {
    const t = msg.text();
    if (t.startsWith('intercepted-params:')) {
      sawCap = true;
      const p = JSON.parse(t.replace('intercepted-params:', ''));
      const r = await solver.cloudflareTurnstile(p);
      await page.evaluate(token => cfCallback(token), r.data);
      capResolve();
    }
  });

  // — Phase 2: manual login?
  const MANUAL_LOGIN = false;
  if (MANUAL_LOGIN) {
    await page.goto('https://www.indeed.com/account/login', { waitUntil: 'domcontentloaded' });
    console.log('Please log in manually (60s)…');
    await wait(60000);
    await browser.close();
    return;
  }

  // — Phase 3: Go to search results
  await page.goto('https://www.indeed.com/jobs?q=php&l=USA&fromage=1', { waitUntil: 'domcontentloaded' });
  await wait(3000);
  if (!sawCap) capResolve();
  await capPromise;
  console.log('Complete any login prompt within 30s…');
  await wait(30000);

  // — Load existing Excel for de‑dupe
  const EXCEL = 'indeed_filtered_jobs.xlsx';
  let existing = [], existingIds = new Set();
  if (existsSync(EXCEL)) {
    const wb = XLSX.readFile(EXCEL);
    const ws = wb.Sheets['FilteredJobs'] || wb.Sheets[wb.SheetNames[0]];
    existing = XLSX.utils.sheet_to_json(ws, { defval: '' });
    existing.forEach(r => existingIds.add(r.jobId));
  }

  const newJobs = [];
  let pageIdx = 1;

  // — Phase 4: paginate & scrape
  while (true) {
    await page.waitForFunction(
      () => document.querySelectorAll('.job_seen_beacon').length > 0,
      { timeout: 60000 }
    );

    const cards = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('.job_seen_beacon')).map(c => {
        // — extract jobId from href jk=…
        const a = c.querySelector('h2.jobTitle > a');
        const href = a ? a.getAttribute('href') : '';
        const url = href.startsWith('http')
          ? new URL(href)
          : new URL(href, 'https://www.indeed.com');
        const jobId = url.searchParams.get('jk') || '';
        console.log({jobId: jobId});
        
        const title = a?.innerText.trim() || '';
        const link = jobId ? `https://www.indeed.com/viewjob?jk=${jobId}` : '';
        const company = c.querySelector('[data-testid="company-name"]')?.innerText.trim() || '';
        const location = c.querySelector('[data-testid="text-location"]')?.innerText.trim() || '';
        const summary = c.querySelector('.job-snippet')?.innerText.trim() || '';

        return { jobId, title, company, location, summary, link };
      });
    });

    console.log(`Page ${pageIdx}: found ${cards.length} jobs`);

    for (let job of cards) {
      if (!job.jobId || existingIds.has(job.jobId)) continue;

      // — title check
      const U = job.title.toUpperCase();
      let profile = null;
      if (U.includes('REACT') || U.includes('JAVASCRIPT')) profile = 'JS';
      else if (U.includes('PHP')) profile = 'PHP';
      else if (U.includes('WORDPRESS')) profile = 'WORDPRESS';

      if (!profile) {
        const d = await browser.newPage();
        await d.setUserAgent(initialUA);
        await d.goto(job.link, { waitUntil: 'domcontentloaded' });

        const { skills, hasLicense } = await scrapeSkillsAndCheckLicenses(d);

        if (hasLicense ||
            ignore_companies
              .map(c => c.toUpperCase())
              .includes(job.company.toUpperCase())
        ) {
          await d.close();
          continue;
        }

        await d.waitForSelector('#jobDescriptionText', { timeout: 15000 }).catch(() => {});
        const desc = await d.evaluate(() => {
          const e = document.querySelector('#jobDescriptionText');
          return e ? e.innerText.trim() : '';
        });

        profile = await classifyDescriptionWithDeepSeek(desc, skills);
        await d.close();
      }

      job.profile = profile || 'OTHER';
      newJobs.push(job);
      existingIds.add(job.jobId);
      console.log(`+ ${job.jobId} → ${job.title} [${job.profile}]`);
    }

    // — next?
    const nxt = await page.$('a[data-testid="pagination-page-next"]');
    if (!nxt ||
        await page.evaluate(el => el.getAttribute('aria-disabled') === 'true', nxt)
    ) break;

    await Promise.all([
      page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
      nxt.click()
    ]);
    pageIdx++;
  }

  // — merge & save
  const merged = existing.concat(newJobs);
  const ws = XLSX.utils.json_to_sheet(merged);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'FilteredJobs');
  XLSX.writeFile(wb, EXCEL);
  console.log(`✅ Wrote ${merged.length} jobs to ${EXCEL}`);

  await browser.close();
}

// run now + every 20m
scrapeIndeed();
// setInterval(scrapeIndeed, 20 * 60 * 1000);
