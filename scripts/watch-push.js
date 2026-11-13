'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const WATCH_DIRS = ['src', 'public', 'electron', 'build', 'test'];
const DEBOUNCE_MS = 6000;

const IGNORE_PATTERNS = [
  /[\\/]\.git([\\/]|$)/,
  /[\\/]dist([\\/]|$)/,
  /[\\/]node_modules([\\/]|$)/,
  /\.(exe|bin|log|tmp|swp)$/i,
  /storage-state\.json$/
];

let timer = null;
let pendingFiles = new Set();
let isPushing = false;

function shouldIgnore(filePath) {
  return IGNORE_PATTERNS.some((pat) => pat.test(filePath));
}

function doPush() {
  if (isPushing) return;
  isPushing = true;
  try {
    const status = execSync('git status --porcelain', { cwd: ROOT_DIR, encoding: 'utf8' }).trim();
    if (!status) {
      console.log('⚡ [Auto-Push] Không có thay đổi nào mới.');
      isPushing = false;
      return;
    }

    const changedCount = pendingFiles.size;
    pendingFiles.clear();
    const now = new Date().toLocaleString('vi-VN', { hour12: false });
    const msg = `Auto update: ${now} (${changedCount} files)`;

    console.log(`\n🚀 [Auto-Push] Phát hiện thay đổi, bắt đầu đẩy lên GitHub...`);
    execSync('git add .', { cwd: ROOT_DIR, stdio: 'inherit' });
    execSync(`git commit -m "${msg}"`, { cwd: ROOT_DIR, stdio: 'inherit' });
    console.log(`📡 [Auto-Push] Đang đẩy lên origin main...`);
    execSync('git push origin main', { cwd: ROOT_DIR, stdio: 'inherit' });
    console.log(`✅ [Auto-Push] Đã đẩy thành công lên GitHub! GitHub Actions đang tự động build và upload Release.`);
  } catch (error) {
    console.error(`❌ [Auto-Push] Lỗi khi đẩy code:`, error.message);
  } finally {
    isPushing = false;
  }
}

function schedulePush(filePath) {
  if (shouldIgnore(filePath)) return;
  pendingFiles.add(path.basename(filePath));
  console.log(`📝 [File Saved] ${path.basename(filePath)} thay đổi. Sẽ tự động push sau ${DEBOUNCE_MS / 1000}s...`);

  if (timer) clearTimeout(timer);
  timer = setTimeout(doPush, DEBOUNCE_MS);
}

console.log('👀 [Watcher] Đang theo dõi các thư mục:', WATCH_DIRS.join(', '));
console.log('💡 Mẹo: Khi bạn sửa và lưu file trong VS Code, code sẽ tự động được commit và đẩy lên GitHub!');

for (const dir of WATCH_DIRS) {
  const fullPath = path.join(ROOT_DIR, dir);
  if (!fs.existsSync(fullPath)) continue;
  try {
    fs.watch(fullPath, { recursive: true }, (eventType, filename) => {
      if (filename) schedulePush(path.join(fullPath, filename));
    });
  } catch (err) {
    console.warn(`[Watcher] Không thể theo dõi thư mục ${dir}:`, err.message);
  }
}
