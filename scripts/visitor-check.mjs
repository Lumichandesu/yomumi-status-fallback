import { appendFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { visitorObservation } from '../public/visitor-model.mjs';

const root = 'https://yomumi.moe/';
const landing = root + 'coming-soon/';
const title = 'Yomumi - Coming Soon | Every Story Begins with a Dream';
const permitted = url => url === root || url === landing;

export function classifyLanding({ url, redirects, status, mime, challenge, pageTitle, headingVisible, headingText }) {
  if (challenge || [401, 403, 429].includes(status)) return 'challenge';
  if (!status || status >= 500) return 'unavailable';
  if (status !== 200 || !permitted(url) || redirects[0] !== root || redirects.length > 2 ||
      redirects.some(target => !permitted(target)) || mime?.split(';')[0].trim().toLowerCase() !== 'text/html') return 'unexpected_page';
  return pageTitle === title && headingVisible && /\bComing\s+Soon\b/i.test(headingText) ? 'coming_soon' : 'unexpected_page';
}

export async function observeBrowser(chromium, executablePath) {
  // A new profile has no Yomumi session, owner credentials, proxy, or special request headers.
  const browser = await chromium.launch({executablePath, headless: false, chromiumSandbox:true, timeout: 20_000});
  try {
    const context = await browser.newContext({ locale:'en-US', viewport:{width:1280,height:800}, acceptDownloads:false });
    const page = await context.newPage();
    let rejectedNavigation = false;
    await page.route('**/*', async route => {
      const request = route.request();
      if (request.isNavigationRequest() && request.frame() === page.mainFrame() && !permitted(request.url())) {
        rejectedNavigation = true;
        return route.abort();
      }
      return route.continue();
    });
    const response = await page.goto(root,{waitUntil:'domcontentloaded',timeout:25_000}).catch(()=>null);
    if (rejectedNavigation) return 'unexpected_page';
    if (!response) return 'unavailable';
    const redirects=[];
    for (let request=response.request();request;request=request.redirectedFrom()) redirects.unshift(request.url());
    const headers=response.headers();
    const pageTitle=await page.title();
    const challenge = headers['cf-mitigated']==='challenge' || /just a moment|attention required/i.test(pageTitle);
    const state={url:page.url(), redirects, status:response.status(), mime:headers['content-type'], challenge, pageTitle, headingVisible:false, headingText:''};
    if (response.status() === 200 && !challenge && pageTitle === title) {
      const heading = page.locator('h1#launch-heading');
      state.headingVisible = await page.waitForFunction(() => {
        const el=document.querySelector('h1#launch-heading');
        if (!el) return false;
        const rect=el.getBoundingClientRect(), style=getComputedStyle(el);
        return style.visibility==='visible' && Number(style.opacity)>0.25 && rect.width>0 && rect.height>0;
      },null,{timeout:7000}).then(()=>true,()=>false);
      if (state.headingVisible) {
        state.headingText = await heading.innerText({timeout:2000});
      }
    }
    return classifyLanding(state);
  } finally { await browser.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.env.GITHUB_ACTIONS !== 'true' || !process.env.GITHUB_OUTPUT || process.env.RUNNER_ENVIRONMENT !== 'github-hosted') throw new Error('External checks require a GitHub-hosted runner');
  const {chromium}=await import('playwright-core');
  let result='unverified';
  try {result = await observeBrowser(chromium,'/usr/bin/google-chrome');} catch { /* Keep an inconclusive observation if the browser cannot run. */ }
  const value=JSON.stringify(visitorObservation('github_hosted',result,new Date().toISOString()));
  await appendFile(process.env.GITHUB_OUTPUT,'observation='+value+'\n');
  console.log(value); // Fixed schema only. Do not publish remote HTML, headers or runner addresses.
}
