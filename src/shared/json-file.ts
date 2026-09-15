import {readFile} from 'node:fs/promises';
import type {JsonValue} from '../types.js';
import {StudioError} from './errors.js';

export async function readJsonFile(filePath:string):Promise<JsonValue> {
  let source:string;
  try {source=await readFile(filePath,'utf8');} catch(error) {throw new StudioError('FILE_READ_FAILED',`Could not read ${filePath}: ${String(error)}`);}
  try {return JSON.parse(source) as JsonValue;} catch(error) {throw new StudioError('INVALID_JSON',`Invalid JSON in ${filePath}: ${String(error)}`);}
}
