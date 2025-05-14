import { launch } from 'puppeteer'
import { Solver } from '@2captcha/captcha-solver'
import { readFileSync } from 'fs'
import { normalizeUserAgent } from './normalize-ua.js'
import XLSX from 'xlsx'

const solver = new Solver(process.env.APIKEY)

const script = async () => {
    const initialUserAgent = await normalizeUserAgent()

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
    })

    const [page] = await browser.pages()

    const preloadFile = readFileSync('./inject.js', 'utf8')
    await page.evaluateOnNewDocument(preloadFile)

    // ✳️ Create a promise that resolves when CAPTCHA is solved
    let captchaSolvedResolve
    const captchaSolvedPromise = new Promise((resolve) => {
        captchaSolvedResolve = resolve
    })

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

                // ✅ Mark CAPTCHA as solved
                captchaSolvedResolve()
            } catch (e) {
                console.log(e.err)
                return process.exit()
            }
        }
    })

    // 🔶 Go to page and wait for CAPTCHA
    await page.goto('https://www.indeed.com/jobs?q=software+engineer&l=remote', { waitUntil: 'domcontentloaded' })

    // 🔶 Wait for CAPTCHA solving to finish before proceeding
    await captchaSolvedPromise
    console.log('✅ CAPTCHA Solved. Proceeding to job listings...')

    // ✅ Wait until job listings are available
    console.log('⏳ Waiting for job listings to load...')
    await page.waitForFunction(() => {
        const jobCards = document.querySelectorAll('.job_seen_beacon')
        return jobCards.length > 0
    }, { timeout: 60000 })
    console.log('✅ Job listings found! Extracting data...')

    // 🟢 Extract job data
    const jobs = await page.evaluate(() => {
        const jobCards = document.querySelectorAll('.job_seen_beacon')
        const jobData = []

        jobCards.forEach(card => {
            const titleElement = card.querySelector('h2.jobTitle > a')
            const title = titleElement?.innerText || null
            const link = titleElement ? `https://www.indeed.com${titleElement.getAttribute('href')}` : null
            const company = card.querySelector('[data-testid="company-name"]')?.innerText || null
            const location = card.querySelector('[data-testid="text-location"]')?.innerText || null
            const summary = card.querySelector('.job-snippet')?.innerText.trim() || null
            jobData.push({ title, company, location, summary, link })
        })

        return jobData
    })

    const worksheet = XLSX.utils.json_to_sheet(jobs)
    const workbook = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Jobs')
    XLSX.writeFile(workbook, 'indeed_jobs.xlsx')

    console.log('✅ Jobs successfully written to indeed_jobs.xlsx')
    await browser.close()
}

script()
