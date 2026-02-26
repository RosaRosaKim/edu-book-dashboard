const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const DEPLOY_REPO = 'https://github.com/RosaRosaKim/edu-book-dashboard.git';
const FILE = 'edu-book-dashboard.html';

function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { encoding: 'utf-8', stdio: 'inherit', ...opts });
}

async function deploy() {
  // 1. Build
  console.log('\n=== [1/4] Building... ===');
  run('npm run build');

  if (!fs.existsSync(FILE)) {
    console.error(`Build output "${FILE}" not found.`);
    process.exit(1);
  }

  // 2. Clone deploy repo to temp dir
  console.log('\n=== [2/4] Cloning deploy repo... ===');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deploy-'));
  try {
    run(`git clone --depth 1 ${DEPLOY_REPO} "${tmp}"`);

    // 3. Copy built file
    console.log('\n=== [3/4] Copying built file... ===');
    fs.copyFileSync(FILE, path.join(tmp, FILE));

    // 4. Commit & push
    console.log('\n=== [4/4] Committing & pushing... ===');
    const msg = `Deploy: ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
    run('git add -A', { cwd: tmp });

    // Check if there are changes
    const status = execSync('git status --porcelain', { cwd: tmp, encoding: 'utf-8' }).trim();
    if (!status) {
      console.log('\nNo changes to deploy — built file is identical to remote.');
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
