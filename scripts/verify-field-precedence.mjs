import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {launchStudioBrowser} from '../dist/capture/browser.js';
import {demoSnapshot} from '../lib/demo.ts';

const origin = process.env.STUDIO_TEST_URL ?? 'http://127.0.0.1:4317';
if (new URL(origin).hostname !== '127.0.0.1') throw new Error('Field verification only targets a local loopback server.');
await mkdir(resolve('.studio-data'), {recursive: true});
const output = await mkdtemp(resolve('.studio-data/field-verification-'));
const snapshot = structuredClone(demoSnapshot);
snapshot.name = 'Field precedence verification';
snapshot.themes[0].fieldData.title = 'Theme title';
snapshot.fixtures[0].fieldData = {title: 'Fixture title'};
const {browser} = await launchStudioBrowser();
const context = await browser.newContext({viewport: {width: 1440, height: 1000}});
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(origin);
  await page.getByLabel('WidgetSnapshot JSON', {exact: true}).fill(JSON.stringify(snapshot));
  await page.getByRole('button', {name: 'Create project →', exact: true}).click();
  await page.waitForURL('**/p/**');
  await page.getByText('Ready · isolated runtime', {exact: true}).waitFor();
  const frame = page.frameLocator('iframe[title="Isolated widget preview"]');
  await frame.locator('#heading').getByText('Fixture title', {exact: true}).waitFor();
  assert.equal(await page.getByLabel('Chat title', {exact: true}).inputValue(), 'Fixture title', 'The inspector must include the selected fixture above theme defaults.');
  await page.screenshot({path: resolve(output, 'fixture-fields.png'), fullPage: true});

  // A scene override must still beat the fixture and survive a saved reload.
  await page.getByLabel('Chat title', {exact: true}).fill('Scene title');
  await page.getByRole('button', {name: 'Apply preview', exact: false}).click();
  await frame.locator('#heading').getByText('Scene title', {exact: true}).waitFor();
  await page.getByRole('button', {name: 'Save revision', exact: true}).click();
  await page.getByText('Revision saved.', {exact: true}).waitFor();
  await page.reload();
  await page.getByText('Ready · isolated runtime', {exact: true}).waitFor();
  await frame.locator('#heading').getByText('Scene title', {exact: true}).waitFor();
  assert.equal(await page.getByLabel('Chat title', {exact: true}).inputValue(), 'Scene title');

  await page.getByLabel('Chat title', {exact: true}).fill('Temporary title');
  await frame.locator('#heading').getByText('Temporary title', {exact: true}).waitFor();
  await page.getByRole('button', {name: 'Reset temporary overrides', exact: true}).click();
  await frame.locator('#heading').getByText('Scene title', {exact: true}).waitFor();
  assert.equal(await page.getByLabel('Chat title', {exact: true}).inputValue(), 'Scene title');
  assert.deepEqual(errors, []);
  const checks = ['fixture overrides theme in inspector and preview', 'scene overrides fixture after save and reload', 'temporary override resets to saved scene'];
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
