import path from 'node:path';

import {
    loadExpandedCuratedRules,
    normalizeRule,
    readJson,
    repoRoot,
    writeJson
} from './_common.mjs';

const corpusSubjectsPath = path.join(repoRoot, 'candidates', 'imported-from-corpus', 'subject-summary.json');
const reportSubjectsPath = path.join(repoRoot, 'candidates', 'imported-from-reports', 'review-summary.json');
const outputQueuePath = path.join(repoRoot, 'candidates', 'candidate-queue.json');
const coveredQueuePath = path.join(repoRoot, 'candidates', 'covered-by-registry.json');

const corpusDocument = await readJson(corpusSubjectsPath);
const reportDocument = await readJson(reportSubjectsPath);
const curatedDocuments = await loadExpandedCuratedRules();
const corpusSubjects = Array.isArray(corpusDocument?.subjects) ? corpusDocument.subjects : [];
const reportSubjects = Array.isArray(reportDocument?.subjects) ? reportDocument.subjects : [];
const curatedRules = curatedDocuments
    .map(({ sourcePath, document }) => ({
        sourcePath,
        rule: normalizeRule(document)
    }))
    .sort((left, right) => right.rule.priority - left.rule.priority || left.rule.ruleId.localeCompare(right.rule.ruleId));

const queueMap = new Map();

for (const subject of corpusSubjects) {
    queueMap.set(subject.key, {
        key: subject.key,
        primaryModId: subject.primaryModId || null,
        fileNames: new Set(subject.fileNames || []),
        modIds: new Set(subject.modIds || []),
        loaders: new Set(subject.loaders || []),
        displayNames: new Set(subject.displayNames || []),
        versions: new Set(subject.versions || []),
        instanceCount: Number(subject.instanceCount || 0),
        corpusFiles: Number(subject.totalFiles || 0),
        declaredSides: subject.declaredSides || {},
        metadataFilesFound: subject.metadataFilesFound || [],
        proposal: subject.proposal || {
            side: 'unknown',
            confidence: 'none',
            status: 'needs-review',
            reason: 'No corpus proposal.'
        },
        reviewCount: 0,
        keepCount: 0,
        removeCount: 0,
        manualKeepCount: 0,
        manualExcludeCount: 0,
        reportReasons: new Set(),
        runIds: new Set()
    });
}

for (const subject of reportSubjects) {
    const current = queueMap.get(subject.key) || {
        key: subject.key,
        primaryModId: subject.primaryModId || null,
        fileNames: new Set(),
        modIds: new Set(),
        loaders: new Set(),
        displayNames: new Set(),
        versions: new Set(),
        instanceCount: 0,
        corpusFiles: 0,
        declaredSides: {},
        metadataFilesFound: [],
        proposal: {
            side: 'unknown',
            confidence: 'none',
            status: 'needs-review',
            reason: 'No corpus proposal.'
        },
        reviewCount: 0,
        keepCount: 0,
        removeCount: 0,
        manualKeepCount: 0,
        manualExcludeCount: 0,
        reportReasons: new Set(),
        runIds: new Set()
    };

    (subject.fileNames || []).forEach((item) => current.fileNames.add(item));
    (subject.modIds || []).forEach((item) => current.modIds.add(item));
    (subject.loaders || []).forEach((item) => current.loaders.add(item));
    (subject.displayNames || []).forEach((item) => current.displayNames.add(item));
    (subject.versions || []).forEach((item) => current.versions.add(item));
    (subject.runIds || []).forEach((item) => current.runIds.add(item));
    (subject.reasons || []).forEach((item) => current.reportReasons.add(item));
    current.reviewCount += Number(subject.reviewCount || 0);
    current.keepCount += Number(subject.keepCount || 0);
    current.removeCount += Number(subject.removeCount || 0);
    current.manualKeepCount += Number(subject.manualKeepCount || 0);
    current.manualExcludeCount += Number(subject.manualExcludeCount || 0);
    if (!current.primaryModId && subject.primaryModId) {
        current.primaryModId = subject.primaryModId;
    }
    queueMap.set(subject.key, current);
}

function buildPriority(item) {
    return (item.reviewCount * 50)
        + (item.manualExcludeCount * 40)
        + (item.manualKeepCount * 35)
        + (item.instanceCount * 5)
        + item.corpusFiles;
}

function intersects(left, right) {
    return left.some((value) => right.includes(value));
}

function findCuratedMatches(item) {
    const modIds = [...item.modIds];
    const fileNames = [...item.fileNames];
    const loaders = [...item.loaders];

    return curatedRules
        .filter(({ rule }) => {
            if (!intersects(rule.loaders, loaders)) {
                return false;
            }

            if (modIds.length > 0 && intersects(rule.modIds, modIds)) {
                return true;
            }

            return fileNames.length > 0 && intersects(rule.fileNames, fileNames);
        })
        .map(({ sourcePath, rule }) => ({
            ruleId: rule.ruleId,
            side: rule.side,
            confidence: rule.confidence,
            source: rule.source,
            sourcePath
        }));
}

function classifyQueueItem(item, curatedMatches) {
    if (curatedMatches.length > 0) {
        const primaryMatch = curatedMatches[0];
        return {
            status: 'already-curated',
            recommendedSide: primaryMatch.side,
            confidence: primaryMatch.confidence,
            reason: `A curated rule already covers this subject (${primaryMatch.ruleId}).`
        };
    }

    if (item.manualExcludeCount > 0 && item.manualKeepCount === 0 && item.proposal.side === 'client') {
        return {
            status: 'strong-candidate',
            recommendedSide: 'client',
            confidence: 'high',
            reason: 'Corpus metadata and manual review history both point to a client-only mod.'
        };
    }

    if (item.manualKeepCount > 0 && item.manualExcludeCount === 0 && ['server', 'both'].includes(item.proposal.side)) {
        return {
            status: 'strong-candidate',
            recommendedSide: item.proposal.side,
            confidence: 'high',
            reason: 'Corpus metadata and manual review history both point to keeping the mod.'
        };
    }

    if (item.reviewCount > 0 && item.proposal.side !== 'unknown') {
        return {
            status: 'needs-curated-review',
            recommendedSide: item.proposal.side,
            confidence: item.proposal.confidence,
            reason: 'The corpus provides a side proposal, but the mod still appears in runtime review cases.'
        };
    }

    if (item.proposal.side !== 'unknown' && item.instanceCount >= 2) {
        return {
            status: item.proposal.status || 'candidate',
            recommendedSide: item.proposal.side,
            confidence: item.proposal.confidence,
            reason: item.proposal.reason
        };
    }

    return {
        status: 'needs-review',
        recommendedSide: 'unknown',
        confidence: 'none',
        reason: 'Signals are not strong enough yet.'
    };
}

const allItems = [...queueMap.values()]
    .map((item) => {
        const curatedMatches = findCuratedMatches(item);
        const classification = classifyQueueItem(item, curatedMatches);
        const priority = buildPriority(item);
        return {
            key: item.key,
            primaryModId: item.primaryModId,
            fileNames: [...item.fileNames].sort((left, right) => left.localeCompare(right)),
            modIds: [...item.modIds].sort((left, right) => left.localeCompare(right)),
            loaders: [...item.loaders].sort((left, right) => left.localeCompare(right)),
            displayNames: [...item.displayNames].sort((left, right) => left.localeCompare(right)),
            versions: [...item.versions].sort((left, right) => left.localeCompare(right)),
            instanceCount: item.instanceCount,
            corpusFiles: item.corpusFiles,
            reviewCount: item.reviewCount,
            keepCount: item.keepCount,
            removeCount: item.removeCount,
            manualKeepCount: item.manualKeepCount,
            manualExcludeCount: item.manualExcludeCount,
            runIds: [...item.runIds].sort((left, right) => left.localeCompare(right)),
            reportReasons: [...item.reportReasons].sort((left, right) => left.localeCompare(right)),
            declaredSides: item.declaredSides,
            metadataFilesFound: item.metadataFilesFound,
            corpusProposal: item.proposal,
            classification,
            curatedMatches,
            priority
        };
    })
    .sort((left, right) => right.priority - left.priority || left.key.localeCompare(right.key));

const queue = allItems.filter((item) => item.classification.status !== 'already-curated');
const covered = allItems.filter((item) => item.classification.status === 'already-curated');

await writeJson(outputQueuePath, {
    generatedAt: new Date().toISOString(),
    totalCandidates: allItems.length,
    pendingCandidates: queue.length,
    coveredCandidates: covered.length,
    queue
});

await writeJson(coveredQueuePath, {
    generatedAt: new Date().toISOString(),
    totalCovered: covered.length,
    covered
});

console.log(`generate-candidates: ok (${queue.length} pending, ${covered.length} already curated) -> ${outputQueuePath}`);
