import path from 'node:path';
import { expandCuratedDocument, loadCuratedRules, validateRuleData } from './_common.mjs';

const issues = [];
const ruleIdToPath = new Map();
const modLoaderSide = new Map();
const fileLoaderSide = new Map();

for (const { filePath, document } of await loadCuratedRules()) {
    for (const entry of expandCuratedDocument(filePath, document)) {
        const { errors, normalized } = validateRuleData(entry.document, entry.sourcePath);
        if (errors.length > 0) {
            issues.push(...errors);
            continue;
        }

        if (ruleIdToPath.has(normalized.ruleId)) {
            issues.push(`Duplicate ruleId ${normalized.ruleId}: ${ruleIdToPath.get(normalized.ruleId)} and ${entry.sourcePath}`);
        } else {
            ruleIdToPath.set(normalized.ruleId, entry.sourcePath);
        }

        for (const modId of normalized.modIds) {
            for (const loader of normalized.loaders) {
                const key = `${modId}::${loader}`;
                const state = modLoaderSide.get(key);
                if (!state) {
                    modLoaderSide.set(key, { side: normalized.side, filePath: entry.sourcePath });
                    continue;
                }
                if (state.side !== normalized.side) {
                    issues.push(
                        `Conflicting side for ${key}: ${state.side} (${path.basename(state.filePath)}) vs ${normalized.side} (${path.basename(entry.sourcePath)})`
                    );
                }
            }
        }

        for (const fileName of normalized.fileNames) {
            for (const loader of normalized.loaders) {
                const key = `${String(fileName).toLowerCase()}::${loader}`;
                const state = fileLoaderSide.get(key);
                if (!state) {
                    fileLoaderSide.set(key, { side: normalized.side, filePath: entry.sourcePath });
                    continue;
                }
                if (state.side !== normalized.side) {
                    issues.push(
                        `Conflicting side for ${key}: ${state.side} (${path.basename(state.filePath)}) vs ${normalized.side} (${path.basename(entry.sourcePath)})`
                    );
                }
            }
        }
    }
}

if (issues.length > 0) {
    for (const issue of issues) {
        console.error(issue);
    }
    process.exit(1);
}

console.log(`lint-registry: ok (${ruleIdToPath.size} unique rules)`);
