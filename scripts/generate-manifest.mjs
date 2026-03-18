import fs from 'node:fs/promises';
import path from 'node:path';
import { repoRoot, readJson, writeJson, sha256 } from './_common.mjs';

const bundlePath = path.join(repoRoot, 'bundles', 'latest', 'registry.bundle.json');
const bundleBuffer = await fs.readFile(bundlePath);
const bundle = await readJson(bundlePath);
const latestManifestPath = path.join(repoRoot, 'bundles', 'latest', 'manifest.json');
const versionedManifestPath = path.join(repoRoot, 'bundles', 'versions', bundle.registryVersion, 'manifest.json');

const manifest = {
    schemaVersion: 1,
    registryVersion: bundle.registryVersion,
    bundleFile: 'registry.bundle.json',
    bundleChecksum: sha256(bundleBuffer),
    bundleSize: bundleBuffer.length,
    publishedAt: new Date().toISOString(),
    source: 'ClientModPackRegistry'
};

await writeJson(latestManifestPath, manifest);
await writeJson(versionedManifestPath, manifest);
console.log(`generate-manifest: ok -> ${latestManifestPath} | ${versionedManifestPath}`);
