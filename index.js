import dotenv from 'dotenv';
dotenv.config();

import { launch } from 'puppeteer';
import { Solver } from '@2captcha/captcha-solver';
import { readFileSync } from 'fs';
import { normalizeUserAgent } from './normalize-ua.js';
import XLSX from 'xlsx';
import OpenAI from 'openai';

const solver = new Solver(process.env.APIKEY);

// Initialize OpenAI client pointing at DeepSeek’s base URL
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

    // 3) Scrape the company name from the detail page header
    let companyName = "";
    const compElem = document.querySelector('[data-testid="companyName"], .icl-u-lg-mr--sm');
    if (compElem) companyName = compElem.innerText.trim();

    return { skills, hasLicense, companyName };
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

  // 3) Combine the user prompt with both the skills string and the full description
  const userPrompt = [
    { role: "user", content: `Skills: ${skillsListStr}\n\nDescription:\n${description}` }
  ];

  // 4) Call the deepseek-chat model
  const response = await openai.chat.completions.create({
    model: "deepseek-chat",
    messages: systemPrompt.concat(userPrompt)
  });

  // 5) Parse the assistant’s single returned message
  const content = response.choices[0].message.content.trim().toUpperCase();
  if (content.includes("PROFILE: JS")) return "JS";
  if (content.includes("PROFILE: WORDPRESS")) return "WORDPRESS";
  if (content.includes("PROFILE: PHP")) return "PHP";
  return "OTHER";
}

// ──────────────────────────────────────────────────────────────────────────────
// Main script: combines all phases + new Title‐check logic
// ──────────────────────────────────────────────────────────────────────────────

const script = async () => {
  const initialUserAgent = await normalizeUserAgent();

  const browser = await launch({
    headless: false,
    userDataDir: './user_data', // Persist cookies/session
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
  const injectFile = readFileSync('./inject.js', 'utf8');
  await page.evaluateOnNewDocument(injectFile);

  // PHASE 1: CAPTCHA solving
  let captchaSolvedResolve;
  const captchaSolvedPromise = new Promise(resolve => (captchaSolvedResolve = resolve));
  let sawCaptcha = false;

  page.on('console', async msg => {
    const txt = msg.text();
    if (txt.startsWith('intercepted-params:')) {
      sawCaptcha = true;
      const params = JSON.parse(txt.replace('intercepted-params:', ''));
      try {
        const res = await solver.cloudflareTurnstile(params);
        await page.evaluate(token => cfCallback(token), res.data);
        captchaSolvedResolve();
      } catch (e) {
        console.error("CAPTCHA solve error:", e.err);
        process.exit(1);
      }
    }
  });

  // PHASE 2: Manual login (run once if needed)
  const MANUAL_LOGIN_REQUIRED = false;
  if (MANUAL_LOGIN_REQUIRED) {
    await page.goto('https://www.indeed.com/account/login', { waitUntil: 'domcontentloaded' });
    console.log('🚨 Please log in manually. You have 60 seconds...');
    await wait(60000);
    await browser.close();
    return;
  }

  // PHASE 3: Navigate to initial search results
  await page.goto('https://www.indeed.com/jobs?q=php+developer&l=USA&fromage=1', { waitUntil: 'domcontentloaded' });
  // If no CAPTCHA, resolve immediately
  await wait(3000);
  if (!sawCaptcha) captchaSolvedResolve();
  await captchaSolvedPromise;

  // Allow manual login if any login modal appears
  console.log('🔐 If login is prompted, please complete within 30s...');
  await wait(30000);

  // PHASE 4: Scrape, classify (with Title-check + Phase 1.5 + Phase 3), and export
  const filteredJobs = [];
  let pageIndex = 1;

  while (true) {
    // Wait for at least one job card
    await page.waitForFunction(() => {
      return document.querySelectorAll('.job_seen_beacon').length > 0;
    }, { timeout: 60000 });

    // Extract basic info + link for each job on this page
    const jobs = await page.evaluate(() => {
      const cards = document.querySelectorAll('.job_seen_beacon');
      return Array.from(cards).map(card => {
        const titleElem = card.querySelector('h2.jobTitle > a');
        const title = titleElem?.innerText || "";
        const link = titleElem
          ? "https://www.indeed.com" + titleElem.getAttribute('href')
          : "";
        const company = card.querySelector('[data-testid="company-name"]')?.innerText || "";
        const location = card.querySelector('[data-testid="text-location"]')?.innerText || "";
        const summary = card.querySelector('.job-snippet')?.innerText.trim() || "";
        return { title, company, location, summary, link };
      });
    });

    console.log(`📄 Page ${pageIndex}: Found ${jobs.length} jobs.`);

    // For each job, open detail page and do:
    //   A) Title-check → if matches React/JavaScript/PHP/WordPress, assign immediately
    //   B) Otherwise, PHASE 1.5: skills + license + ignore-company
    //   C) Then PHASE 3: DeepSeek classification
    for (const job of jobs) {
      if (!job.link) continue;

      // Convert title to uppercase for easier substring checks
      const titleUpper = job.title.toUpperCase();
      let profileFromTitle = null;

      if (titleUpper.includes("REACT") || titleUpper.includes("JAVASCRIPT")) {
        profileFromTitle = "JS";
      } else if (titleUpper.includes("PHP")) {
        profileFromTitle = "PHP";
      } else if (titleUpper.includes("WORDPRESS")) {
        profileFromTitle = "WORDPRESS";
      }

      if (profileFromTitle) {
        // If title gave us an unambiguous family, keep that without DeepSeek
        filteredJobs.push({
          title: job.title,
          company: job.company,
          location: job.location,
          summary: job.summary,
          link: job.link,
          profile: profileFromTitle
        });
        continue;
      }

      // If title didn’t match, open detail page for further checks
      const detailPage = await browser.newPage();
      await detailPage.setUserAgent(initialUserAgent);
      await detailPage.goto(job.link, { waitUntil: 'domcontentloaded' });

      // PHASE 1.5a: Scrape skills, licenses, company from detail page
      const { skills, hasLicense, companyName } = await scrapeSkillsAndCheckLicenses(detailPage);

      // If ANY license tile present → skip job entirely
      if (hasLicense) {
        console.log(`⛔ Skipping "${job.title}" because license/security requirement found.`);
        await detailPage.close();
        continue;
      }

      // If company is in ignore list → skip job entirely
      if (ignore_companies.includes(companyName)) {
        console.log(`⛔ Skipping "${job.title}" because company "${companyName}" is in ignore list.`);
        await detailPage.close();
        continue;
      }

      // PHASE 1.5b: Extract full description from #jobDescriptionText
      await detailPage.waitForSelector('#jobDescriptionText', { timeout: 15000 }).catch(() => {
        console.warn('⚠️ Description container not found for', job.link);
      });
      const fullDescription = await detailPage.evaluate(() => {
        const d = document.querySelector('#jobDescriptionText');
        return d ? d.innerText.trim() : "";
      });

      // PHASE 3: Classify with DeepSeek using both description + skills array
      const profile = await classifyDescriptionWithDeepSeek(fullDescription, skills);
      await detailPage.close();

      filteredJobs.push({
        title: job.title,
        company: job.company,
        location: job.location,
        summary: job.summary,
        link: job.link,
        profile
      });
    }

    console.log(`✅ After processing page ${pageIndex}, total jobs in list: ${filteredJobs.length}`);

    // Pagination: click Next if available
    const nextBtn = await page.$('a[data-testid="pagination-page-next"]');
    if (nextBtn) {
      const disabled = await page.evaluate(el => el.getAttribute('aria-disabled') === 'true', nextBtn);
      if (disabled) {
        console.log('⛔ Next button disabled—last page reached.');
        break;
      }
      console.log('⏭ Going to next page...');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
        nextBtn.click()
      ]);

      const newURL = page.url();
      if (newURL.includes('secure.indeed.com/auth') || newURL.includes('onboarding.indeed.com')) {
        console.warn('⚠️ Redirected off job listings. Stopping.');
        break;
      }
      pageIndex++;
    } else {
      console.log('❌ No Next button—scraping complete.');
      break;
    }
  }

  // Export all filtered jobs (including OTHER profiles) to Excel
  const ws = XLSX.utils.json_to_sheet(filteredJobs);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'FilteredJobs');
  XLSX.writeFile(wb, 'indeed_filtered_jobs.xlsx');

  console.log(`✅ Finished: ${filteredJobs.length} jobs saved to indeed_filtered_jobs.xlsx`);
  await browser.close();
};

script();
