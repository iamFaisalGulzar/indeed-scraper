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

/**
 * Uses deepseek-chat model to classify a job description.
 * Returns one of: "JS", "PHP", or "Other".
 */
/**
 * Uses deepseek-chat model to classify a job description.
 * Checks “Required skills / must-have skills” and tags for our two groups:
 *   • JavaScript-family: JavaScript, Node.js, React, Next.js, Angular, Vue, MySQL, SQL, Postgres, MongoDB 
 *   • PHP-family: PHP, Laravel, WordPress, Webflow
 * If only JavaScript-family keywords are present → “JS”
 * If only PHP-family keywords are present → “PHP”
 * If both families appear OR neither appear → “Other”
 */
async function classifyDescriptionWithDeepSeek(description) {
  // Build a system prompt that emphasizes “must-have” or “required skills” context
  const systemPrompt = [
    {
      role: "system",
      content: 
        "You are a job-tech classification assistant. " +
        "Read the full job description (especially looking at any 'Required Skills' or 'Must have' or 'Responsibilities' section, or job tags). " +
        "There are three families of keywords:\n" +
        "  • JavaScript-family: JavaScript, Node.js, React, Next.js, Angular, Vue, MySQL, SQL, Postgres, MongoDB\n" +
        "  • WordPress-family: WordPress, Webflow\n" +
        "  • PHP-family: PHP, Laravel, MySQL, SQL, Postgres, MongoDB\n\n" +
        "If the description (in its required-skills or tags or must-have-skills, responsibilities) contains ONLY JavaScript-family keywords, " +
        "reply exactly: PROFILE: JS. " +
        "If it contains ONLY WordPress-family keywords, reply exactly: PROFILE: WordPress. " +
        "If it contains ONLY PHP-family keywords, reply exactly: PROFILE: PHP. " +
        "If it contains keywords from ALL families or Mix of more than one family, or it has neither, reply exactly: PROFILE: OTHER."
    }
  ];

  const userPrompt = [
    { role: "user", content: description }
  ];

  const response = await openai.chat.completions.create({
    model: "deepseek-chat",
    messages: systemPrompt.concat(userPrompt)
  });

  const content = response.choices[0].message.content.trim().toUpperCase();
  if (content.includes("PROFILE: JS")) return "JS";
  if (content.includes("PROFILE: PHP")) return "PHP";
  return "Other";
}

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

  // CAPTCHA solver setup
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

  // Manual login step if needed
  const MANUAL_LOGIN_REQUIRED = false;
  if (MANUAL_LOGIN_REQUIRED) {
    await page.goto('https://www.indeed.com/account/login', { waitUntil: 'domcontentloaded' });
    console.log('🚨 Please log in manually. You have 60 seconds...');
    await wait(60000);
    await browser.close();
    return;
  }

  // Start scraping at initial search URL
  await page.goto('https://www.indeed.com/jobs?q=software+engineer&l=USA&fromage=1', { waitUntil: 'domcontentloaded' });

  // Wait briefly to see if CAPTCHA runs    
  await wait(3000);
  if (!sawCaptcha) captchaSolvedResolve();
  await captchaSolvedPromise;

  // Manual login allowance
  console.log('🔐 If login is prompted, please complete within 30s...');
  await wait(30000);

  // Now begin pagination loop, collecting only “JS” or “PHP” profiles
  const filteredJobs = [];
  let pageIndex = 1;

  while (true) {
    // Wait for at least one job card to appear
    await page.waitForFunction(() => {
      return document.querySelectorAll('.job_seen_beacon').length > 0;
    }, { timeout: 60000 });

    // Extract basic info + link for each job on current page
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

    // For each job, open detail, extract full description, classify, and maybe keep
    for (const job of jobs) {
      if (!job.link) continue;

      const detailPage = await browser.newPage();
      await detailPage.setUserAgent(initialUserAgent);
      await detailPage.goto(job.link, { waitUntil: 'domcontentloaded' });

      // Wait for description container
      await detailPage.waitForSelector('#jobDescriptionText', { timeout: 15000 }).catch(() => {
        console.warn('⚠️ Description not found for', job.link);
      });

      const fullDescription = await detailPage.evaluate(() => {
        const d = document.querySelector('#jobDescriptionText');
        return d ? d.innerText.trim() : "";
      });

      // Classify using deepseek-chat
      const profile = await classifyDescriptionWithDeepSeek(fullDescription);
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

    console.log(`✅ After filtering, kept ${filteredJobs.length} jobs so far.`);

    // Attempt to click “Next” for pagination
    const nextBtn = await page.$('a[data-testid="pagination-page-next"]');
    if (nextBtn) {
      const disabled = await page.evaluate(el => el.getAttribute('aria-disabled') === 'true', nextBtn);
      if (disabled) {
        console.log('⛔ Next button disabled—last page reached.');
        break;
      }

      console.log('⏭ Moving to next page...');
      await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }),
        nextBtn.click()
      ]);

      // If Indeed redirects to a login/verification, stop scraping
      const newURL = page.url();
      if (newURL.includes('secure.indeed.com/auth') || newURL.includes('onboarding.indeed.com')) {
        console.warn('⚠️ Redirected off-job-listings. Stopping.');
        break;
      }

      pageIndex++;
    } else {
      console.log('❌ No Next button—scraping complete.');
      break;
    }
  }

  // Write filtered results to Excel, including profile column
  const ws = XLSX.utils.json_to_sheet(filteredJobs);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'FilteredJobs');
  XLSX.writeFile(wb, 'indeed_filtered_jobs.xlsx');

  console.log(`✅ Finished: ${filteredJobs.length} jobs saved to indeed_filtered_jobs.xlsx`);
  await browser.close();
}


script()

