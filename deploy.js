const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEPLOY_REPO = 'https://github.com/RosaRosaKim/edu-book-dashboard.git';
const DIST_DIR = 'dist';

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { encoding: 'utf-8', stdio: 'inherit', ...opts });
}

function copyDirSync(src, dest) {
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src)) {
    const srcPath = path.join(src, entry);
    const destPath = path.join(dest, entry);
    if (fs.statSync(srcPath).isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

async function deploy() {
  // 1. Build
  console.log('\n=== [1/4] Building... ===');
  run('npm run build');

  if (!fs.existsSync(DIST_DIR)) {
    console.error(`Build output directory "${DIST_DIR}" not found.`);
    process.exit(1);
  }

  // 2. Clone deploy repo to temp dir
  console.log('\n=== [2/4] Cloning deploy repo... ===');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-'));
  try {
    run(`git clone --depth 1 ${DEPLOY_REPO} "${tmp}"`);

    // 3. Copy dist/ contents to deploy repo root
    console.log('\n=== [3/4] Copying dist/ to deploy repo... ===');
    copyDirSync(DIST_DIR, tmp);

    // 파일 목록 출력
    const listFiles = (dir, prefix = '') => {
      for (const entry of fs.readdirSync(dir)) {
        const full = path.join(dir, entry);
        if (fs.statSync(full).isDirectory()) {
          listFiles(full, prefix + entry + '/');
        } else {
          console.log(`  ${prefix}${entry}`);
        }
      }
    };
    listFiles(DIST_DIR);

    // 4. Commit & push
    console.log('\n=== [4/4] Committing & pushing... ===');
    const msg = `Deploy: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    run('git add -A', { cwd: tmp });

    // Check if there are changes
    const status = execSync('git status --porcelain', { cwd: tmp, encoding: 'utf-8' }).trim();
    if (!status) {
      console.log('\nNo changes to deploy — built files are identical to remote.');
      return;
    }

    run(`git commit -m "${msg}"`, { cwd: tmp });
    run('git push', { cwd: tmp });

    console.log(`\nDeployed successfully to ${DEPLOY_REPO}`);
  } finally {
    // Cleanup temp dir
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

deploy().catch(err => {
  console.error('Deploy failed:', err.message);
  process.exit(1);
});
