const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const CleanCSS = require('clean-css');
const { minify: minifyHTML } = require('html-minifier-terser');
const JavaScriptObfuscator = require('javascript-obfuscator');

const SRC_DIR = 'src/html';
const DIST_DIR = 'dist';
const IMG_DIR = 'src/img';
const CSS_DIR = 'src/css';

async function buildFile(inputFile, outputFile) {
  console.log(`\n========== Building ${inputFile} ==========`);
  console.log(`[1/5] Reading ${inputFile}...`);
  let html = fs.readFileSync(inputFile, 'utf-8');

  // ── Replace GAS dev deployment URL with prod URL (before obfuscation) ──
  const clasp = JSON.parse(fs.readFileSync('.clasp.json', 'utf-8'));
  if (clasp.deploymentId) {
    const prodUrl = `https://script.google.com/macros/s/${clasp.deploymentId}/exec`;
    // HEAD deployment URL → prod
    if (clasp.headDeploymentId) {
      const headUrl = `https://script.google.com/macros/s/${clasp.headDeploymentId}/exec`;
      html = html.replace(new RegExp(headUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), prodUrl);
    }
    // Legacy dev deployment URL → prod
    if (clasp.devDeploymentId) {
      const devUrl = `https://script.google.com/macros/s/${clasp.devDeploymentId}/exec`;
      html = html.replace(new RegExp(devUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), prodUrl);
    }
  }

  // ── Replace dev paths before obfuscation (so JS string literals are also replaced) ──
  html = html.replace(/\.\.\/img\//g, 'img/');
  html = html.replace(/\.\.\/css\//g, 'css/');
  html = html.replace(/dev-edu-book-dashboard\.html/g, 'edu-book-dashboard.html');
  html = html.replace(/dev-admin-dashboard\.html/g, 'admin-dashboard.html');
  html = html.replace(/\.\.\/data\//g, 'data/');

  const $ = cheerio.load(html, { decodeEntities: false });

  // ── Process inline <script> blocks ──
  const scripts = $('script').toArray();
  for (const scriptEl of scripts) {
    const el = $(scriptEl);
    if (el.attr('src')) continue; // skip external (CDN) scripts

    const code = el.html();
    if (!code || !code.trim()) continue;

    if (code.includes('tailwind.config')) {
      console.log('[2/5] Minifying tailwind.config script...');
      try {
        const terser = require('terser');
        const result = await terser.minify(code, {
          compress: { defaults: false },
          mangle: false,
          format: { comments: false },
        });
        if (result.code) el.html(result.code);
      } catch {
        const minified = code
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '')
          .replace(/\n\s*/g, '')
          .replace(/\s{2,}/g, ' ')
          .trim();
        el.html(minified);
      }
    } else {
      console.log('[3/5] Stripping console calls & obfuscating main script...');
      const terser = require('terser');
      const stripped = await terser.minify(code, {
        compress: { drop_console: true },
        mangle: false,
        format: { comments: true, beautify: true },
      });
      const cleanCode = stripped.code || code;

      const result = JavaScriptObfuscator.obfuscate(cleanCode, {
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.5,
        deadCodeInjection: false,
        debugProtection: false,
        disableConsoleOutput: false,
        identifierNamesGenerator: 'hexadecimal',
        log: false,
        numbersToExpressions: true,
        renameGlobals: false,
        renameProperties: false,
        selfDefending: false,
        simplify: true,
        splitStrings: true,
        splitStringsChunkLength: 10,
        stringArray: true,
        stringArrayCallsTransform: true,
        stringArrayEncoding: ['base64'],
        stringArrayIndexShift: true,
        stringArrayRotate: true,
        stringArrayShuffle: true,
        stringArrayWrappersCount: 2,
        stringArrayWrappersChainedCalls: true,
        stringArrayWrappersType: 'function',
        stringArrayThreshold: 0.75,
        transformObjectKeys: false,
        unicodeEscapeSequence: false,
      });
      el.html(result.getObfuscatedCode());
    }
  }

  // ── Process inline <style> blocks ──
  $('style').each(function () {
    const el = $(this);
    const css = el.html();
    if (!css || !css.trim()) return;

    console.log('[4/5] Minifying CSS...');
    const result = new CleanCSS({ level: 2 }).minify(css);
    if (result.styles) {
      el.html(result.styles);
    }
  });

  // ── Minify entire HTML ──
  console.log('[5/5] Minifying HTML...');
  let output = $.html();
  output = await minifyHTML(output, {
    collapseWhitespace: true,
    removeComments: true,
    removeRedundantAttributes: true,
    removeEmptyAttributes: true,
    minifyJS: false,
    minifyCSS: false,
  });

  // ── (paths already replaced before obfuscation above) ──

  fs.writeFileSync(outputFile, output, 'utf-8');

  const sizeKB = (Buffer.byteLength(output, 'utf-8') / 1024).toFixed(1);
  console.log(`\nBuild complete: ${outputFile} (${sizeKB} KB)`);

  return output;
}

function validate(label, output, checks) {
  console.log(`\n--- Validation: ${label} ---`);
  let allPass = true;
  checks.forEach(([name, pass]) => {
    console.log(`  ${pass ? 'PASS' : 'FAIL'} ${name}`);
    if (!pass) allPass = false;
  });
  return allPass;
}

/**
 * 모듈 HTML 파일 빌드 (미니파이만)
 */
async function buildModule(inputFile, outputFile) {
  console.log(`\n--- Module: ${path.basename(inputFile)} ---`);
  let html = fs.readFileSync(inputFile, 'utf-8');
  // ── Replace dev paths before obfuscation ──
  html = html.replace(/\.\.\/img\//g, 'img/');
  html = html.replace(/\.\.\/css\//g, 'css/');
  html = html.replace(/\.\.\/data\//g, 'data/');
  const $ = cheerio.load(html, { decodeEntities: false });

  // ── Process inline <script> blocks: console 삭제 + 난독화 ──
  const terser = require('terser');
  const scripts = $('script').toArray();
  for (const scriptEl of scripts) {
    const el = $(scriptEl);
    if (el.attr('src')) continue;
    const code = el.html();
    if (!code || !code.trim()) continue;

    console.log(`  [JS] Stripping console & obfuscating...`);
    const stripped = await terser.minify(code, {
      compress: { drop_console: true },
      mangle: false,
      format: { comments: true, beautify: true },
    });
    const cleanCode = stripped.code || code;

    const result = JavaScriptObfuscator.obfuscate(cleanCode, {
      compact: true,
      controlFlowFlattening: true,
      controlFlowFlatteningThreshold: 0.5,
      deadCodeInjection: false,
      debugProtection: false,
      disableConsoleOutput: false,
      identifierNamesGenerator: 'hexadecimal',
      log: false,
      numbersToExpressions: true,
      renameGlobals: false,
      renameProperties: false,
      selfDefending: false,
      simplify: true,
      splitStrings: true,
      splitStringsChunkLength: 10,
      stringArray: true,
      stringArrayCallsTransform: true,
      stringArrayEncoding: ['base64'],
      stringArrayIndexShift: true,
      stringArrayRotate: true,
      stringArrayShuffle: true,
      stringArrayWrappersCount: 2,
      stringArrayWrappersChainedCalls: true,
      stringArrayWrappersType: 'function',
      stringArrayThreshold: 0.75,
      transformObjectKeys: false,
      unicodeEscapeSequence: false,
    });
    el.html(result.getObfuscatedCode());
  }

  // ── Process inline <style> blocks ──
  $('style').each(function () {
    const el = $(this);
    const css = el.html();
    if (!css || !css.trim()) return;
    console.log(`  [CSS] Minifying...`);
    const minResult = new CleanCSS({ level: 2 }).minify(css);
    if (minResult.styles) el.html(minResult.styles);
  });

  // ── Minify entire HTML ──
  let output = $.html();
  output = await minifyHTML(output, {
    collapseWhitespace: true,
    removeComments: true,
    removeRedundantAttributes: true,
    removeEmptyAttributes: true,
    minifyJS: false,
    minifyCSS: false,
  });

  fs.writeFileSync(outputFile, output, 'utf-8');
  const sizeKB = (Buffer.byteLength(output, 'utf-8') / 1024).toFixed(1);
  console.log(`  ${path.basename(outputFile)} (${sizeKB} KB)`);
}

/**
 * 디렉토리 재귀 복사
 */
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

async function build() {
  // 0. dist 디렉토리 준비
  if (fs.existsSync(DIST_DIR)) fs.rmSync(DIST_DIR, { recursive: true });
  fs.mkdirSync(DIST_DIR, { recursive: true });

  // 1. 메인 페이지 빌드
  const userOutput = await buildFile(
    path.join(SRC_DIR, 'dev-edu-book-dashboard.html'),
    path.join(DIST_DIR, 'edu-book-dashboard.html')
  );

  const userPass = validate('edu-book-dashboard.html', userOutput, [
    ['cdn.tailwindcss.com', userOutput.includes('cdn.tailwindcss.com')],
    ['tailwind.config', userOutput.includes('tailwind.config')],
    ['onclick="loadDashboard()"', userOutput.includes('loadDashboard()')],
    ['setAlarmValue', userOutput.includes('setAlarmValue')],
    ['onclick="logout()"', userOutput.includes('logout()')],
  ]);

  // 2. 관리자 페이지 빌드
  const adminOutput = await buildFile(
    path.join(SRC_DIR, 'dev-admin-dashboard.html'),
    path.join(DIST_DIR, 'admin-dashboard.html')
  );

  const adminPass = validate('admin-dashboard.html', adminOutput, [
    ['cdn.tailwindcss.com', adminOutput.includes('cdn.tailwindcss.com')],
    ['tailwind.config', adminOutput.includes('tailwind.config')],
    ['onclick="loadDashboard()"', adminOutput.includes('loadDashboard()')],
    ['onclick="logout()"', adminOutput.includes('logout()')],
    ['doSearch', adminOutput.includes('doSearch')],
    ['resetRange', adminOutput.includes('resetRange')],
  ]);

  // 3. 모듈 HTML 빌드
  console.log('\n========== Building modules ==========');
  const mainPages = ['dev-edu-book-dashboard.html', 'dev-admin-dashboard.html'];
  const modules = fs.readdirSync(SRC_DIR)
    .filter(f => f.endsWith('.html') && !mainPages.includes(f));
  for (const mod of modules) {
    const src = path.join(SRC_DIR, mod);
    if (fs.existsSync(src)) {
      await buildModule(src, path.join(DIST_DIR, mod));
    }
  }

  // 4. 이미지 복사
  if (fs.existsSync(IMG_DIR)) {
    console.log(`\n========== Copying ${IMG_DIR}/ ==========`);
    copyDirSync(IMG_DIR, path.join(DIST_DIR, 'img'));
    const imgCount = fs.readdirSync(IMG_DIR).length;
    console.log(`  ${imgCount} files → ${DIST_DIR}/img/`);
  }

  // 4-1. CSS 복사
  if (fs.existsSync(CSS_DIR)) {
    console.log(`\n========== Copying ${CSS_DIR}/ ==========`);
    copyDirSync(CSS_DIR, path.join(DIST_DIR, 'css'));
    const cssFiles = fs.readdirSync(CSS_DIR).filter(f => f.endsWith('.css'));
    const cleanCSS = new CleanCSS({ level: 2 });
    cssFiles.forEach(f => {
      const fp = path.join(DIST_DIR, 'css', f);
      const minified = cleanCSS.minify(fs.readFileSync(fp, 'utf-8'));
      if (minified.styles) fs.writeFileSync(fp, minified.styles, 'utf-8');
    });
    console.log(`  ${cssFiles.length} files → ${DIST_DIR}/css/ (minified)`);
  }

  // 4-2. data 복사
  const DATA_DIR = 'src/data';
  if (fs.existsSync(DATA_DIR)) {
    console.log(`\n========== Copying ${DATA_DIR}/ ==========`);
    copyDirSync(DATA_DIR, path.join(DIST_DIR, 'data'));
    const dataCount = fs.readdirSync(DATA_DIR).length;
    console.log(`  ${dataCount} files → ${DIST_DIR}/data/`);
  }

  // 5. PWA 파일 복사 (html/ → dist/ 경로 보정)
  console.log('\n========== Copying PWA files ==========');
  const pwaSource = path.join(SRC_DIR, 'manifest.json');
  if (fs.existsSync(pwaSource)) {
    let manifest = fs.readFileSync(pwaSource, 'utf-8');
    manifest = manifest.replace(/dev-edu-book-dashboard\.html/g, 'edu-book-dashboard.html');
    manifest = manifest.replace(/\.\.\/img\//g, 'img/');
    fs.writeFileSync(path.join(DIST_DIR, 'manifest.json'), manifest, 'utf-8');
    console.log('  manifest.json (path adjusted)');
  }
  const swSource = path.join(SRC_DIR, 'sw.js');
  if (fs.existsSync(swSource)) {
    let sw = fs.readFileSync(swSource, 'utf-8');
    sw = sw.replace(/dev-edu-book-dashboard\.html/g, 'edu-book-dashboard.html');
    sw = sw.replace(/\.\.\/img\//g, 'img/');
    sw = sw.replace(/\.\.\/data\//g, 'data/');
    fs.writeFileSync(path.join(DIST_DIR, 'sw.js'), sw, 'utf-8');
    console.log('  sw.js (path adjusted)');
  }

  if (userPass && adminPass) {
    console.log('\nAll checks passed!');
  } else {
    console.error('\nSome checks FAILED!');
    process.exit(1);
  }
}

build().catch(err => {
  console.error('Build failed:', err);
  process.exit(1);
});
