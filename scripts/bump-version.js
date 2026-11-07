const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const pkgPath = path.join(repoRoot, 'package.json');
const lockPath = path.join(repoRoot, 'package-lock.json');
const cargoPath = path.join(repoRoot, 'crates', 'c-cpp-pro-native', 'Cargo.toml');

if (!fs.existsSync(pkgPath)) {
  console.error(`Error: package.json not found at ${pkgPath}`);
  process.exit(1);
}

const pkgContent = fs.readFileSync(pkgPath, 'utf8');
const pkg = JSON.parse(pkgContent);

const currentVersion = pkg.version || '0.0.0';
const versionParts = currentVersion.split('.');

const major = parseInt(versionParts[0] || '0', 10);
const minor = parseInt(versionParts[1] || '0', 10);
const patch = parseInt(versionParts[2] || '0', 10) + 1;

const newVersion = `${major}.${minor}.${patch}`;

pkg.version = newVersion;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf8');

if (fs.existsSync(lockPath)) {
  try {
    const lockContent = fs.readFileSync(lockPath, 'utf8');
    const lock = JSON.parse(lockContent);
    lock.version = newVersion;
    if (lock.packages && lock.packages['']) {
      lock.packages[''].version = newVersion;
    }
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n', 'utf8');
  } catch (err) {
    console.warn(`Warning: failed to update package-lock.json: ${err.message}`);
  }
}

if (fs.existsSync(cargoPath)) {
  let cargoContent = fs.readFileSync(cargoPath, 'utf8');
  cargoContent = cargoContent.replace(
    /^version\s*=\s*"[^"]+"/m,
    `version = "${newVersion}"`
  );
  fs.writeFileSync(cargoPath, cargoContent, 'utf8');
}

console.log(`Bumped version: ${currentVersion} -> ${newVersion}`);
