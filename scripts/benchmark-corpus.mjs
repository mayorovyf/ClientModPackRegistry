import fs from 'node:fs';
import path from 'node:path';
import { listJsonFiles, repoRoot } from './_common.mjs';

const bundlePath = path.join(repoRoot, 'bundles', 'latest', 'registry.bundle.json');
if (!fs.existsSync(bundlePath)) {
    console.error(`benchmark-corpus: bundle not found at ${bundlePath}`);
    process.exit(1);
}

const benchmarkCases = await listJsonFiles('fixtures/benchmark');
if (benchmarkCases.length === 0) {
    console.log('benchmark-corpus: no benchmark cases yet, skipping');
    process.exit(0);
}

console.log(`benchmark-corpus: ${benchmarkCases.length} benchmark case files detected`);
