const fs = require('fs');
const path = require('path');

const pkgPath = path.join(__dirname, '..', 'node_modules', 'whatsapp-rust-bridge', 'package.json');

if (fs.existsSync(pkgPath)) {
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    let changed = false;

    if (!pkg.main) {
      pkg.main = './dist/index.js';
      changed = true;
    }

    if (pkg.exports && pkg.exports['.']) {
      if (!pkg.exports['.'].require) {
        pkg.exports['.'].require = './dist/index.js';
        changed = true;
      }
      if (!pkg.exports['.'].default) {
        pkg.exports['.'].default = './dist/index.js';
        changed = true;
      }
    }

    if (changed) {
      fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 4), 'utf8');
      console.log('[Patch] Successfully patched whatsapp-rust-bridge package.json');
    }
  } catch (err) {
    console.error('[Patch] Failed to patch whatsapp-rust-bridge:', err);
  }
}
