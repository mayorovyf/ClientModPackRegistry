import path from 'node:path';
import {
    createRegistryVersion,
    expandCuratedDocument,
    loadCuratedRules,
    normalizeRule,
    repoRoot,
    validateRuleData,
    writeJson
} from './_common.mjs';

const loadedRules = await loadCuratedRules();
const errors = [];
const rules = [];

for (const { filePath, document } of loadedRules) {
    for (const entry of expandCuratedDocument(filePath, document)) {
        const { errors: ruleErrors } = validateRuleData(entry.document, entry.sourcePath);
        if (ruleErrors.length > 0) {
            errors.push(...ruleErrors);
            continue;
        }
        rules.push(normalizeRule(entry.document));
    }
}

if (errors.length > 0) {
    for (const error of errors) {
        console.error(error);
    }
    process.exit(1);
}

rules.sort((left, right) => {
    const modIdLeft = left.modIds[0] || left.ruleId;
    const modIdRight = right.modIds[0] || right.ruleId;
    return modIdLeft.localeCompare(modIdRight) || left.ruleId.localeCompare(right.ruleId);
});

const bundle = {
    schemaVersion: 1,
    registryVersion: process.env.REGISTRY_VERSION || createRegistryVersion(),
    generatedAt: new Date().toISOString(),
    rules
};

const latestBundlePath = path.join(repoRoot, 'bundles', 'latest', 'registry.bundle.json');
const versionedBundlePath = path.join(repoRoot, 'bundles', 'versions', bundle.registryVersion, 'registry.bundle.json');

await writeJson(latestBundlePath, bundle);
await writeJson(versionedBundlePath, bundle);
console.log(`build-bundle: ok (${rules.length} rules) -> ${latestBundlePath} | ${versionedBundlePath}`);
