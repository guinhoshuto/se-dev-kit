import {createHash} from "node:crypto";
import {readFile} from "node:fs/promises";
import type {JsonValue} from "../types.js";
import {stableStringify} from "../shared/json.js";

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function hashFile(filePath: string): Promise<string> {
  return sha256(await readFile(filePath));
}

export function hashJson(value: JsonValue): string {
  return sha256(stableStringify(value, 0));
}
