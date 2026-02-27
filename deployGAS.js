const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const GAS_SRC = './gas/code.gs';
const GAS_DEST = path.join('gas', 'code.gs');
const isDeploy = process.argv.includes('--deploy');

function run(cmd) {
  console.log(`$ ${cmd}`);
  return execSync(cmd, { encoding: 'utf-8', stdio: 'inherit' });
}

function deployGAS() {
  // 1. .clasp.json 확인
  if (!fs.existsSync('.clasp.json')) {
    console.error('.clasp.json 파일이 없습니다. 먼저 npm run gas:login 을 실행하세요.');
    process.exit(1);
  }

  const cfg = JSON.parse(fs.readFileSync('.clasp.json', 'utf-8'));
  if (!cfg.scriptId || cfg.scriptId === 'YOUR_SCRIPT_ID_HERE') {
    console.error('.clasp.json에 scriptId를 설정해주세요.');
    console.error('  GAS 편집기 → 프로젝트 설정 → 스크립트 ID 복사');
    process.exit(1);
  }

  // 2. code.gs 동기화
  console.log('\n=== [1/2] Syncing code.gs ===');
  if (!fs.existsSync(GAS_SRC)) {
    console.error(`${GAS_SRC} 파일을 찾을 수 없습니다.`);
    process.exit(1);
  }
  fs.copyFileSync(GAS_SRC, GAS_DEST);
  console.log('  Synced.');

  // 3. clasp push
  console.log('\n=== [2/2] Pushing to Google Apps Script ===');
  run('npx clasp push');

  // 4. deploy
  const desc = new Date().toISOString().slice(0, 16).replace('T', ' ');

  if (isDeploy) {
    // 운영 배포
    console.log('\n=== [PROD] Updating production deployment ===');
    if (cfg.deploymentId) {
      run(`npx clasp deploy -i "${cfg.deploymentId}" -d "PROD ${desc}"`);
      console.log('\n운영 배포 완료!');
      console.log(`운영 URL: https://script.google.com/macros/s/${cfg.deploymentId}/exec`);
    } else {
      console.error('deploymentId가 .clasp.json에 없습니다.');
      process.exit(1);
    }
  } else {
    // 개발 배포
    console.log('\n=== [DEV] Updating dev deployment ===');
    if (cfg.devDeploymentId) {
      run(`npx clasp deploy -i "${cfg.devDeploymentId}" -d "DEV ${desc}"`);
      console.log('\n개발 배포 완료!');
      console.log(`개발 URL: https://script.google.com/macros/s/${cfg.devDeploymentId}/exec`);
    } else {
      console.error('devDeploymentId가 .clasp.json에 없습니다.');
      process.exit(1);
    }
  }
}

deployGAS();
