import dotenv from 'dotenv';
dotenv.config();
import { launch } from 'puppeteer';
import { Solver } from '@2captcha/captcha-solver';
import { readFileSync } from 'fs';
import { normalizeUserAgent } from './normalize-ua.js';
import XLSX from 'xlsx';

const solver = new Solver(process.env.APIKEY);

const script = async () => {
    const initialUserAgent = await normalizeUserAgent();

    const browser = await launch({
        headless: false,
        userDataDir: './user_data', // <- persists cookies/session
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

    const preloadFile = readFileSync('./inject.js', 'utf8');
    await page.evaluateOnNewDocument(preloadFile);

    // CAPTCHA solver setup
    let captchaSolvedResolve;
    const captchaSolvedPromise = new Promise((resolve) => {
        captchaSolvedResolve = resolve;
    });

    page.on('console', async (msg) => {
        const txt = msg.text();
        if (txt.includes('intercepted-params:')) {
            const params = JSON.parse(txt.replace('intercepted-params:', ''));
            console.log(params);

            try {
                console.log(`Solving the captcha...`);
                const res = await solver.cloudflareTurnstile(params);
                console.log(`Solved the captcha ${res.id}`);
                await page.evaluate((token) => {
                    cfCallback(token);
                }, res.data);
                captchaSolvedResolve();
            } catch (e) {
                console.log(e.err);
                return process.exit();
            }
        }
    });

    // 🔐 STEP 1: MANUAL LOGIN (RUN ONLY ONCE)
    const MANUAL_LOGIN_REQUIRED = false; // ← CHANGE to `true` if logging in for first time
    if (MANUAL_LOGIN_REQUIRED) {
        await page.goto('https://www.indeed.com/account/login', { waitUntil: 'domcontentloaded' });
        console.log('🚨 Please log in manually. You have 60 seconds...');
        await new Promise(resolve => setTimeout(resolve, 60000)); // waits 5 seconds
        await browser.close();
        return;
    }

    // STEP 2: START SCRAPING
    await page.goto('https://www.indeed.com/jobs?q=golang+developer&l=remote', { waitUntil: 'domcontentloaded' });

    captchaSolvedPromise;

    console.log('✅ CAPTCHA Solved. Starting scraping loop...');
    const allJobs = [];

    while (true) {
        // Wait for job listings to load
        await page.waitForFunction(() => {
            const jobCards = document.querySelectorAll('.job_seen_beacon');
            return jobCards.length > 0;
        }, { timeout: 60000 });

        // Extract job data
        const jobs = await page.evaluate(() => {
            const jobCards = document.querySelectorAll('.job_seen_beacon');
            const jobData = [];

            jobCards.forEach(card => {
                const titleElement = card.querySelector('h2.jobTitle > a');
                const title = titleElement?.innerText || null;
                const link = titleElement ? `https://www.indeed.com${titleElement.getAttribute('href')}` : null;
                const company = card.querySelector('[data-testid="company-name"]')?.innerText || null;
                const location = card.querySelector('[data-testid="text-location"]')?.innerText || null;
                const summary = card.querySelector('.job-snippet')?.innerText.trim() || null;
                jobData.push({ title, company, location, summary, link });
            });

            return jobData;
        });

        console.log(`✅ Scraped ${jobs.length} jobs from current page.`);
        allJobs.push(...jobs);

        // Detect and click next page
        const nextButton = await page.$('a[data-testid="pagination-page-next"]');
        if (nextButton) {
            console.log('⏭ Navigating to next page...');
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
                nextButton.click()
            ]);

            const currentUrl = page.url();
            if (
                currentUrl.includes('secure.indeed.com/auth') ||
                currentUrl.includes('onboarding.indeed.com')
            ) {
                console.warn('⚠️ Redirected to login/auth page. Stopping scraping.');
                break;
            }
        } else {
            console.log('❌ No more pages. Scraping complete.');
            break;
        }
    }

    // Export to Excel
    const worksheet = XLSX.utils.json_to_sheet(allJobs);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Jobs');
    XLSX.writeFile(workbook, 'indeed_jobs.xlsx');

    console.log(`✅ All ${allJobs.length} jobs written to indeed_jobs.xlsx`);
    await browser.close();
};

script();
