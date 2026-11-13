const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { popupListItemCards } = require('../src/run');

test('limits popup card selection to list_items and ignores unrelated draggable fields', async (t) => {
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(async () => browser.close());
  const page = await browser.newPage();
  await page.setContent(`
    <main>
      <div id="horizontal-field" class="relative cursor-pointer">
        <span>Horizontal</span><button class="button-drag">menu</button>
      </div>
      <div id="list-items-panel">
        <label>List items</label>
        <input type="checkbox" name="check-all-list_items-[{}]" />
        <span>Selected Items Count: 0</span>
        <div id="popup-card" class="relative cursor-pointer">
          <span>Not configured</span><button class="button-drag">menu</button>
        </div>
        <button>Add block</button>
      </div>
    </main>
  `);

  const cards = await popupListItemCards(page, 1);
  assert.equal(cards.length, 1);
  assert.equal(await cards[0].getAttribute('id'), 'popup-card');
});
