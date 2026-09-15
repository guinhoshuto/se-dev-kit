import type {JsonValue, ResolvedProject} from "../types.js";
import {StudioError} from "../shared/errors.js";

const SENSITIVE_KEY_NAMES = new Set([
  "token",
  "tokens",
  "accesstoken",
  "refreshtoken",
  "oauthtoken",
  "apitoken",
  "bearertoken",
  "sessiontoken",
  "cookie",
  "cookies",
  "authorization",
  "webhook",
  "webhookurl",
  "secret",
  "clientsecret",
  "password",
  "apikey",
  "jwt"
]);

function normalizedKey(value: string): string {
  return value.replaceAll(/[^a-z\d]/gi, "").toLowerCase();
}

export function inspectSensitive(value: JsonValue, location: string, findings: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => inspectSensitive(item, `${location}[${index}]`, findings));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    const nestedLocation = `${location}.${key}`;
    const hasValue = typeof child === "string" ? child.trim().length > 0 : child !== null && child !== false;
    if (SENSITIVE_KEY_NAMES.has(normalizedKey(key)) && hasValue) findings.push(nestedLocation);
    if (
      typeof child === "string" &&
      /(?:(?:api|kvstore)\.streamelements\.com|streamelements\.com\/(?:api|oauth|hooks?))/i.test(child)
    ) findings.push(nestedLocation);
    inspectSensitive(child, nestedLocation, findings);
  }
}

export function findSensitiveTestData(project: ResolvedProject): string[] {
  const findings: string[] = [];
  inspectSensitive(project.fieldDefaults as JsonValue, "fields", findings);
  if (project.config.channel) inspectSensitive(project.config.channel as JsonValue, "config.channel", findings);
  for (const theme of project.themes) inspectSensitive(theme.value as unknown as JsonValue, `theme:${theme.id}`, findings);
  for (const fixture of project.fixtures) inspectSensitive(fixture.value as unknown as JsonValue, `fixture:${fixture.id}`, findings);
  for (const scene of project.scenes) inspectSensitive(scene.value as unknown as JsonValue, `scene:${scene.id}`, findings);
  for (const scenario of project.scenarios) inspectSensitive(scenario.value as unknown as JsonValue, `scenario:${scenario.id}`, findings);
  return [...new Set(findings)];
}

export function assertPublicSafeProject(project: ResolvedProject): void {
  const findings = findSensitiveTestData(project);
  if (findings.length === 0) return;
  throw new StudioError(
    "SENSITIVE_TEST_DATA",
    `Studio inputs contain credentials, webhooks, cookies, or live StreamElements API data at: ${findings.join(", ")}.`,
    "Replace every value with synthetic public-safe test data before starting a browser or producing media."
  );
}
