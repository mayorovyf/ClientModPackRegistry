import fs from 'node:fs/promises';
import path from 'node:path';

import {
    buildSubjectKey,
    normalizeStringArray,
    pickPrimaryModId,
    readJson,
    repoRoot,
    writeJson
} from './_common.mjs';

const DEFAULT_REPORTS_ROOT = 'M:\\ClientModPackToServer\\Reports';
const DEFAULT_OVERRIDES_PATH = 'C:\\.projects\\ClientModPackToServer\\data\\review-overrides.json';
const reportIndexPath = path.join(repoRoot, 'fixtures', 'report-index.json');
const reviewSummaryPath = path.join(repoRoot, 'candidates', 'imported-from-reports', 'review-summary.json');

function parseArgs(argv) {
    const reportRoots = [];
    let overridesPath = DEFAULT_OVERRIDES_PATH;

    for (let index = 0; index < argv.length; index += 1) {
        const value = argv[index];

        if (value === '--overrides') {
            overridesPath = argv[index + 1] || overridesPath;
            index += 1;
            continue;
        }

        reportRoots.push(value);
    }

    return {
        reportRoots: reportRoots.length > 0 ? reportRoots : [DEFAULT_REPORTS_ROOT],
        overridesPath
    };
}

async function collectReportDirs(rootPath) {
    const discovered = new Set();

    async function walk(currentPath) {
        let entries = [];

        try {
            entries = await fs.readdir(currentPath, { withFileTypes: true });
        } catch {
            return;
        }

        const hasReportJson = entries.some((entry) => entry.isFile() && entry.name === 'report.json');

        if (hasReportJson) {
            discovered.add(currentPath);
            return;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) {
                continue;
            }

            await walk(path.join(currentPath, entry.name));
        }
    }

    await walk(rootPath);

    return [...discovered].sort((left, right) => left.localeCompare(right));
}

const { reportRoots, overridesPath } = parseArgs(process.argv.slice(2));

function createSubjectAggregate(subjectKey, decision) {
    return {
        key: subjectKey,
        primaryModId: pickPrimaryModId(decision?.descriptor?.modIds || decision?.modIds || []),
        fileNames: new Set(),
        modIds: new Set(),
        loaders: new Set(),
        displayNames: new Set(),
        versions: new Set(),
        runIds: new Set(),
        reviewCount: 0,
        keepCount: 0,
        removeCount: 0,
        manualKeepCount: 0,
        manualExcludeCount: 0,
        reasons: new Set(),
        finalOrigins: new Set()
    };
}

let manualOverrides = { version: 1, updatedAt: '', entries: [] };
try {
    manualOverrides = await readJson(overridesPath);
} catch {
    manualOverrides = { version: 1, updatedAt: '', entries: [] };
}

const overrideEntries = Array.isArray(manualOverrides.entries) ? manualOverrides.entries : [];
const runs = [];
const subjectMap = new Map();
const reportDirs = [];

for (const reportRoot of reportRoots) {
    const discoveredDirs = await collectReportDirs(reportRoot);
    reportDirs.push(...discoveredDirs);
}

for (const reportDir of reportDirs) {
    const reportPath = path.join(reportDir, 'report.json');
    const runPath = path.join(reportDir, 'run.json');

    let report = null;
    let run = null;

    try {
        report = await readJson(reportPath);
    } catch {
        report = null;
    }

    try {
        run = await readJson(runPath);
    } catch {
        run = null;
    }

    const decisions = Array.isArray(report?.decisions) ? report.decisions : [];
    const runId = typeof run?.runId === 'string' ? run.runId : path.basename(reportDir);

    runs.push({
        runId,
        reportDir,
        reportPath,
        runPath,
        decisionCount: decisions.length,
        reviewCount: decisions.filter((decision) => decision?.finalSemanticDecision === 'review' || decision?.requiresReview === true).length
    });

    for (const decision of decisions) {
        const descriptor = decision?.descriptor || null;
        const modIds = normalizeStringArray(descriptor?.modIds || decision?.modIds || [], { lowerCase: true });
        const loader = String(descriptor?.loader || 'unknown').trim().toLowerCase() || 'unknown';
        const subjectKey = buildSubjectKey({
            modIds,
            fileName: decision?.fileName,
            loader
        });
        const subject = subjectMap.get(subjectKey) || createSubjectAggregate(subjectKey, decision);

        subject.fileNames.add(String(decision?.fileName || '').trim());
        modIds.forEach((modId) => subject.modIds.add(modId));
        subject.loaders.add(loader);
        if (typeof descriptor?.displayName === 'string' && descriptor.displayName.trim()) {
            subject.displayNames.add(descriptor.displayName.trim());
        }
        if (typeof descriptor?.version === 'string' && descriptor.version.trim()) {
            subject.versions.add(descriptor.version.trim());
        }
        subject.runIds.add(runId);

        const finalSemanticDecision = String(decision?.finalSemanticDecision || '').trim();
        if (finalSemanticDecision === 'review' || decision?.requiresReview === true) {
            subject.reviewCount += 1;
        }
        if (finalSemanticDecision === 'keep') {
            subject.keepCount += 1;
        }
        if (finalSemanticDecision === 'remove') {
            subject.removeCount += 1;
        }
        if (decision?.manualOverrideAction === 'keep') {
            subject.manualKeepCount += 1;
        }
        if (decision?.manualOverrideAction === 'exclude') {
            subject.manualExcludeCount += 1;
        }
        if (typeof decision?.reason === 'string' && decision.reason.trim()) {
            subject.reasons.add(decision.reason.trim());
        }
        if (typeof decision?.finalDecisionOrigin === 'string' && decision.finalDecisionOrigin.trim()) {
            subject.finalOrigins.add(decision.finalDecisionOrigin.trim());
        }

        subjectMap.set(subjectKey, subject);
    }
}

const aggregatedReviews = [...subjectMap.values()]
    .map((item) => ({
        key: item.key,
        primaryModId: item.primaryModId,
        fileNames: [...item.fileNames].filter(Boolean).sort((left, right) => left.localeCompare(right)),
        modIds: [...item.modIds].sort((left, right) => left.localeCompare(right)),
        loaders: [...item.loaders].sort((left, right) => left.localeCompare(right)),
        displayNames: [...item.displayNames].sort((left, right) => left.localeCompare(right)),
        versions: [...item.versions].sort((left, right) => left.localeCompare(right)),
        runIds: [...item.runIds].sort((left, right) => left.localeCompare(right)),
        reviewCount: item.reviewCount,
        keepCount: item.keepCount,
        removeCount: item.removeCount,
        manualKeepCount: item.manualKeepCount,
        manualExcludeCount: item.manualExcludeCount,
        reasons: [...item.reasons].sort((left, right) => left.localeCompare(right)),
        finalOrigins: [...item.finalOrigins].sort((left, right) => left.localeCompare(right))
    }))
    .sort((left, right) => right.reviewCount - left.reviewCount || left.key.localeCompare(right.key));

await writeJson(reportIndexPath, {
    generatedAt: new Date().toISOString(),
    reportRoots,
    overridesPath,
    reportDirs,
    overrideEntries: overrideEntries.length,
    runs
});
await writeJson(reviewSummaryPath, {
    generatedAt: new Date().toISOString(),
    reportRoots,
    reportDirs,
    overridesPath,
    overrideEntries: overrideEntries.length,
    subjects: aggregatedReviews
});
console.log(`import-reports: ok (${runs.length} runs, ${aggregatedReviews.length} distinct report subjects, ${overrideEntries.length} manual overrides)`);
