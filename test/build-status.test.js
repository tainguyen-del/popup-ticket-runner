const test = require('node:test');
const assert = require('node:assert/strict');
const { readBuildState, verifyFinalCmsStatus } = require('../src/run');

test('readBuildState does not mistake "Saved successfully" toast for build completion while actively building', () => {
  const text = 'Building 1% View output Saved successfully';
  const state = readBuildState(text);
  assert.equal(state.percent, 1);
  assert.equal(state.isActivelyBuilding, true);
  assert.equal(state.success, null);
  assert.equal(state.failure, null);
});

test('readBuildState recognizes authentic build completion messages', () => {
  const english = readBuildState('Building 100% Build completed successfully View output');
  assert.equal(english.percent, 100);
  assert.ok(english.success);

  const vietnamese = readBuildState('Xuất bản thành công trên website');
  assert.ok(vietnamese.success);
});

test('readBuildState recognizes build failure messages', () => {
  const failed = readBuildState('CMS Build failed with error code 500');
  assert.ok(failed.failure);

  const vietnameseFailed = readBuildState('Build xuất bản thất bại');
  assert.ok(vietnameseFailed.failure);
});

test('verifyFinalCmsStatus formats complete CMS status summary', async () => {
  const mockPage = {
    evaluate: async () => ({
      ok: true,
      statusBuild: 1,
      logIdLast: 'log-1234',
      projectStatus: 'Active',
      domain: 'test-salon.com',
      name: 'Test Salon'
    }),
    goto: async () => {},
    waitForTimeout: async () => {},
    request: {
      get: async () => ({
        status: () => 200
      })
    }
  };
  const result = await verifyFinalCmsStatus(mockPage, 'https://apps.newzensite.com/projects/1234', '1234', 'test-salon.com');
  assert.equal(result.ok, true);
  assert.equal(result.statusBuild, 1);
  assert.equal(result.statusBuildLabel, 'COMPLETE (Thành công)');
  assert.equal(result.projectStatus, 'Active');
  assert.equal(result.httpStatus, 200);
  assert.equal(result.websiteHealthy, true);
  assert.match(result.summary, /Build: COMPLETE \(Thành công\)/);
  assert.match(result.summary, /Project: Active/);
  assert.match(result.summary, /HTTP 200 OK/);
});

test('buildControl pattern correctly matches Build button with notification badge', () => {
  const pattern = /^Build(?:\.\.\.|\b)/i;
  assert.ok(pattern.test('Build...'));
  assert.ok(pattern.test('Build... 1'));
  assert.ok(pattern.test('Build... 2'));
  assert.ok(pattern.test('Build 1'));
  assert.ok(pattern.test('Build'));
  assert.equal(pattern.test('Building'), false);
  assert.equal(pattern.test('Building 50%'), false);
});

test('build confirmation dialog pattern matches all CMS confirm and save buttons', () => {
  const confirmPattern = /^(?:Save(?:\s*all)?(?:\s*changes)?|Confirm(?:\s*build)?|Save\s*&\s*build|Build|Yes|Ok)$/i;
  assert.ok(confirmPattern.test('Save all'));
  assert.ok(confirmPattern.test('Save all changes'));
  assert.ok(confirmPattern.test('Save changes'));
  assert.ok(confirmPattern.test('Save'));
  assert.ok(confirmPattern.test('Confirm'));
  assert.ok(confirmPattern.test('Confirm build'));
  assert.ok(confirmPattern.test('Save & build'));
  assert.ok(confirmPattern.test('Build'));
  assert.ok(confirmPattern.test('Yes'));
  assert.ok(confirmPattern.test('Ok'));
  assert.equal(confirmPattern.test('Cancel'), false);
  assert.equal(confirmPattern.test('Close'), false);
});
