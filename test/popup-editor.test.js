'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isPopupItemEditorOpen,
  popupListItemEditorIsOpen,
  isPopupListItemsViewOpen,
  popupListItemsPanel,
  popupListItemCards,
  readPopupListItems,
  openPopupListCard,
  popupImageUploadControl,
  waitForPopupImageUpload,
  planPopupItemTarget,
  isEmptyPopupItem,
  resolveAddedPopupItemTarget,
  buildPopupEntriesForTickets,
  setTimeDelaySlider
} = require('../src/cms/popup-editor');

test('readPopupListItems ignores a stale empty Vue snapshot when a populated snapshot exists', async () => {
  const snapshots = [
    'check-all-list_items-[]',
    `check-all-list_items-${JSON.stringify([
      { image: 'ticket.webp', time_end: '2026-11-26 23:59' },
      { image: '', time_start: '', time_end: '' }
    ])}`,
    'check-all-list_items-[]'
  ];
  const checkboxLocator = {
    count: async () => snapshots.length,
    nth: (index) => ({ getAttribute: async () => snapshots[index] })
  };
  const drawer = {
    locator: (selector) => selector.includes('check-all-list_items-')
      ? checkboxLocator
      : { count: async () => 0 }
  };
  const page = {
    locator: (selector) => {
      if (selector.includes('overflow-y-auto')) {
        return {
          filter: () => ({
            count: async () => 1,
            nth: () => ({
              evaluate: async () => false,
              locator: drawer.locator
            })
          })
        };
      }
      return { count: async () => 0 };
    }
  };

  const result = await readPopupListItems(page);
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].image, 'ticket.webp');
});

test('isPopupItemEditorOpen returns false when sitting in list view with Add block visible', async () => {
  const page = {
    locator: (selector) => {
      if (selector.includes('Add block')) {
        return {
          first: () => ({ isVisible: async () => true, count: async () => 1 }),
          isVisible: async () => true,
          count: async () => 1
        };
      }
      return {
        count: async () => 0,
        isVisible: async () => false,
        first: () => ({ isVisible: async () => false, count: async () => 0 }),
        filter: () => ({ first: () => ({ isVisible: async () => false, count: async () => 0 }) })
      };
    },
    getByText: (pattern) => ({
      count: async () => (editorOpened ? 1 : 0),
      nth: () => ({ isVisible: async () => editorOpened }),
      isVisible: async () => editorOpened,
      first: () => ({ isVisible: async () => editorOpened })
    }),
    waitForTimeout: async () => {}
  };

  const isOpen = await isPopupItemEditorOpen(page, 50);
  assert.equal(isOpen, false);
});

test('isPopupItemEditorOpen returns true when Click to upload image is visible', async () => {
  const page = {
    locator: () => ({
      count: async () => 0,
      isVisible: async () => false,
      first: () => ({ isVisible: async () => false, count: async () => 0 }),
      filter: () => ({ first: () => ({ isVisible: async () => false, count: async () => 0 }) })
    }),
    getByText: (pattern) => ({
      count: async () => 1,
      nth: () => ({ isVisible: async () => true }),
      isVisible: async () => true,
      first: () => ({ isVisible: async () => true })
    }),
    waitForTimeout: async () => {}
  };

  const isOpen = await isPopupItemEditorOpen(page, 50);
  assert.equal(isOpen, true);
});

test('isPopupItemEditorOpen returns true when file input is present and Add block is absent', async () => {
  const fakeFileInput = {
    isVisible: async () => true,
    count: async () => 1
  };
  const page = {
    locator: (selector) => {
      if (selector === 'input[type="file"][accept*="image" i]') {
        return {
          count: async () => 1,
          nth: () => fakeFileInput,
          first: () => fakeFileInput,
          isVisible: async () => true
        };
      }
      return {
        count: async () => 0,
        isVisible: async () => false,
        first: () => ({ isVisible: async () => false, count: async () => 0 }),
        filter: () => ({ first: () => ({ isVisible: async () => false, count: async () => 0 }) })
      };
    },
    getByText: () => ({ count: async () => 0, isVisible: async () => false, first: () => ({ isVisible: async () => false }) }),
    waitForTimeout: async () => {}
  };

  const isOpen = await isPopupItemEditorOpen(page, 50);
  assert.equal(isOpen, true);
});

test('popupListItemCards discovers cards via drag button and row container', async () => {
  const fakeCard = {
    isVisible: async () => true,
    elementHandle: async () => 'handle-card-1'
  };
  const fakeDragButton = {
    isVisible: async () => true,
    locator: (xpath) => fakeCard
  };
  const fakePanel = {
    isVisible: async () => true,
    locator: (selector) => {
      if (selector.includes('button-drag')) {
        return {
          count: async () => 1,
          nth: () => fakeDragButton
        };
      }
      return { count: async () => 0 };
    }
  };

  const page = {
    evaluate: async ([a, b]) => a === b,
    locator: (selector) => {
      if (selector.includes('Add block')) {
        return {
          first: () => ({
            isVisible: async () => true,
            locator: () => fakePanel
          }),
          count: async () => 1,
          isVisible: async () => true
        };
      }
      return { count: async () => 0, isVisible: async () => false };
    },
    getByText: () => ({ isVisible: async () => false, count: async () => 0 })
  };

  const cards = await popupListItemCards(page, 1);
  assert.equal(cards.length, 1);
  assert.equal(cards[0], fakeCard);
});

test('openPopupListCard clicks card row and waits for item editor', async () => {
  let cardClicked = false;
  let editorOpened = false;

  const fakeCard = {
    isVisible: async () => true,
    elementHandle: async () => 'handle-1',
    scrollIntoViewIfNeeded: async () => {},
    locator: () => ({
      filter: () => ({
        first: () => ({
          isVisible: async () => true,
          click: async () => {
            cardClicked = true;
            editorOpened = true;
          }
        })
      }),
      first: () => ({
        isVisible: async () => true,
        click: async () => {
          cardClicked = true;
          editorOpened = true;
        }
      })
    }),
    evaluate: async (fn) => {},
    boundingBox: async () => ({ x: 10, y: 10, width: 200, height: 60 })
  };

  const fakePanel = {
    isVisible: async () => true,
    locator: () => ({
      count: async () => 1,
      nth: () => ({
        isVisible: async () => true,
        locator: () => fakeCard
      })
    })
  };

  const page = {
    evaluate: async ([a, b]) => a === b,
    locator: (selector) => {
      if (selector.includes('Add block')) {
        return {
          first: () => ({
            isVisible: async () => !editorOpened,
            locator: () => fakePanel
          }),
          count: async () => 1,
          isVisible: async () => !editorOpened
        };
      }
      return {
        count: async () => 0,
        isVisible: async () => false,
        first: () => ({ isVisible: async () => false, count: async () => 0 }),
        filter: (c) => {
          if (editorOpened && c?.hasText && c.hasText.test('Click to upload image')) {
            return { first: () => ({ isVisible: async () => true, count: async () => 1 }) };
          }
          return { first: () => ({ isVisible: async () => false, count: async () => 0 }) };
        }
      };
    },
    getByText: (pattern) => ({
      count: async () => (editorOpened ? 1 : 0),
      nth: () => ({ isVisible: async () => editorOpened }),
      isVisible: async () => editorOpened,
      first: () => ({ isVisible: async () => editorOpened })
    }),
    mouse: { click: async () => {} },
    waitForTimeout: async () => {}
  };

  const opened = await openPopupListCard(page, 0, 'Popup card test', { timeout: 2000, expectedCount: 1 });
  assert.equal(opened, true);
  assert.equal(cardClicked, true);
});

test('popupImageUploadControl selects file input with upload image label', async () => {
  const fakePanel = { isVisible: async () => true };
  const fakeLabel = {
    isVisible: async () => true,
    innerText: async () => 'Click to upload image',
    locator: () => fakePanel
  };
  const fakeInput = {
    locator: (xpath) => fakeLabel
  };
  const page = {
    locator: (selector) => {
      if (selector === 'input[type="file"][accept*="image" i]') {
        return {
          count: async () => 1,
          nth: () => fakeInput,
          first: () => fakeInput
        };
      }
      return {
        count: async () => 0,
        filter: () => ({ first: () => ({ isVisible: async () => false }) })
      };
    },
    waitForTimeout: async () => {}
  };

  const control = await popupImageUploadControl(page, 100);
  assert.equal(control.input, fakeInput);
  assert.equal(control.panel, fakeLabel);
});

test('popupImageUploadControl accepts an extension-list input inside the exact Image panel', async () => {
  const extensionInput = {
    getAttribute: async (name) => name === 'accept' ? '.jpg, .jpeg, .png, .svg, .webp' : null
  };
  const imageInputs = {
    count: async () => 1,
    first: () => extensionInput
  };
  const imagePanel = {
    locator: (selector) => {
      assert.equal(selector, 'input[type="file"]');
      return imageInputs;
    }
  };
  const imageLabel = {
    isVisible: async () => true,
    innerText: async () => 'Image',
    locator: (selector) => {
      assert.equal(selector, 'xpath=ancestor::div[3]');
      return imagePanel;
    }
  };
  const labels = {
    count: async () => 1,
    nth: () => imageLabel
  };
  const page = {
    locator: (selector) => {
      assert.equal(selector, 'label, .el-form-item__label, [class*="form-label"]');
      return labels;
    },
    waitForTimeout: async () => {}
  };

  const control = await popupImageUploadControl(page, 100);
  assert.equal(control.input, extensionInput);
  assert.equal(control.panel, imagePanel);
});

test('waitForPopupImageUpload accepts only a preview rendered in the scoped Image panel', async () => {
  const popupPanel = {
    locator: () => ({
      evaluateAll: async () => ['https://cdn.example/ticket-poster.webp']
    })
  };
  const page = {
    on: () => { throw new Error('network fallback must not be registered'); },
    evaluate: async () => { throw new Error('page-wide image fallback must not run'); },
    waitForTimeout: async () => {}
  };

  const result = await waitForPopupImageUpload(page, popupPanel, [], 100);
  assert.equal(result.uploadedImageUrl, 'https://cdn.example/ticket-poster.webp');
});

test('buildPopupEntriesForTickets carries over all legacy items with their respective schedules without duplication', () => {
  const legacyPopups = [
    {
      imagePath: '/path/to/legacy-1.webp',
      sourceImageUrl: 'https://cdn.example/legacy-1.webp',
      start: { date: '2026-11-01' },
      end: { date: '2026-11-30' },
      imageLink: null
    },
    {
      imagePath: '/path/to/legacy-2.webp',
      sourceImageUrl: 'https://cdn.example/legacy-2.webp',
      start: null,
      end: { date: '2026-12-15' },
      imageLink: 'https://example.com/promo'
    },
    {
      imagePath: '/path/to/legacy-3.webp',
      sourceImageUrl: 'https://cdn.example/legacy-3.webp',
      start: { date: '2026-11-15' },
      end: { date: '2026-12-31' },
      imageLink: null
    }
  ];

  const ticketEntries = [
    {
      ticketIndex: 0,
      imagePath: '/path/to/new-ticket.webp',
      filename: 'new-ticket.webp',
      schedule: {
        start: null,
        end: { date: '2027-01-01' }
      }
    }
  ];

  const { entries, matchingLegacyIndexes } = buildPopupEntriesForTickets(ticketEntries, legacyPopups);

  assert.equal(entries.length, 4);
  assert.equal(matchingLegacyIndexes.length, 0);

  // Default: New ticket poster is placed at Card 1 (index 0, highest priority)
  assert.equal(entries[0].imagePath, '/path/to/new-ticket.webp');
  assert.deepEqual(entries[0].schedule, { start: null, end: { date: '2027-01-01' } });
  assert.equal(entries[0].isTicket, true);

  // Legacy items follow in their respective original order and keep schedules/links
  assert.equal(entries[1].imagePath, '/path/to/legacy-1.webp');
  assert.deepEqual(entries[1].schedule, { start: { date: '2026-11-01' }, end: { date: '2026-11-30' } });
  assert.equal(entries[1].isTicket, false);

  assert.equal(entries[2].imagePath, '/path/to/legacy-2.webp');
  assert.deepEqual(entries[2].schedule, { start: null, end: { date: '2026-12-15' } });
  assert.equal(entries[2].imageLink, 'https://example.com/promo');
  assert.equal(entries[2].isTicket, false);

  assert.equal(entries[3].imagePath, '/path/to/legacy-3.webp');
  assert.deepEqual(entries[3].schedule, { start: { date: '2026-11-15' }, end: { date: '2026-12-31' } });
  assert.equal(entries[3].isTicket, false);
});

test('buildPopupEntriesForTickets places new ticket poster at the end when popupPosition is last', () => {
  const legacyPopups = [
    {
      imagePath: '/path/to/legacy-1.webp',
      sourceImageUrl: 'https://cdn.example/legacy-1.webp',
      start: { date: '2026-11-01' },
      end: { date: '2026-11-30' }
    }
  ];

  const ticketEntries = [
    {
      ticketIndex: 0,
      imagePath: '/path/to/new-ticket.webp',
      filename: 'new-ticket.webp',
      schedule: { start: null, end: { date: '2027-01-01' } }
    }
  ];

  const { entries } = buildPopupEntriesForTickets(ticketEntries, legacyPopups, [], { popupPosition: 'last' });
  assert.equal(entries.length, 2);
  assert.equal(entries[0].imagePath, '/path/to/legacy-1.webp');
  assert.equal(entries[0].isTicket, false);
  assert.equal(entries[1].imagePath, '/path/to/new-ticket.webp');
  assert.equal(entries[1].isTicket, true);
});

test('isEmptyPopupItem correctly detects unconfigured items and planPopupItemTarget reuses them', () => {
  const emptyItem1 = { time_start: '', time_end: '', image: '', image_alt: '', link: '', html_code: '', open_new_tab: false };
  const emptyItem2 = null;
  const emptyItem3 = {};
  const emptyItem4 = { image: '   ' };
  const configuredItem = { time_start: '2026-11-20', time_end: '2026-12-01', image: 'https://cdn.example/promo.webp' };

  assert.equal(isEmptyPopupItem(emptyItem1), true);
  assert.equal(isEmptyPopupItem(emptyItem2), true);
  assert.equal(isEmptyPopupItem(emptyItem3), true);
  assert.equal(isEmptyPopupItem(emptyItem4), true);
  assert.equal(isEmptyPopupItem(configuredItem), false);

  // When list has empty item at index 0, reuse it without adding block
  const plan1 = planPopupItemTarget([emptyItem1, configuredItem]);
  assert.equal(plan1.addBlock, false);
  assert.equal(plan1.targetIndex, 0);
  assert.equal(plan1.expectedCount, 2);

  // When list has only configured items, add a new block
  const plan2 = planPopupItemTarget([configuredItem]);
  assert.equal(plan2.addBlock, true);
  assert.equal(plan2.targetIndex, null);
  assert.equal(plan2.expectedCount, 2);
});

test('buildPopupEntriesForTickets places new ticket poster at the top (Card 1) when popupPosition is first', () => {
  const legacyPopups = [
    {
      imagePath: '/path/to/legacy-green.webp',
      sourceImageUrl: 'https://cdn.example/green.webp',
      start: { date: '2026-11-23' },
      end: { date: '2026-11-27' }
    },
    {
      imagePath: '/path/to/legacy-gift.webp',
      sourceImageUrl: 'https://cdn.example/gift.webp',
      start: null,
      end: { date: '2026-11-28' }
    },
    {
      imagePath: '/path/to/legacy-turquoise.webp',
      sourceImageUrl: 'https://cdn.example/turquoise.webp',
      start: null,
      end: { date: '2027-02-03' }
    }
  ];

  const ticketEntries = [
    {
      ticketIndex: 0,
      imagePath: '/path/to/new-pink-poster.png',
      filename: 'new-pink-poster.png',
      schedule: {
        start: null,
        end: { date: '2027-02-03' }
      }
    }
  ];

  const { entries } = buildPopupEntriesForTickets(ticketEntries, legacyPopups, [], { popupPosition: 'first' });

  assert.equal(entries.length, 4);
  // Ticket poster must be at index 0 (Card 1, highest priority)
  assert.equal(entries[0].imagePath, '/path/to/new-pink-poster.png');
  assert.equal(entries[0].isTicket, true);
  assert.deepEqual(entries[0].schedule, { start: null, end: { date: '2027-02-03' } });

  // Legacy popups must follow in order
  assert.equal(entries[1].imagePath, '/path/to/legacy-green.webp');
  assert.equal(entries[1].isTicket, false);
  assert.deepEqual(entries[1].schedule, { start: { date: '2026-11-23' }, end: { date: '2026-11-27' } });

  assert.equal(entries[2].imagePath, '/path/to/legacy-gift.webp');
  assert.equal(entries[2].isTicket, false);

  assert.equal(entries[3].imagePath, '/path/to/legacy-turquoise.webp');
  assert.equal(entries[3].isTicket, false);
});

test('planPopupItemTarget enforces maxAllowedBlocks cap and does not add blocks when limit reached', () => {
  const items = [
    { image: 'img1.png', time_start: '', time_end: '2027-02-03' },
    { image: 'img2.png', time_start: '', time_end: '2027-02-03' },
    { image: 'img3.png', time_start: '', time_end: '2027-02-03' },
    { image: 'img4.png', time_start: '', time_end: '2027-02-03' }
  ];
  const target = planPopupItemTarget(items, { maxAllowedBlocks: 4, itemIndex: 2 });
  assert.equal(target.addBlock, false);
  assert.equal(target.targetIndex, 2);
  assert.equal(target.expectedCount, 4);

  // If there are empty blocks among the items, prioritize the first empty block
  const itemsWithEmpty = [
    { image: 'img1.png', time_start: '', time_end: '2027-02-03' },
    { image: '', time_start: '', time_end: '' },
    { image: 'img3.png', time_start: '', time_end: '2027-02-03' },
    { image: 'img4.png', time_start: '', time_end: '2027-02-03' }
  ];
  const targetEmpty = planPopupItemTarget(itemsWithEmpty, { maxAllowedBlocks: 4, itemIndex: 3 });
  assert.equal(targetEmpty.addBlock, false);
  assert.equal(targetEmpty.targetIndex, 1);
  assert.equal(targetEmpty.expectedCount, 4);
});

test('setTimeDelaySlider finds control, fills target value and tabs out', async () => {
  let filledValue = null;
  let tabPressed = false;
  let clicked = false;
  const mockInput = {
    isVisible: async () => true,
    getAttribute: async () => '',
    evaluate: async () => {},
    click: async () => { clicked = true; },
    fill: async (val) => { filledValue = val; },
    pressSequentially: async (val) => { filledValue = val; },
    press: async (key) => { if (key === 'Tab') tabPressed = true; },
    inputValue: async () => filledValue
  };
  const mockLabel = {
    isVisible: async () => true,
    getAttribute: async (attr) => (attr === 'for' ? 'time-delay-id' : null),
    locator: () => ({
      first: () => mockInput
    })
  };
  const page = {
    locator: (selector) => {
      if (selector === '[id="time-delay-id"]') {
        return {
          count: async () => 1,
          nth: () => mockInput,
          isVisible: async () => true,
          evaluate: mockInput.evaluate,
          click: mockInput.click,
          fill: mockInput.fill,
          press: mockInput.press,
          inputValue: mockInput.inputValue
        };
      }
      return {
        filter: () => ({
          count: async () => 1,
          nth: () => mockLabel,
          isVisible: async () => true
        }),
        count: async () => 1,
        nth: () => mockLabel,
        isVisible: async () => true
      };
    }
  };

  const res = await setTimeDelaySlider(page, 13);
  assert.equal(res.applied, true);
  assert.equal(res.value, '13');
  assert.equal(filledValue, '13');
  assert.equal(tabPressed, true);
  assert.equal(clicked, true);
});

test('setTimeDelaySlider rejects an unsafe duration before it touches CMS controls', async () => {
  await assert.rejects(
    () => setTimeDelaySlider({}, 121),
    /between 1 and 120 seconds/
  );
});

test('buildPopupEntriesForTickets preserves exact slot when an image at position 2 is replaced', () => {
  const legacyPopups = [
    {
      imagePath: '/path/to/legacy-top.webp',
      sourceImageUrl: 'https://cdn.example/top.webp',
      start: null,
      end: { date: '2026-11-26' }
    },
    {
      imagePath: '/path/to/legacy-pos2.webp',
      sourceImageUrl: 'https://cdn.example/pos2.webp',
      start: null,
      end: { date: '2026-11-27' }
    },
    {
      imagePath: '/path/to/legacy-pos3.webp',
      sourceImageUrl: 'https://cdn.example/pos3.webp',
      start: null,
      end: { date: '2026-12-01' }
    }
  ];

  const ticketEntries = [
    {
      ticketIndex: 0,
      imagePath: '/path/to/new-pos2-poster.png',
      filename: 'new-pos2-poster.png',
      schedule: { start: null, end: { date: '2026-11-30' } }
    }
  ];

  // Image at index 1 (position 2) is replaced
  const replacementMatches = [{ cmsIndex: 1, ticketIndex: 0 }];
  const { entries } = buildPopupEntriesForTickets(ticketEntries, legacyPopups, [], { replacementMatches });

  assert.equal(entries.length, 3);
  // Slot 0 (Position 1) must remain untouched
  assert.equal(entries[0].imagePath, '/path/to/legacy-top.webp');
  assert.equal(entries[0].isTicket, false);
  // Slot 1 (Position 2) must be the new ticket poster
  assert.equal(entries[1].imagePath, '/path/to/new-pos2-poster.png');
  assert.equal(entries[1].isTicket, true);
  assert.deepEqual(entries[1].schedule, { start: null, end: { date: '2026-11-30' } });
  // Slot 2 (Position 3) must remain untouched
  assert.equal(entries[2].imagePath, '/path/to/legacy-pos3.webp');
  assert.equal(entries[2].isTicket, false);
});

test('buildPopupEntriesForTickets preserves exact slot when an image at position 1 is replaced', () => {
  const legacyPopups = [
    {
      imagePath: '/path/to/legacy-top.webp',
      sourceImageUrl: 'https://cdn.example/top.webp',
      start: null,
      end: { date: '2026-11-26' }
    },
    {
      imagePath: '/path/to/legacy-pos2.webp',
      sourceImageUrl: 'https://cdn.example/pos2.webp',
      start: null,
      end: { date: '2026-11-27' }
    }
  ];

  const ticketEntries = [
    {
      ticketIndex: 0,
      imagePath: '/path/to/new-top-poster.png',
      filename: 'new-top-poster.png',
      schedule: { start: null, end: { date: '2026-11-30' } }
    }
  ];

  // Image at index 0 (position 1) is replaced
  const replacementMatches = [{ cmsIndex: 0, ticketIndex: 0 }];
  const { entries } = buildPopupEntriesForTickets(ticketEntries, legacyPopups, [], { replacementMatches });

  assert.equal(entries.length, 2);
  // Slot 0 (Position 1) must be the new ticket poster
  assert.equal(entries[0].imagePath, '/path/to/new-top-poster.png');
  assert.equal(entries[0].isTicket, true);
  // Slot 1 (Position 2) must remain untouched
  assert.equal(entries[1].imagePath, '/path/to/legacy-pos2.webp');
  assert.equal(entries[1].isTicket, false);
});


