/* The page shell: the one description of the page's HTML.
   - build.mjs uses it to write page.html (published as the artifact) and index.html (any static host).
   - app.js uses it to republish the page with the family's saved plan embedded. */
(function (root) {
  'use strict';

  // The document wrapper the Artifact tool adds at publish time, copied exactly from the published page,
  // so a version saved from inside the page has the same shape as one published by the tool.
  var RESET = ':root{color-scheme:light;box-sizing:border-box;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}html{scroll-padding-top:env(safe-area-inset-top,0px)}body{margin:0;padding:0;font:14px -apple-system,BlinkMacSystemFont,sans-serif;background:#fff;color:#000}img{max-width:100%}[hidden]:not([hidden=until-found i]){display:none!important}';
  var HEAD = '<!doctype html><html><head><meta charset=utf8><meta name=viewport content="width=device-width,initial-scale=1,viewport-fit=cover"><style>' + RESET + '</style></head><body>';
  var TAIL = '</body></html>';

  function safeJson(obj) {
    var LS = String.fromCharCode(0x2028), PS = String.fromCharCode(0x2029);
    return JSON.stringify(obj).replace(/</g, '\\u003c').split(LS).join('\\u2028').split(PS).join('\\u2029');
  }

  // Page content exactly as the Artifact tool expects it: no doctype, html, head or body tags.
  function content(plan) {
    return [
      '<title>Disneyland Family HQ</title>',
      '<meta name="claude:viewport-fit-sides" content="cover">',
      '<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:ital,wght@0,400;0,700;1,400&family=Berkshire+Swash&family=DM+Mono:wght@400;500&family=Fredoka:wght@500;600;700&display=swap">',
      '<link rel="stylesheet" href="styles.css">',
      '<div id="app"><noscript><p style="padding:24px">This planner needs JavaScript turned on.</p></noscript></div>',
      '<script type="application/json" id="plan-data">' + safeJson(plan) + '</scr' + 'ipt>',
      '<script src="shell.js"></scr' + 'ipt>',
      '<script src="guide.js"></scr' + 'ipt>',
      '<script src="app.js"></scr' + 'ipt>'
    ].join('\n');
  }

  function fullDocument(plan) {
    return HEAD + '\n' + content(plan) + '\n\n' + TAIL;
  }

  var api = { content: content, fullDocument: fullDocument, safeJson: safeJson };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TRIP_SHELL = api;
})(typeof window !== 'undefined' ? window : globalThis);
