import { expandCuratedDocument, loadCuratedRules, listJsonFiles, readJson, validateRuleData } from './_common.mjs';

const errors = [];
const loadedRules = await loadCuratedRules();
let ruleCount = 0;

for (const { filePath, document } of loadedRules) {
    const expanded = expandCuratedDocument(filePath, document);
    ruleCount += expanded.length;

    for (const entry of expanded) {
        const result = validateRuleData(entry.document, entry.sourcePath);
        errors.push(...result.errors);
    }
}

for (const relativeDir of ['candidates', 'fixtures/benchmark']) {
    const filePaths = await listJsonFiles(relativeDir);
    for (const filePath of filePaths) {
        try {
            await readJson(filePath);
        } catch (error) {
            errors.push(`${filePath}: invalid JSON (${error.message})`);
        }
    }
}

if (errors.length > 0) {
    for (const error of errors) {
        console.error(error);
    }
    process.exit(1);
}

console.log(`validate-registry: ok (${loadedRules.length} curated files, ${ruleCount} rules)`);
