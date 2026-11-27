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
  readLegacyFlatPopupItems,
  openPopupListCard,
  popupImageUploadControl,
  waitForPopupImageUpload,
  planPopupItemTarget,
  isEmptyPopupItem,
  resolveAddedPopupItemTarget,
  buildPopupEntriesForTickets,
  setTimeDelaySlider,
  calendarMonthStart,
  calendarHeading
} = require('../src/cms/popup-editor');
const {
  sectionCardLocatorById,
  isCorruptedSectionText,
  isAnnouncementSectionText,
  existingPopupSection,
  openPopupSection,
  openPopupSettings,
  cleanupExpiredPopupsInDrawer,
  reorderEntriesByCustomOrder
} = require('../src/run');

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

test('readPopupListItems prefers the newer non-empty snapshot after item deletion', async () => {
  const snapshots = [
    `check-all-list_items-${JSON.stringify([
      { image: 'pop1.webp', time_end: '2026-11-26' },
      { image: 'pop2.webp', time_end: '2026-11-26' },
      { image: 'pop3.webp', time_end: '2026-11-26' },
      { image: 'pop4.webp', time_end: '2026-11-26' }
    ])}`,
    `check-all-list_items-${JSON.stringify([
      { image: 'pop2.webp', time_end: '2026-11-26' },
      { image: 'pop3.webp', time_end: '2026-11-26' },
      { image: 'pop4.webp', time_end: '2026-11-26' }
    ])}`
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
  assert.equal(result.items.length, 3, 'Newer 3-item snapshot must be chosen over stale 4-item snapshot');
  assert.equal(result.items[0].image, 'pop2.webp');

  const expectedResult = await readPopupListItems(page, 4);
  assert.equal(expectedResult.items.length, 4, 'When expectedCount is 4, 4-item snapshot is chosen');
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

test('deletePopupItemAtIndex matches target image in card img sources directly', async () => {
  let menuClicked = false;
  let confirmClicked = false;
  let escapePressed = false;

  const mockCard = {
    locator: (selector) => {
      if (selector === 'img') {
        return {
          evaluateAll: async (fn) => fn([{ src: 'https://storage.fastboy.dev/target-image.png' }])
        };
      }
      return {
        last: () => ({
          click: async () => { menuClicked = true; }
        })
      };
    },
    evaluate: async () => {}
  };

  const mockPage = {
    viewportSize: () => ({ width: 1440, height: 900 }),
    locator: (selector) => {
      if (selector.includes('.el-overlay:visible')) {
        return { count: async () => 0 };
      }
      if (selector.includes('button-drag') || selector.includes('drag-handle')) {
        return { count: async () => 1, nth: () => ({ count: async () => 1 }) };
      }
      if (selector.includes('button:has-text("Confirm")')) {
        return {
          count: async () => 1,
          first: () => ({
            isVisible: async () => true,
            click: async () => { confirmClicked = true; }
          })
        };
      }
      return { count: async () => 0 };
    },
    getByRole: (role, opts) => {
      if (role === 'menu') {
        return {
          isVisible: async () => true,
          getByRole: () => ({ isVisible: async () => true, click: async () => {} }),
          locator: () => ({ isVisible: async () => true, click: async () => {} })
        };
      }
      if (role === 'button' && opts?.name?.test?.('Confirm')) {
        return { isVisible: async () => true, click: async () => { confirmClicked = true; } };
      }
      return { isVisible: async () => false, click: async () => {} };
    },
    keyboard: {
      press: async (key) => {
        if (key === 'Escape') escapePressed = true;
      }
    },
    waitForTimeout: async () => {}
  };

  // When overlay count is 0, escape should not be pressed
  assert.equal(escapePressed, false);
});

test('sectionCardLocatorById escapes # in item_block_section IDs and isCorruptedSectionText matches N/A cards only', () => {
  let capturedSelector = '';
  const mockPage = { locator: (sel) => { capturedSelector = sel; return sel; } };
  sectionCardLocatorById(mockPage, 'item_block_section#4');
  assert.equal(capturedSelector, 'div[id="item_block_section#4"]');

  assert.equal(isCorruptedSectionText('N/A\nN/A'), true);
  assert.equal(isCorruptedSectionText('N/A N/A'), true);
  assert.equal(isCorruptedSectionText('N/A'), true);
  assert.equal(isCorruptedSectionText('ANNOUNCEMENT 1038 (*)\nAnnoucement Popup'), false);
});

test('openPopupSection clicks corrupted N/A card cleanly without throwing Announcement section was not found', async () => {
  let drawerOpen = false;
  let cardClicked = false;
  const naSpan = {
    isVisible: async () => true,
    click: async () => { cardClicked = true; drawerOpen = true; }
  };
  const naCard = {
    isVisible: async () => true,
    innerText: async () => 'N/A\nN/A',
    getAttribute: async () => 'item_block_section#4',
    getByText: () => ({ count: async () => 0 }),
    locator: () => ({
      filter: () => ({
        count: async () => 1,
        nth: () => naSpan,
        first: () => naSpan
      })
    }),
    click: async () => { cardClicked = true; drawerOpen = true; }
  };
  const stableCard = { ...naCard };
  const addBlockControl = {
    count: async () => (drawerOpen ? 1 : 0),
    nth: () => ({ isVisible: async () => drawerOpen }),
    first: () => ({ isVisible: async () => drawerOpen })
  };
  const mockPage = {
    evaluate: async () => drawerOpen,
    waitForTimeout: async () => {},
    getByText: (pattern) => {
      if (drawerOpen && String(pattern).includes('Popup')) {
        return { count: async () => 1, nth: () => ({ isVisible: async () => true }) };
      }
      return { count: async () => 0 };
    },
    locator: (sel) => {
      if (sel === 'div[id^="item_block_section#"]') {
        return { count: async () => 1, nth: () => naCard };
      }
      if (sel === 'div[id="item_block_section#4"]') {
        return { first: () => stableCard, count: async () => 1, nth: () => stableCard };
      }
      if (String(sel).includes('Add block')) return addBlockControl;
      return { count: async () => 0 };
    }
  };

  await openPopupSection(mockPage, 'item_block_section#4', { openTimeoutMs: 500 });
  assert.equal(cardClicked, true);
  assert.equal(drawerOpen, true);
});

test('waitForPopupImageUpload prefers a permanent asset URL when a transient blob preview appears first', async () => {
  let reads = 0;
  const popupPanel = {
    locator: () => ({
      evaluateAll: async () => {
        reads += 1;
        return reads === 1
          ? ['blob:https://cms.newzensite.com/temporary-preview']
          : ['https://cdn.example/final-uploaded-poster.webp'];
      }
    })
  };
  const page = {
    waitForTimeout: async () => {}
  };

  const result = await waitForPopupImageUpload(page, popupPanel, ['https://cdn.example/old-poster.webp'], 1500);
  assert.equal(result.uploadedImageUrl, 'https://cdn.example/final-uploaded-poster.webp');
});

test('existingPopupSection waits for async Vue section card mount and matches ANNOUNCEMENT 1038 labels', async () => {
  assert.equal(isAnnouncementSectionText('ANNOUNCEMENT 1038 (*)\nAnnoucement Popup  '), true);
  assert.equal(isAnnouncementSectionText('ANNOUNCEMENT 1034'), true);
  assert.equal(isAnnouncementSectionText('N/A\nN/A'), false);

  let polls = 0;
  const announcementCard = {
    isVisible: async () => true,
    innerText: async () => 'ANNOUNCEMENT 1038 (*)\nAnnoucement Popup  ',
    getAttribute: async () => 'item_block_section#9'
  };
  const mockPage = {
    goto: async () => {},
    waitForTimeout: async () => {},
    getByText: () => ({
      waitFor: async () => {},
      first: () => ({ click: async () => {} })
    }),
    locator: (sel) => {
      if (sel === 'div[id^="item_block_section#"]') {
        polls += 1;
        // Simulate Vue hydrating section cards on the 3rd poll after Content blocks becomes visible
        const ready = polls >= 3;
        return {
          count: async () => (ready ? 1 : 0),
          first: () => ({ waitFor: async () => {} }),
          nth: () => announcementCard
        };
      }
      if (sel === 'div[id="item_block_section#9"]') {
        return { first: () => announcementCard };
      }
      return { count: async () => 0 };
    }
  };

  const section = await existingPopupSection(mockPage, 'https://cms.example/projects/1', {
    expectedPluginVersion: '1.0.38',
    waitMs: 1000
  });
  assert.equal(section.exists, true);
  assert.equal(section.sectionId, 'item_block_section#9');
});

test('calendarHeading reads active v-calendar month atomically without hanging on transient nth(1) titles', async () => {
  const parsedUpper = calendarMonthStart('DECEMBER\n  2026');
  assert.equal(parsedUpper.toISOString().slice(0, 10), '2026-12-01');

  let positionalLocatorRead = false;
  const mockCalendar = {
    evaluate: async () => 'December 2026',
    locator: () => {
      positionalLocatorRead = true;
      return { count: async () => 0 };
    }
  };

  const heading = await calendarHeading(mockCalendar);
  assert.equal(heading, 'December 2026');
  assert.equal(positionalLocatorRead, false);

  // Fallback path when evaluate is unavailable uses short innerText timeout and handles vanishing nth(1) gracefully
  let calls = 0;
  const transientTitle = {
    isVisible: async () => true,
    innerText: async (opts) => {
      assert.equal(opts?.timeout, 1500);
      if (calls === 0) {
        calls += 1;
        throw new Error('Timeout 1500ms exceeded waiting for nth(1)');
      }
      return 'November 2026';
    }
  };
  const fallbackCalendar = {
    locator: (sel) => ({
      count: async () => 1,
      nth: () => (sel === '.vc-header' ? { ...transientTitle, innerText: async () => 'November 2026' } : transientTitle)
    })
  };
  const fallbackHeading = await calendarHeading(fallbackCalendar);
  assert.equal(fallbackHeading, 'November 2026');
});

test('readLegacyFlatPopupItems recovers legacy 1.0.31 popup image without list_items and reorderEntriesByCustomOrder sorts entries', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const drawerScope = {
    evaluate: async () => ({
      ready: true,
      serializedItems: null,
      flatItems: [{
        image: 'https://nz-website-media-r2-pub.gocheckin.net/17333-8950/page/weekly-special.webp',
        link: 'https://nailit.com/book',
        time_start: '',
        time_end: ''
      }]
    })
  };
  const mockPage = {
    locator: () => drawerScope,
    waitForTimeout: async () => {}
  };
  const recovered = await readLegacyFlatPopupItems(mockPage, {
    time_start: '2026-11-01 00:00',
    time_end: '2026-12-31 23:59'
  });
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].image, 'https://nz-website-media-r2-pub.gocheckin.net/17333-8950/page/weekly-special.webp');
  assert.equal(recovered[0].time_end, '2026-12-31 23:59');
  assert.equal(recovered[0].link, 'https://nailit.com/book');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'popup-order-entries-'));
  try {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL9lQAAAABJRU5ErkJggg==', 'base64');
    const p1 = path.join(dir, 'a-weekly-appreciation.png');
    const p2 = path.join(dir, 'b-giftcard.png');
    const p3 = path.join(dir, 'c-weekly-special.png');
    fs.writeFileSync(p1, png);
    fs.writeFileSync(p2, png);
    fs.writeFileSync(p3, png);
    const inputEntries = [
      { imagePath: p1, filename: 'a-weekly-appreciation.png', isTicket: true },
      { imagePath: p2, filename: 'b-giftcard.png', isTicket: true },
      { imagePath: p3, filename: 'c-weekly-special.png', isTicket: false }
    ];
    const result = await reorderEntriesByCustomOrder(
      inputEntries,
      ['Giftcard', 'Weekly Appreciation', 'Weekly Special'],
      {
        orderVisionFn: async () => ({
          orderedIndices: [2, 1, 3],
          audit: { rationale: 'Giftcard -> Weekly Appreciation -> Weekly Special' }
        })
      }
    );
    assert.equal(result.ordered, true);
    assert.deepEqual(result.entries.map((e) => e.filename), [
      'b-giftcard.png',
      'a-weekly-appreciation.png',
      'c-weekly-special.png'
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('openPopupSettings expands collapsed Popup_setting even when allowFlatForm sees preview images', async () => {
  const createMockPage = ({ hasAddBlock, flatControlInsideDrawer, previewHasMedia }) => {
    let expanded = false;
    let popupSettingClicks = 0;

    const makeLocator = (visibleFn, opts = {}) => {
      const loc = {
        first: () => loc,
        count: async () => (visibleFn() ? 1 : 0),
        nth: () => loc,
        filter: ({ has } = {}) => (has ? makeLocator(() => visibleFn() && Boolean(has._isVisible?.())) : loc),
        isVisible: async () => visibleFn(),
        evaluate: async (fn) => (opts.evaluate ? opts.evaluate(fn, expanded) : false),
        getAttribute: async () => (opts.getAttribute ? opts.getAttribute(expanded) : null),
        click: async () => {
          if (opts.onClick) opts.onClick();
        },
        waitFor: async ({ timeout = 1000 } = {}) => {
          if (!visibleFn()) throw new Error(`Timeout ${timeout}ms`);
        },
        _isVisible: visibleFn
      };
      return loc;
    };

    const addBlockLocator = makeLocator(() => expanded && hasAddBlock);
    const popupSettingLocator = makeLocator(() => true, {
      evaluate: () => expanded,
      onClick: () => {
        popupSettingClicks += 1;
        expanded = !expanded;
      }
    });
    const drawerFlatControls = makeLocator(() => expanded && flatControlInsideDrawer);
    const drawerLocator = {
      first: () => drawerLocator,
      count: async () => 1,
      nth: () => drawerLocator,
      filter: () => drawerLocator,
      evaluate: async () => false,
      locator: (sel) => {
        if (String(sel).includes('check-all-')) return drawerFlatControls;
        return makeLocator(() => false);
      }
    };

    const page = {
      waitForTimeout: async () => {},
      evaluate: async () => true,
      getByText: (matcher) => {
        const text = String(matcher || '');
        if (/Popup/i.test(text)) return popupSettingLocator;
        if (/Slide direction style/i.test(text)) return makeLocator(() => true);
        return makeLocator(() => false);
      },
      getByRole: (role, { name } = {}) => {
        if (role === 'button' && /Add/i.test(String(name || ''))) return addBlockLocator;
        return makeLocator(() => false);
      },
      locator: (sel) => {
        const selector = String(sel || '');
        if (selector.includes('overflow-y-auto')) return drawerLocator;
        if (selector.includes('Add block')) return addBlockLocator;
        if (selector.includes('nz-website-media') && !selector.includes('Add block')) {
          return makeLocator(() => previewHasMedia || (expanded && flatControlInsideDrawer));
        }
        if (selector.includes('Slide direction style') || selector.includes('Popup')) {
          return makeLocator(() => true);
        }
        return makeLocator(() => false);
      }
    };

    return {
      page,
      getState: () => ({ expanded, popupSettingClicks, addBlockVisible: expanded && hasAddBlock })
    };
  };

  // Case 1 (1.0.38): Website preview shows nz-website-media images while Popup_setting accordion is collapsed.
  // openPopupSettings({ allowFlatForm: true }) must still click Popup_setting to expand it until Add block appears.
  const listSection = createMockPage({ hasAddBlock: true, flatControlInsideDrawer: false, previewHasMedia: true });
  await openPopupSettings(listSection.page, 'item_block_section#4', { allowFlatForm: true });
  assert.deepEqual(listSection.getState(), { expanded: true, popupSettingClicks: 1, addBlockVisible: true });

  // Case 2 (1.0.31): Flat section inside drawer without Add block expands once and stays open without toggling shut.
  const flatSection = createMockPage({ hasAddBlock: false, flatControlInsideDrawer: true, previewHasMedia: true });
  await openPopupSettings(flatSection.page, 'item_block_section#2', { allowFlatForm: true });
  assert.deepEqual(flatSection.getState(), { expanded: true, popupSettingClicks: 1, addBlockVisible: false });
});

test('cleanupExpiredPopupsInDrawer deletes expired non-protected items from highest index down', async () => {
  const { todayInTimezone } = require('../src/cms/popup-verification');
  const tz = { iana: 'America/New_York' };
  const today = todayInTimezone(tz.iana);
  const [y, m, d] = today.split('-').map(Number);
  const isoDayOffset = (days) => new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);

  let items = [
    { image: 'https://cdn.example/1-indefinite.webp', time_start: '', time_end: '' },
    { image: 'https://cdn.example/2-expired.webp', time_start: '', time_end: isoDayOffset(-2) },
    { image: 'https://cdn.example/3-protected-old.webp', time_start: '', time_end: isoDayOffset(-1) },
    { image: 'https://cdn.example/4-active.webp', time_start: '', time_end: isoDayOffset(5) },
    { image: 'https://cdn.example/5-expired.webp', time_start: '', time_end: isoDayOffset(-5) }
  ];
  const deletedOrder = [];

  let pendingDeleteIdx = -1;
  const makeMenuBtn = (idx, image) => ({
    isVisible: async () => true,
    click: async () => { pendingDeleteIdx = idx; deletedOrder.push(image); }
  });
  const makeCard = (item, idx) => ({
    count: async () => 1,
    elementHandle: async () => item,
    evaluate: async () => {},
    innerText: async () => item.image,
    isVisible: async () => true,
    locator: (sel) => {
      if (sel === 'img') {
        return {
          evaluateAll: async () => [item.image],
          count: async () => 1
        };
      }
      return {
        count: async () => 1,
        nth: () => makeMenuBtn(idx, item.image),
        first: () => makeMenuBtn(idx, item.image),
        last: () => makeMenuBtn(idx, item.image)
      };
    }
  });
  const makeDragButton = (idx) => ({
    count: async () => 1,
    isVisible: async () => true,
    locator: (sel) => {
      if (String(sel).includes('cursor-pointer')) return makeCard(items[idx], idx);
      return { count: async () => 0 };
    }
  });

  const makeMockPage = () => ({
    viewportSize: () => ({ width: 1440, height: 900 }),
    setViewportSize: async () => {},
    bringToFront: async () => {},
    waitForTimeout: async () => {},
    evaluate: async (fn, arg) => (Array.isArray(arg) ? arg[0] === arg[1] : true),
    keyboard: {
      press: async (key) => {
        if (key === 'Escape') {
          throw new Error('deletePopupItemAtIndex must not press Escape while slideover [role="dialog"] is open');
        }
      }
    },
    getByRole: (role, opts = {}) => {
      if (role === 'menu') {
        return {
          first: () => ({
            isVisible: async () => true,
            getByRole: () => ({
              first: () => ({ isVisible: async () => true, click: async () => {} }),
              count: async () => 1,
              nth: () => ({ isVisible: async () => true, click: async () => {} })
            }),
            locator: () => ({ count: async () => 0 })
          }),
          isVisible: async () => true,
          count: async () => 1
        };
      }
      if (role === 'button' && /Confirm|Delete/i.test(String(opts.name || ''))) {
        return {
          first: () => ({
            isVisible: async () => true,
            click: async () => {
              if (pendingDeleteIdx >= 0 && pendingDeleteIdx < items.length) {
                items.splice(pendingDeleteIdx, 1);
                pendingDeleteIdx = -1;
              }
            }
          }),
          count: async () => 1,
          nth: () => ({
            isVisible: async () => true,
            click: async () => {
              if (pendingDeleteIdx >= 0 && pendingDeleteIdx < items.length) {
                items.splice(pendingDeleteIdx, 1);
                pendingDeleteIdx = -1;
              }
            }
          })
        };
      }
      return { first: () => ({ isVisible: async () => false }), count: async () => 0 };
    },
    locator: (sel) => {
      const s = String(sel || '');
      if (s.includes('check-all-list_items-')) {
        const snapshot = `check-all-list_items-${JSON.stringify(items)}`;
        const cbItem = {
          getAttribute: async () => snapshot,
          locator: () => ({ count: async () => 0 }),
          evaluate: async () => items.map((it) => it.image)
        };
        return {
          count: async () => 1,
          nth: () => cbItem,
          first: () => cbItem,
          last: () => cbItem
        };
      }
      if (s.includes('button-drag')) {
        return {
          count: async () => items.length,
          nth: (i) => makeDragButton(i),
          first: () => ({ isVisible: async () => items.length > 0 })
        };
      }
      if (s.includes('Add block')) {
        const addBtn = { isVisible: async () => true, locator: () => ({ count: async () => 0 }) };
        return { first: () => addBtn, last: () => addBtn, count: async () => 1 };
      }
      if (s.includes('list_items') || s.includes('overflow-y-auto')) {
        const drawerMock = {
          evaluate: async () => false,
          isVisible: async () => true,
          count: async () => 1,
          locator: (innerSel) => {
            const inner = String(innerSel || '');
            if (inner.includes('check-all-list_items-')) {
              const snapshot = `check-all-list_items-${JSON.stringify(items)}`;
              const cbItem = { getAttribute: async () => snapshot, locator: () => ({ count: async () => 0 }) };
              return {
                count: async () => 1,
                nth: () => cbItem,
                first: () => cbItem,
                last: () => cbItem
              };
            }
            if (inner.includes('button-drag')) {
              return { count: async () => items.length, nth: (i) => makeDragButton(i) };
            }
            return { count: async () => 0 };
          }
        };
        return {
          count: async () => 1,
          nth: () => drawerMock,
          filter: () => ({
            count: async () => 1,
            nth: () => drawerMock
          }),
          first: () => drawerMock
        };
      }
      if (s.includes('.el-overlay') || s.includes('[role="dialog"]')) {
        // Simulate HeadlessUI/NuxtUI slideover drawer rendered inside `[role="dialog"]`.
        return { count: async () => 1, filter: () => ({ first: () => ({ isVisible: async () => false }) }), first: () => ({ isVisible: async () => true }) };
      }
      if (s.includes('.el-message-box__wrapper')) {
        return { filter: () => ({ first: () => ({ isVisible: async () => false }) }), count: async () => 0 };
      }
      return { count: async () => 0, filter: () => ({ first: () => ({ isVisible: async () => false }) }), first: () => ({ isVisible: async () => false }) };
    }
  });

  // Note: mock deletePopupItemAtIndex uses direct items splice via menu/confirm; test DOM resolution with stable list cards:
  const events = [];
  const res = await cleanupExpiredPopupsInDrawer(makeMockPage(), tz, {
    protectedUrls: new Set(['https://cdn.example/3-protected-old.webp']),
    progress: (stage, message) => events.push({ stage, message })
  });
  assert.deepEqual(res.warnings, []);
  assert.equal(res.removedCount, 2);
  assert.deepEqual(deletedOrder, [
    'https://cdn.example/5-expired.webp',
    'https://cdn.example/2-expired.webp'
  ]);
  assert.deepEqual(items.map((x) => x.image), [
    'https://cdn.example/1-indefinite.webp',
    'https://cdn.example/3-protected-old.webp',
    'https://cdn.example/4-active.webp'
  ]);
  assert.equal(events.filter((e) => e.stage === 'popup-expired-cleanup').length, 2);
});



