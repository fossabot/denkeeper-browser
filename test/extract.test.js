#!/usr/bin/env node
/**
 * Unit tests for lib/extract.js — verifies the generated JS scripts are
 * syntactically valid and produce expected structures when evaluated.
 *
 * Uses jsdom to simulate a browser environment so we can run the extraction
 * scripts without needing a real browser.
 *
 * Usage: node test/extract.test.js
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

import { buildExtractScript, buildHtmlExtractScript } from '../lib/extract.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const readabilitySrc = readFileSync(
  join(__dirname, '..', 'node_modules', '@mozilla', 'readability', 'Readability.js'),
  'utf-8',
);

let pass = 0;
let fail = 0;

function assert(label, condition) {
  if (condition) {
    console.log(`PASS: ${label}`);
    pass++;
  } else {
    console.error(`FAIL: ${label}`);
    fail++;
  }
}

function assertEq(label, actual, expected) {
  if (actual === expected) {
    console.log(`PASS: ${label}`);
    pass++;
  } else {
    console.error(`FAIL: ${label} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
    fail++;
  }
}

// ---------------------------------------------------------------------------
// Helper: evaluate extraction script in a jsdom window
// ---------------------------------------------------------------------------

function evalInDom(html, script) {
  const dom = new JSDOM(html, { url: 'https://example.com/test', runScripts: 'dangerously' });
  const win = dom.window;

  // jsdom doesn't implement getComputedStyle fully — stub it
  if (!win.getComputedStyle) {
    win.getComputedStyle = () => ({ display: 'block', visibility: 'visible' });
  }

  // CSS.escape may not exist in jsdom
  if (!win.CSS?.escape) {
    win.CSS = win.CSS || {};
    win.CSS.escape = (s) => s.replace(/([^\w-])/g, '\\$1');
  }

  // Evaluate the script
  const result = win.eval(script);
  dom.window.close();
  return result;
}

// ---------------------------------------------------------------------------
// Tests: buildExtractScript
// ---------------------------------------------------------------------------

console.log('=== Extract script generation tests ===\n');

// Test 1: Script is syntactically valid JS
{
  const script = buildExtractScript(readabilitySrc);
  try {
    new Function(script);
    assert('buildExtractScript returns valid JS', true);
  } catch (e) {
    assert('buildExtractScript returns valid JS: ' + e.message, false);
  }
}

// Test 2: Extracts article content from a simple page
{
  const html = `
    <html><head><title>Test Article</title></head>
    <body>
      <article>
        <h1>Main Heading</h1>
        <p>This is a paragraph with some <strong>bold</strong> text and a <a href="https://example.com">link</a>.</p>
        <p>Second paragraph with enough content to pass the readability threshold. This needs to be reasonably long to trigger readability extraction. Adding more text here to ensure the content is substantial enough for the algorithm to consider it an article.</p>
        <ul><li>Item one</li><li>Item two</li><li>Item three</li></ul>
      </article>
    </body></html>
  `;
  const script = buildExtractScript(readabilitySrc, { mode: 'all' });
  const resultJson = evalInDom(html, script);
  const result = JSON.parse(resultJson);

  assertEq('extract: has title', result.title, 'Test Article');
  assert('extract: has content', result.content.length > 0);
  assert('extract: has url', result.url === 'https://example.com/test');
  assertEq('extract: not truncated', result.truncated, false);
  assert('extract: has total_length', typeof result.total_length === 'number');
}

// Test 3: Form extraction
{
  const html = `
    <html><head><title>Login</title></head>
    <body>
      <form name="login">
        <label for="email">Email</label>
        <input id="email" type="email" placeholder="you@example.com" value="">
        <label for="pass">Password</label>
        <input id="pass" type="password" value="">
        <button type="submit">Sign In</button>
      </form>
    </body></html>
  `;
  const script = buildExtractScript(readabilitySrc, { mode: 'all', includeForms: true });
  const result = JSON.parse(evalInDom(html, script));

  assert('forms: extracted', result.forms && result.forms.length > 0);
  if (result.forms && result.forms.length > 0) {
    const form = result.forms[0];
    assertEq('forms: name', form.name, 'login');
    assert('forms: has fields', form.fields.length === 2);
    assertEq('forms: email label', form.fields[0].label, 'Email');
    assertEq('forms: email type', form.fields[0].type, 'email');
    assertEq('forms: submit button', form.submit_button, 'Sign In');
  }
}

// Test 4: Truncation
{
  const longContent = '<p>' + 'x'.repeat(20000) + '</p>';
  const html = `<html><head><title>Long</title></head><body>${longContent}</body></html>`;
  const script = buildExtractScript(readabilitySrc, { mode: 'all', maxLength: 100 });
  const result = JSON.parse(evalInDom(html, script));

  assertEq('truncation: truncated flag', result.truncated, true);
  assert('truncation: content <= maxLength + marker', result.content.length <= 200);
  assert('truncation: total_length > maxLength', result.total_length > 100);
}

// Test 5: Selector scoping
{
  const html = `
    <html><head><title>Scoped</title></head>
    <body>
      <div id="outside">Outside content</div>
      <div id="target"><p>Inside content</p></div>
    </body></html>
  `;
  const script = buildExtractScript(readabilitySrc, { mode: 'all', selector: '#target' });
  const result = JSON.parse(evalInDom(html, script));

  assert('selector: contains target content', result.content.includes('Inside content'));
  assert('selector: excludes outside content', !result.content.includes('Outside content'));
}

// Test 6: No forms when include_forms is false
{
  const html = `
    <html><head><title>No Forms</title></head>
    <body><form><input type="text" value="test"></form></body></html>
  `;
  const script = buildExtractScript(readabilitySrc, { mode: 'all', includeForms: false });
  const result = JSON.parse(evalInDom(html, script));

  assert('no forms: forms omitted', !result.forms);
}

// ---------------------------------------------------------------------------
// Tests: buildHtmlExtractScript
// ---------------------------------------------------------------------------

console.log('\n=== HTML extract script tests ===\n');

// Test 7: Basic HTML extraction
{
  const html = `
    <html><head><title>HTML</title></head>
    <body>
      <div class="target">Hello <b>world</b></div>
      <div class="other">Other</div>
    </body></html>
  `;
  const script = buildHtmlExtractScript('.target', true);
  const result = JSON.parse(evalInDom(html, script));

  assertEq('html extract: count', result.count, 1);
  assert('html extract: has outerHTML', result.html.includes('<div class="target">'));
  assert('html extract: has content', result.html.includes('Hello'));
}

// Test 8: innerHTML mode
{
  const html = `<html><body><div id="x"><span>inner</span></div></body></html>`;
  const script = buildHtmlExtractScript('#x', false);
  const result = JSON.parse(evalInDom(html, script));

  assert('innerHTML: no outer div', !result.html.includes('<div'));
  assert('innerHTML: has inner span', result.html.includes('<span>inner</span>'));
}

// Test 9: No matches
{
  const html = `<html><body><p>Nothing</p></body></html>`;
  const script = buildHtmlExtractScript('.nonexistent');
  const result = JSON.parse(evalInDom(html, script));

  assertEq('no match: count is 0', result.count, 0);
  assertEq('no match: empty html', result.html, '');
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log(`\nResults: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
