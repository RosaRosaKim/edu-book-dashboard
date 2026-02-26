const fs = require('fs');
const cheerio = require('cheerio');
const CleanCSS = require('clean-css');
const { minify: minifyHTML } = require('html-minifier-terser');
const JavaScriptObfuscator = require('javascript-obfuscator');

async function buildFile(inputFile, outputFile) {
  console.log(`\n========== Building ${inputFile} ==========`);
  console.log(`[1/5] Reading ${inputFile}...`);
  const html = fs.readFileSync(inputFile, 'utf-8');

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

  // ── Replace dev links with prod links ──
  output = output.replace(/dev-edu-book-dashboard\.html/g, 'edu-book-dashboard.html');
  output = output.replace(/dev-admin-dashboard\.html/g, 'admin-dashboard.html');

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

async function build() {
  // 1. Build user dashboard
  const userOutput = await buildFile('dev-edu-book-dashboard.html', 'edu-book-dashboard.html');

  const userPass = validate('edu-book-dashboard.html', userOutput, [
    ['cdn.tailwindcss.com', userOutput.includes('cdn.tailwindcss.com')],
    ['tailwind.config', userOutput.includes('tailwind.config')],
    ['onclick="requestAuth()"', userOutput.includes('requestAuth()')],
    ['onclick="verifyCode()"', userOutput.includes('verifyCode()')],
    ['onclick="resendCode()"', userOutput.includes('resendCode()')],
    ['onclick="backToStep1()"', userOutput.includes('backToStep1()')],
    ['onclick="loadDashboard()"', userOutput.includes('loadDashboard()')],
    ['onclick="toggleAlarm()"', userOutput.includes('toggleAlarm()')],
    ['onclick="logout()"', userOutput.includes('logout()')],
  ]);

  // 2. Build admin dashboard
  const adminOutput = await buildFile('dev-admin-dashboard.html', 'admin-dashboard.html');

  const adminPass = validate('admin-dashboard.html', adminOutput, [
    ['cdn.tailwindcss.com', adminOutput.includes('cdn.tailwindcss.com')],
    ['chart.js CDN', adminOutput.includes('chart.js')],
    ['tailwind.config', adminOutput.includes('tailwind.config')],
    ['onclick="requestAuth()"', adminOutput.includes('requestAuth()')],
    ['onclick="verifyCode()"', adminOutput.includes('verifyCode()')],
    ['onclick="loadDashboard()"', adminOutput.includes('loadDashboard()')],
    ['onclick="logout()"', adminOutput.includes('logout()')],
    ['doSearch', adminOutput.includes('doSearch')],
    ['clearAllTags', adminOutput.includes('clearAllTags')],
  ]);

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
