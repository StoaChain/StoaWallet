/**
 * Node-only filesystem loader for the Phase 1 `gasless-result.json` artifact.
 *
 * Kept OUT of the `@stoawallet/core` browser barrel (`gasless/index.ts`) — it
 * imports `node:fs`/`node:path`, which Vite externalizes to
 * `__vite-browser-external` in a browser production bundle. The PURE gating
 * logic that consumes the parsed artifact lives in `gating.ts` (barrel-exported
 * and browser-safe). The app's Node/build-time code imports this loader
 * directly by path; the browser/UI receives the parsed artifact via injection.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { GaslessResultArtifact } from './gating';

const ARTIFACT_PATH = join(import.meta.dirname, '..', '..', 'gasless-result.json');

/**
 * Read + parse the Phase 1 `gasless-result.json` artifact from disk.
 *
 * Returns the parsed artifact, or `undefined` on ANY failure (file absent —
 * it is gitignored and may not exist — unreadable, or malformed JSON). The
 * caller passes the result straight to `getGaslessGating`, whose conservative
 * default turns a missing artifact into `"simulate-only"` for every chain.
 */
export function loadGaslessResult(): GaslessResultArtifact | undefined {
  try {
    const raw = readFileSync(ARTIFACT_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      Array.isArray((parsed as { results?: unknown }).results)
    ) {
      return parsed as GaslessResultArtifact;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
