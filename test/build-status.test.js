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
