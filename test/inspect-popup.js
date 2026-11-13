const { chromium } = require('playwright');
const { profileDirectory } = require('../src/app-paths');

async function main() {
  const context = await chromium.launchPersistentContext(profileDirectory(process.cwd()), {
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 1000 }
  });
  try {
    const page = context.pages()[0] || await context.newPage();
    const base = 'https://apps.newzensite.com/organization-74/projects/8326';
    await page.goto(`${base}/pages`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.getByText('index.yml', { exact: true }).first().click();
    await page.getByText('Content blocks', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
    const card = page.locator('div[id^="item_block_section#"]').filter({
      has: page.getByText(/^(?:Annoucement|Announcement) Popup$/)
    }).first();
    await card.getByText(/^(?:Annoucement|Announcement) Popup$/).click();
    await page.getByText('Popup_setting', { exact: true }).click();
    await page.getByRole('button', { name: 'Add block', exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    const blankLabel = page.getByText('Not configured', { exact: true }).first();
    const blankRow = blankLabel.locator('xpath=ancestor::div[.//button[contains(@class, "button-drag")]][1]');
    await blankRow.locator('button.button-drag').click();
    const menu = await page.getByRole('menu').waitFor({ state: 'visible', timeout: 5000 }).then(() => page.getByRole('menu'));
    const menuItems = await menu.getByRole('menuitem').allTextContents();
    const result = await page.evaluate(() => {
      const checkboxes = [...document.querySelectorAll('input[type="checkbox"]')]
        .map((element) => ({ name: element.name, checked: element.checked }));
      const controls = [...document.querySelectorAll('button,[role="button"]')]
        .filter((element) => /Not configured|From:|To:|List items/i.test(element.innerText || ''))
        .map((element) => ({ text: (element.innerText || '').trim(), tag: element.tagName, className: element.className }))
        .slice(-20);
      const notConfigured = [...document.querySelectorAll('*')]
        .filter((element) => element.children.length === 0 && (element.textContent || '').trim() === 'Not configured')
        .map((element) => ({
          tag: element.tagName,
          outer: element.outerHTML,
          parent: element.parentElement?.outerHTML.slice(0, 3000) || ''
        }));
      return {
        checkboxes,
        controls,
        notConfigured,
        menuItems,
        text: (document.body.innerText || '').match(/Selected Items Count[\s\S]{0,700}/)?.[0] || ''
      };
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await context.close();
  }
}

main().catch((error) => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
