import assert from 'node:assert/strict';
import {launchStudioBrowser} from '../dist/capture/browser.js';

// Start a local server with STUDIO_CREATE_KEY=test-only-local-creation-key.
// This deliberately synthetic key must never be used for a hosted workspace.
const creationKey = 'test-only-local-creation-key';
const origin = process.env.STUDIO_TEST_URL ?? 'http://127.0.0.1:4318';
const target = new URL(origin);
if (target.hostname !== '127.0.0.1' || target.protocol !== 'http:' || target.username || target.password) {
  throw new Error('This verification script only targets a local loopback server.');
}
const {browser} = await launchStudioBrowser();
const context = await browser.newContext();
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
const creationResponse = () => page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/projects' && response.request().method() === 'POST');
async function checkNoStoredCreationKey() {
  const exposed = await page.evaluate(key => [location.href, ...Object.values(localStorage), ...Object.values(sessionStorage)].some(value => value.includes(key)), creationKey);
  assert.equal(exposed, false, 'The creation key must not appear in browser storage or the URL.');
}

try {
  await page.goto(origin, {waitUntil: 'networkidle'});
  const keyInput = page.getByLabel('Workspace creation key', {exact: true});
  assert.equal(await keyInput.count(), 1, 'The import screen must offer an optional workspace creation key.');
  assert.equal(await keyInput.getAttribute('type'), 'password');
  assert.equal(await keyInput.getAttribute('autocomplete'), 'off');
  assert.equal(await keyInput.inputValue(), '');

  let responsePromise = creationResponse();
  await page.getByRole('button', {name: 'Open demo project', exact: true}).click();
  let response = await responsePromise;
  assert.equal(response.status(), 403, 'A protected local server must reject an omitted creation key.');
  assert.equal(response.request().headers()['x-studio-key'], undefined, 'An empty key must omit the header.');
  await page.getByRole('alert').getByText('A workspace creation key is required.', {exact: true}).waitFor();

  await keyInput.fill('incorrect-test-key');
  responsePromise = creationResponse();
  await page.getByRole('button', {name: 'Open demo project', exact: true}).click();
  response = await responsePromise;
  assert.equal(response.status(), 403, 'An incorrect key must not create a project.');
  await page.getByRole('alert').getByText('A workspace creation key is required.', {exact: true}).waitFor();

  await keyInput.fill(creationKey);
  await checkNoStoredCreationKey();
  responsePromise = creationResponse();
  await page.getByRole('button', {name: 'Open demo project', exact: true}).click();
  response = await responsePromise;
  assert.equal(response.status(), 201, 'The demo must accept the supplied creation key.');
  assert.equal(response.request().headers()['x-studio-key'] === creationKey, true, 'The key must be supplied only in its request header.');
  assert.equal(response.request().postData().includes(creationKey), false);
  assert.equal(response.url().includes(creationKey), false);
  const snapshot = response.request().postDataJSON();
  await page.waitForURL('**/p/**');
  await page.getByText('Ready · isolated runtime', {exact: true}).waitFor({timeout: 30000});
  await checkNoStoredCreationKey();
  const iframeSource = await page.locator('iframe[title="Isolated widget preview"]').getAttribute('srcdoc');
  assert.equal((iframeSource ?? '').includes(creationKey), false, 'The creation key must not enter the widget iframe.');

  await page.goto(origin, {waitUntil: 'networkidle'});
  assert.equal(await keyInput.inputValue(), '', 'The key must not survive navigation back to the import screen.');
  await keyInput.fill(creationKey);
  await page.getByLabel('WidgetSnapshot JSON', {exact: true}).fill(JSON.stringify(snapshot));
  responsePromise = creationResponse();
  await page.getByRole('button', {name: 'Create project →', exact: true}).click();
  response = await responsePromise;
  assert.equal(response.status(), 201, 'JSON import must accept the supplied creation key.');
  assert.equal(response.request().headers()['x-studio-key'] === creationKey, true);
  await page.waitForURL('**/p/**');
  await checkNoStoredCreationKey();
  assert.deepEqual(errors, []);
  console.log('PASS: optional password input, omitted and incorrect key rejection, protected demo and JSON creation, no creation key in storage, URLs, bodies, or iframe data.');
} finally {
  await context.close();
  await browser.close();
}
