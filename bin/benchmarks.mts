#!/usr/bin/env node
/**
 * Recompute the benchmark table from every scan run so far.
 *
 *   npm run benchmarks           recompute and report
 *   npm run benchmarks -- --dry  report what would change, write nothing
 *
 * `docs/schema.md` says this is recomputed on a schedule rather than per scan, and that is
 * still right — but until there is a scheduler, running it after a batch of scans is what
 * keeps the table current.
 *
 * Most output early on will be buckets that are not quotable yet. That is the honest
 * picture: a percentile built on four businesses is worse than no percentile, and the
 * report says "not enough comparable businesses yet" rather than quoting it.
 */

import { join } from 'node:path';

import { createFileScanStore } from '../lib/db/file.ts';
import { aggregate, runBenchmarkAggregation } from '../lib/benchmarks/aggregate.ts';
import { MIN_BENCHMARK_SAMPLE } from '../lib/taxonomy/enums.ts';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? undefined : args[at + 1];
};

const storePath = flag('store') ?? join(flag('out') ?? '.scans', 'store.json');
const dry = args.includes('--dry');

const dim = (s: string) => `[2m${s}[0m`;
const green = (s: string) => `[32m${s}[0m`;
const amber = (s: string) => `[33m${s}[0m`;

const store = createFileScanStore(storePath);
const rows = await store.benchmarkRows();

if (rows.length === 0) {
  console.log(
    dim(`\n  Nothing to aggregate in ${storePath}.`) +
      dim('\n  Run some scans first: npm run scan -- --name "..." --postcode "..."\n'),
  );
  process.exit(0);
}

const all = aggregate(rows).sort((a, b) => b.sample_size - a.sample_size);
const quotable = all.filter((b) => b.sample_size >= MIN_BENCHMARK_SAMPLE).length;
const businesses = new Set(rows.map((r) => r.business_id)).size;

if (!dry) await runBenchmarkAggregation(store);

console.log(
  `\n  ${businesses} businesses measured · ${all.length} buckets` +
    `${dry ? dim(' (dry run — nothing written)') : ''}\n`,
);

for (const bucket of all.slice(0, 12)) {
  const where = bucket.region ?? 'national';
  const isQuotable = bucket.sample_size >= MIN_BENCHMARK_SAMPLE;
  const mark = isQuotable ? green('quotable') : amber(`${MIN_BENCHMARK_SAMPLE - bucket.sample_size} more`);
  const percentiles =
    bucket.p50 === null ? '' : dim(` p25 ${bucket.p25} · p50 ${bucket.p50} · p75 ${bucket.p75}`);

  console.log(
    `  ${mark.padEnd(20)} ${String(bucket.sample_size).padStart(3)}  ` +
      `${bucket.code.padEnd(34)} ${where}${percentiles}`,
  );
}

if (all.length > 12) console.log(dim(`  ... and ${all.length - 12} more`));

console.log(
  quotable > 0
    ? `\n  ${green(`${quotable} bucket(s) can be quoted in a report.`)}\n`
    : `\n  ${amber('Nothing is quotable yet.')}` +
        dim(` A bucket needs ${MIN_BENCHMARK_SAMPLE} distinct businesses.\n`),
);
