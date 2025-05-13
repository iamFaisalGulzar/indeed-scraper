import { launch } from 'puppeteer'
import { Solver } from '@2captcha/captcha-solver'
import { readFileSync } from 'fs'
import { normalizeUserAgent } from './normalize-ua.js'
import XLSX from 'xlsx'


const solver = new Solver(process.env.APIKEY)

const script = async () => {
    // If you are using `headless: true` mode, you need to fix userAgent. NormalizeUserAgent is used for this purpose.
    const initialUserAgent = await normalizeUserAgent()

    const browser = await launch({
        headless: false,
        userDataDir: './user_data', // Store session data here
        defaultViewport: null,
        args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-blink-features=AutomationControlled',
        '--window-size=1280,800',
        '--disable-infobars',
        ]
    })

    const [page] = await browser.pages()

    const preloadFile = readFileSync('./inject.js', 'utf8');
    await page.evaluateOnNewDocument(preloadFile);

    // Here we intercept the console messages to catch the message logged by inject.js script
    page.on('console', async (msg) => {
        const txt = msg.text()
        if (txt.includes('intercepted-params:')) {
            const params = JSON.parse(txt.replace('intercepted-params:', ''))
            console.log(params)

            try {
                console.log(`Solving the captcha...`)
                const res = await solver.cloudflareTurnstile(params)
                console.log(`Solved the captcha ${res.id}`)
                console.log(res)
                await page.evaluate((token) => {
                    cfCallback(token)
                }, res.data)
            } catch (e) {
                console.log(e.err)
                return process.exit()
            }
        } else {
            return;
        }
    })
    page.goto('https://www.indeed.com/jobs?q=software+engineer&l=remote', { waitUntil: 'domcontentloaded' })
    
await page.waitForSelector('.job_seen_beacon', { timeout: 15000 }); // Wait until job cards are loaded

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


const worksheet = XLSX.utils.json_to_sheet(jobs);
const workbook = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(workbook, worksheet, "Jobs");
// console.log('Scraped Jobs:\n', jobs);
XLSX.writeFile(workbook, "indeed_jobs.xlsx");
console.log('Jobs successfully written to indeed_jobs.xlsx');


await browser.close(); 
}

script()