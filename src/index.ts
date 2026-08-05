import type {StudioConfig} from "./types.js";

export type * from "./types.js";

export function defineConfig<T extends StudioConfig>(config: T): T {
  return config;
}
