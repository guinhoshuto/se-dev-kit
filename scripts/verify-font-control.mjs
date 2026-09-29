import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {launchStudioBrowser} from '../dist/capture/browser.js';

// A googleFont field commits the family on Enter or blur. Each commit prepares a preview, and a new
// family there becomes a Google Fonts request through the proxy, so typing "Archivo" must not ask for
// "A", "Ar", and so on. The widget shows the family through a placeholder and loads no font itself.
const origin = process.env.STUDIO_TEST_URL ?? 'http://127.0.0.1:4317';
if (new URL(origin).hostname !== '127.0.0.1') throw new Error('Font control verification only targets a local loopback server.');
await mkdir(resolve('.studio-data'), {recursive: true});
const output = await mkdtemp(resolve('.studio-data/font-control-verification-'));
const snapshot = {schemaVersion: 1, name: 'Font control verification', widget: {html: '<h1 id="t">{{font}}</h1>', css: 'h1{margin:0;padding:24px;font:32px sans-serif}', js: '', fields: {font: {type: 'googleFont', label: 'Heading font', value: 'Roboto'}}, viewport: {width: 320, height: 120}}};
const {browser} = await launchStudioBrowser();
const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  const created = await fetch(`${origin}/api/v1/projects`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(snapshot)});
  assert.equal(created.status, 201);
  await page.goto(origin + (await created.json()).editorUrl);
  await page.getByText('Ready · isolated runtime', {exact: true}).waitFor({timeout: 30_000});
  const frame = page.frameLocator('iframe[title="Isolated widget preview"]');
  await frame.locator('#t').getByText('Roboto', {exact: true}).waitFor();

  const previews = [];
  page.on('request', request => {
    if (request.method() === 'POST' && new URL(request.url()).pathname.endsWith('/preview')) previews.push(JSON.parse(request.postData() ?? '{}').fieldData);
  });
  const field = page.getByLabel('Heading font', {exact: true});
  await field.selectText();
  await field.pressSequentially('Archivo', {delay: 40});
  await page.waitForTimeout(800);
  assert.deepEqual(previews, [], 'typing a family asks for no preview');
  await page.screenshot({path: resolve(output, 'typing.png'), fullPage: true});

  await field.press('Tab');
  await frame.locator('#t').getByText('Archivo', {exact: true}).waitFor();
  assert.deepEqual(previews, [{font: 'Archivo'}], 'leaving the field asks for exactly one preview');
  await field.focus();
  await field.press('Enter');
  await page.waitForTimeout(500);
  assert.equal(previews.length, 1, 'Enter on an unchanged family asks for nothing');

  await field.selectText();
  await field.pressSequentially('Inter', {delay: 40});
  await field.press('Enter');
  await frame.locator('#t').getByText('Inter', {exact: true}).waitFor();
  assert.deepEqual(previews, [{font: 'Archivo'}, {font: 'Inter'}], 'Enter commits a new family once');
  await page.screenshot({path: resolve(output, 'committed.png'), fullPage: true});
  assert.deepEqual(errors, []);
  const checks = ['typing a family prepares no preview', 'blur commits once', 'Enter on an unchanged family is ignored', 'Enter commits a new family once'];
  await writeFile(resolve(output, 'report.json'), JSON.stringify({verifiedAt: new Date().toISOString(), checks}, null, 2), {flag: 'wx'});
  console.log(JSON.stringify({status: 'passed', output, checks}));
} catch (error) {
  await page.screenshot({path: resolve(output, 'failure.png'), fullPage: true});
  console.error(`Verification evidence: ${output}`);
  throw error;
} finally {
  await context.close();
  await browser.close();
}
