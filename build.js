const fs = require('fs');
const cheerio = require('cheerio');
const CleanCSS = require('clean-css');
const { minify: minifyHTML } = require('html-minifier-terser');
const JavaScriptObfuscator = require('javascript-obfuscator');

async function build() {
  console.log('[1/5] Reading dev-edu-book-dashboard.html...');
  const html = fs.readFileSync('dev-edu-book-dashboard.html', 'utf-8');

  const $ = cheerio.load(html, { decodeEntities: false });

  // ── Process inline <script> blocks ──
  const scripts = $('script').toArray();
  for (const scriptEl of scripts) {
    const el = $(scriptEl);
    if (el.attr('src')) continue; // skip external (CDN) scripts

    const code = el.html();
    if (!code || !code.trim()) continue;

    if (code.includes('tailwind.config')) {
      // Tailwind config: minify only — no renaming (CDN reads at runtime)
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
        // Fallback: simple whitespace reduction
        const minified = code
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/.*$/gm, '')
          .replace(/\n\s*/g, '')
          .replace(/\s{2,}/g, ' ')
          .trim();
        el.html(minified);
      }
    } else {
      // Main IIFE: obfuscate with javascript-obfuscator
      console.log('[3/5] Obfuscating main script...');
      const result = JavaScriptObfuscator.obfuscate(code, {
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
    minifyJS: false,  // already handled above
    minifyCSS: false, // already handled above
  });

  fs.writeFileSync('edu-book-dashboard.html', output, 'utf-8');

  const sizeKB = (Buffer.byteLength(output, 'utf-8') / 1024).toFixed(1);
  console.log(`\nBuild complete: edu-book-dashboard.html (${sizeKB} KB)`);

  // ── Validation ──
  console.log('\n--- Validation ---');
  const checks = [
    ['cdn.tailwindcss.com', output.includes('cdn.tailwindcss.com')],
    ['tailwind.config', output.includes('tailwind.config')],
    ['onclick="requestAuth()"', output.includes('requestAuth()')],
    ['onclick="verifyCode()"', output.includes('verifyCode()')],
    ['onclick="resendCode()"', output.includes('resendCode()')],
    ['onclick="backToStep1()"', output.includes('backToStep1()')],
    ['onclick="loadDashboard()"', output.includes('loadDashboard()')],
    ['onclick="toggleAlarm()"', output.includes('toggleAlarm()')],
    ['onclick="logout()"', output.includes('logout()')],
  ];

  let allPass = true;
  checks.forEach(([label, pass]) => {
    console.log(`  ${pass ? 'PASS' : 'FAIL'} ${label}`);
    if (!pass) allPass = false;
  });

  if (allPass) {
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
