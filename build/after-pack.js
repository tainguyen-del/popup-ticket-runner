'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ResEdit = require('resedit');

function findRcedit() {
  const cacheBase = path.join(
    process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local'),
    'electron-builder',
    'Cache',
    'winCodeSign'
  );
  if (fs.existsSync(cacheBase)) {
    for (const dir of fs.readdirSync(cacheBase)) {
      const candidate = path.join(cacheBase, dir, 'rcedit-x64.exe');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function applyIcon(exePath, iconPath) {
  if (!fs.existsSync(exePath) || !fs.existsSync(iconPath)) {
    console.warn(`[after-pack] Missing file: exe=${exePath}, icon=${iconPath}`);
    return;
  }

  const rcedit = findRcedit();
  if (rcedit) {
    try {
      execFileSync(rcedit, [exePath, '--set-icon', iconPath], { stdio: 'pipe' });
      console.log(`[after-pack] Successfully set icon with rcedit on ${path.basename(exePath)}`);
      return;
    } catch (error) {
      console.warn(`[after-pack] rcedit failed: ${error.message}, falling back to ResEdit`);
    }
  }

  const exeData = fs.readFileSync(exePath);
  const iconData = fs.readFileSync(iconPath);
  const exe = ResEdit.NtExecutable.from(exeData);
  const res = ResEdit.NtExecutableResource.from(exe);
  const iconFile = ResEdit.Data.IconFile.from(iconData);

  const iconGroups = res.entries.filter((e) => e.type === 14);
  for (const group of iconGroups) {
    const iconId = group.id !== undefined ? group.id : group.name;
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(
      res.entries,
      iconId,
      group.lang || 1033,
      iconFile.icons.map((item) => item.data)
    );
  }

  res.outputResource(exe);
  fs.writeFileSync(exePath, Buffer.from(exe.generate()));
  console.log(`[after-pack] Successfully injected app-icon.ico with ResEdit into ${path.basename(exePath)}`);
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const projectDir = context.packager.projectDir;
  const executable = path.join(
    context.appOutDir,
    `${context.packager.appInfo.productFilename}.exe`
  );
  const icon = fs.existsSync(path.join(projectDir, 'build', 'app-icon.ico'))
    ? path.join(projectDir, 'build', 'app-icon.ico')
    : path.join(projectDir, 'build', 'icon.ico');

  applyIcon(executable, icon);
};
