/**
 * A `ScanStore` backed by one JSON file.
 *
 * **Why this rather than Postgres, for now.** The stack decision is Supabase and it stands —
 * but the roadmap's governing rule is to build tooling only for offers that have already
 * sold, and the immediate job is ten manual scans by one person. A JSON file does that with
 * no instance to provision, no migration to run and no key to rotate, and it keeps the
 * findings so benchmarks can accumulate from scan one, which is the part that cannot be
 * retrofitted (rule 6).
 *
 * The interface is the point. When scan volume or a second reader makes Postgres worth
 * standing up, it drops in behind `ScanStore` and neither the runner nor the CLI changes.
 *
 * Written whole on every mutation. At a few hundred rows a scan that is nothing; at a
 * hundred thousand it would be the wrong tool, and that is the signal to move.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

import { MemoryScanStore, emptyState, type StoreState } from './memory';
import type { ScanStore } from './store';

export const DEFAULT_STORE_PATH = '.scans/store.json';

function read(path: string): StoreState {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoreState>;
    // Merged over an empty state so a file written by an older version, missing a table
    // added since, loads rather than throwing on the first read of that table.
    return { ...emptyState(), ...parsed };
  } catch {
    return emptyState();
  }
}

/**
 * Write through a temporary file and rename.
 *
 * A scan takes minutes and writes continuously. Interrupting a direct write leaves a
 * truncated file and loses every scan before it; rename is atomic on both platforms this
 * runs on, so the worst case is losing the write in flight.
 */
function write(path: string, state: StoreState): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), 'utf8');
  renameSync(temporary, path);
}

/**
 * Load the store at `path`, creating it on first write.
 *
 * Returns a `MemoryScanStore` that flushes after every mutation, so the two implementations
 * cannot drift — the file store is the memory store plus durability, not a reimplementation.
 */
export function createFileScanStore(path = DEFAULT_STORE_PATH): ScanStore {
  return new MemoryScanStore({
    name: `file:${path}`,
    state: read(path),
    onChange: (next) => write(path, next),
  });
}
