import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../mermaid-studio.src.js', import.meta.url), 'utf8');

test('sanitizer keeps safe CSSOM neighbors of comments/keyframes and drops resource-bearing neighbors', () => {
  // CSSOM and XML parsing are controlled stubs here, not a substitute for Chrome CSS parsing/visual tests.
  const rawCSS = `#lts_mermaid_7 { font-family: Segoe UI, Microsoft YaHei, sans-serif; font-size: 16px; fill: #333; }
@keyframes dash { to { stroke-dashoffset: 0; } }
/* Classes common for multiple diagrams */
#lts_mermaid_7 .node rect { fill: #ECECFF; stroke: #9370DB; stroke-width: 1px; }
@import url("https://example.invalid/import.css");
@font-face { font-family: external; src: url("https://example.invalid/font.woff"); }
#lts_mermaid_7 .escaped-resource { fill: u\\72l("https://example.invalid/shape.svg"); stroke: #456; }
#lts_mermaid_7 .normalized-resource { fill: url("https://example.invalid/shape.svg"); stroke: #567; }
#lts_mermaid_7 .local { marker-end: url("#local-marker"); }
#lts_mermaid_7 .label text { fill: #333; font-size: 16px; }`;
  const declaration = entries => ({
    length: entries.length,
    item: index => entries[index][0],
    getPropertyValue: name => entries.find(([key]) => key === name)?.[1] || ''
  });
  const rule = (selectorText, entries) => ({ type: 1, selectorText, style: declaration(entries) });
  const ignored = type => ({ type, get style() { throw new Error('Non-style rule must not be inspected'); } });
  const rules = [
    rule('#lts_mermaid_7', [['font-family', 'Segoe UI, Microsoft YaHei, sans-serif'], ['font-size', '16px'], ['fill', '#333']]),
    ignored(7),
    rule('#lts_mermaid_7 .node rect', [['fill', '#ECECFF'], ['stroke', '#9370DB'], ['stroke-width', '1px']]),
    ignored(3), ignored(5),
    rule('#lts_mermaid_7 .escaped-resource', [['fill', 'u\\72l("https://example.invalid/shape.svg")'], ['stroke', '#456']]),
    rule('#lts_mermaid_7 .normalized-resource', [['fill', 'url("https://example.invalid/shape.svg")'], ['stroke', '#567']]),
    rule('#lts_mermaid_7 .unsafe\\2dselector', [['fill', '#BADBAD']]),
    rule('#lts_mermaid_7 .local', [['marker-end', 'url("#local-marker")']]),
    rule('#lts_mermaid_7 .label text', [['fill', '#333'], ['font-size', '16px']])
  ];
  let parsedSheets = 0;
  const styleNode = { localName: 'style', namespaceURI: 'http://www.w3.org/2000/svg', textContent: rawCSS, attributes: [] };
  const svg = {
    localName: 'svg', namespaceURI: 'http://www.w3.org/2000/svg', id: 'lts_mermaid_7', attributes: [], style: {},
    contains: node => node === svg || node === styleNode,
    querySelectorAll: () => [styleNode],
    setAttribute() {}
  };
  const context = vm.createContext({
    TextEncoder,
    CSSRule: { STYLE_RULE: 1 },
    CSSStyleSheet: class {
      replaceSync(css) { assert.equal(css, rawCSS); parsedSheets++; this.cssRules = rules; }
    },
    DOMParser: class {
      parseFromString() { return { documentElement: svg, querySelector: () => null }; }
    },
    XMLSerializer: class {
      serializeToString() { return '<svg><style>' + styleNode.textContent + '</style></svg>'; }
    }
  });
  new vm.Script(source, { filename: 'mermaid-studio.src.js' }).runInContext(context);
  const output = context.sanitizeMermaidSVG('<svg/>', 7);
  assert.equal(parsedSheets, 1, 'ordinary rules must reach CSSOM even when the source contains comments or at-rules');
  assert.ok(output.includes('font-family:Segoe UI, Microsoft YaHei, sans-serif'));
  assert.ok(output.includes('#lts_mermaid_7 .node rect{fill:#ECECFF;stroke:#9370DB;stroke-width:1px}'));
  assert.ok(output.includes('#lts_mermaid_7 .label text{fill:#333;font-size:16px}'));
  assert.ok(output.includes('#lts_mermaid_7 .escaped-resource{stroke:#456}'));
  assert.ok(output.includes('#lts_mermaid_7 .normalized-resource{stroke:#567}'));
  assert.ok(output.includes('marker-end:url("#local-marker")'));
  assert.doesNotMatch(output, /@keyframes|@import|@font-face|example\.invalid|BADBAD|\\/);
});
