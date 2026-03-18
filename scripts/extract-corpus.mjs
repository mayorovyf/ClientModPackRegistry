import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
    buildSubjectKey,
    incrementCounter,
    mapToSortedRecord,
    normalizeStringArray,
    pickPrimaryModId,
    repoRoot,
    writeJson
} from './_common.mjs';

const instancesRoot = process.argv[2] || 'M:\\instances';
const outputIndexPath = path.join(repoRoot, 'fixtures', 'corpus-index.json');
const outputSummaryPath = path.join(repoRoot, 'fixtures', 'corpus-summary.json');
const outputModsPath = path.join(repoRoot, 'fixtures', 'corpus-mods.jsonl');
const outputSubjectsPath = path.join(repoRoot, 'candidates', 'imported-from-corpus', 'subject-summary.json');

const mainProjectDist = process.env.CLIENT_MOD_PACK_TO_SERVER_DIST
    || path.resolve(repoRoot, '..', 'ClientModPackToServer', 'dist');
const parseModulePath = path.join(mainProjectDist, 'metadata', 'parse-mod-file.js');

if (!fs.existsSync(parseModulePath)) {
    console.error(`extract-corpus: parser not found at ${parseModulePath}`);
    console.error('Build ClientModPackToServer first, or set CLIENT_MOD_PACK_TO_SERVER_DIST.');
    process.exit(1);
}

const require = createRequire(import.meta.url);
const { parseModFile } = require(parseModulePath);

function hasClientEntrypoint(descriptor) {
    return Array.isArray(descriptor?.entrypoints)
        && descriptor.entrypoints.some((entrypoint) => {
            const key = String(entrypoint?.key ?? '').trim().toLowerCase();
            return key === 'client' || key === 'modmenu';
        });
}

function createSubjectAggregate(descriptor) {
    return {
        key: buildSubjectKey({
            modIds: descriptor.modIds,
            fileName: descriptor.fileName,
            loader: descriptor.loader
        }),
        primaryModId: pickPrimaryModId(descriptor.modIds),
        fileNames: new Set(),
        modIds: new Set(),
        loaders: new Set(),
        displayNames: new Set(),
        versions: new Set(),
        metadataFilesFound: new Set(),
        instanceNames: new Set(),
        declaredSides: new Map(),
        totalFiles: 0,
        parsingWarnings: 0,
        parsingErrors: 0,
        filesWithWarnings: 0,
        filesWithErrors: 0,
        clientEntrypointHits: 0,
        sampleReason: null
    };
}

function deriveProposal(subject) {
    const sideKeys = [...subject.declaredSides.keys()];
    const onlyOneSide = sideKeys.length === 1 ? sideKeys[0] : null;
    const enoughCorpus = subject.totalFiles >= 2;

    if (onlyOneSide === 'client' && enoughCorpus) {
        return {
            side: 'client',
            confidence: subject.clientEntrypointHits > 0 ? 'high' : 'medium',
            status: 'safe-auto-candidate',
            reason: subject.clientEntrypointHits > 0
                ? 'Metadata consistently indicates a client-only mod with client entrypoints.'
                : 'Metadata consistently indicates a client-side mod across the corpus.'
        };
    }

    if (onlyOneSide === 'server' && enoughCorpus) {
        return {
            side: 'server',
            confidence: 'medium',
            status: 'safe-auto-candidate',
            reason: 'Metadata consistently indicates a server-side mod across the corpus.'
        };
    }

    if (onlyOneSide === 'both' && enoughCorpus) {
        return {
            side: 'both',
            confidence: 'medium',
            status: 'candidate',
            reason: 'Metadata consistently indicates compatibility with both sides.'
        };
    }

    return {
        side: 'unknown',
        confidence: 'none',
        status: 'needs-review',
        reason: sideKeys.length === 0
            ? 'No stable metadata side information was found.'
            : 'Corpus signals are mixed or too weak for an automatic proposal.'
    };
}

const entries = await fsp.readdir(instancesRoot, { withFileTypes: true });
const instances = [];
const modLines = [];
const subjects = new Map();
const loaderCounts = new Map();
const declaredSideCounts = new Map();
let totalJars = 0;

for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === '.tmp') {
        continue;
    }

    const modsDir = path.join(instancesRoot, entry.name, 'minecraft', 'mods');
    let modFiles = [];

    try {
        const items = await fsp.readdir(modsDir, { withFileTypes: true });
        modFiles = items.filter((item) => item.isFile() && item.name.endsWith('.jar'));
    } catch {
        instances.push({
            instanceName: entry.name,
            modsDir,
            hasMods: false,
            modCount: 0
        });
        continue;
    }

    instances.push({
        instanceName: entry.name,
        modsDir,
        hasMods: true,
        modCount: modFiles.length
    });

    totalJars += modFiles.length;

    for (const modFile of modFiles) {
        const fullPath = path.join(modsDir, modFile.name);
        const descriptor = parseModFile(fullPath);
        const normalizedDescriptor = {
            instanceName: entry.name,
            fileName: descriptor.fileName,
            fullPath,
            size: descriptor.fileSize,
            loader: descriptor.loader,
            modIds: normalizeStringArray(descriptor.modIds, { lowerCase: true }),
            displayName: descriptor.displayName,
            version: descriptor.version,
            declaredSide: descriptor.declaredSide,
            metadataFilesFound: normalizeStringArray(descriptor.metadataFilesFound),
            entrypointKeys: normalizeStringArray((descriptor.entrypoints || []).map((item) => item?.key)),
            dependencies: Array.isArray(descriptor.dependencies) ? descriptor.dependencies.length : 0,
            optionalDependencies: Array.isArray(descriptor.optionalDependencies) ? descriptor.optionalDependencies.length : 0,
            incompatibilities: Array.isArray(descriptor.incompatibilities) ? descriptor.incompatibilities.length : 0,
            parsingWarnings: Array.isArray(descriptor.parsingWarnings) ? descriptor.parsingWarnings.length : 0,
            parsingErrors: Array.isArray(descriptor.parsingErrors) ? descriptor.parsingErrors.length : 0,
            primaryModId: pickPrimaryModId(descriptor.modIds),
            subjectKey: buildSubjectKey({
                modIds: descriptor.modIds,
                fileName: descriptor.fileName,
                loader: descriptor.loader
            })
        };

        modLines.push(JSON.stringify(normalizedDescriptor));
        incrementCounter(loaderCounts, normalizedDescriptor.loader || 'unknown');
        incrementCounter(declaredSideCounts, normalizedDescriptor.declaredSide || 'unknown');

        const subject = subjects.get(normalizedDescriptor.subjectKey) || createSubjectAggregate(descriptor);
        subject.totalFiles += 1;
        subject.fileNames.add(normalizedDescriptor.fileName);
        normalizedDescriptor.modIds.forEach((modId) => subject.modIds.add(modId));
        subject.loaders.add(normalizedDescriptor.loader || 'unknown');
        if (normalizedDescriptor.displayName) {
            subject.displayNames.add(normalizedDescriptor.displayName);
        }
        if (normalizedDescriptor.version) {
            subject.versions.add(normalizedDescriptor.version);
        }
        normalizedDescriptor.metadataFilesFound.forEach((metadataFile) => subject.metadataFilesFound.add(metadataFile));
        subject.instanceNames.add(entry.name);
        incrementCounter(subject.declaredSides, normalizedDescriptor.declaredSide || 'unknown');
        subject.parsingWarnings += normalizedDescriptor.parsingWarnings;
        subject.parsingErrors += normalizedDescriptor.parsingErrors;
        if (normalizedDescriptor.parsingWarnings > 0) {
            subject.filesWithWarnings += 1;
        }
        if (normalizedDescriptor.parsingErrors > 0) {
            subject.filesWithErrors += 1;
        }
        if (hasClientEntrypoint(descriptor)) {
            subject.clientEntrypointHits += 1;
        }
        subjects.set(normalizedDescriptor.subjectKey, subject);
    }
}

const instancesWithMods = instances.filter((item) => item.hasMods);
const subjectSummaries = [...subjects.values()]
    .map((subject) => {
        const proposal = deriveProposal(subject);
        return {
            key: subject.key,
            primaryModId: subject.primaryModId,
            fileNames: [...subject.fileNames].sort((left, right) => left.localeCompare(right)),
            modIds: [...subject.modIds].sort((left, right) => left.localeCompare(right)),
            loaders: [...subject.loaders].sort((left, right) => left.localeCompare(right)),
            displayNames: [...subject.displayNames].sort((left, right) => left.localeCompare(right)),
            versions: [...subject.versions].sort((left, right) => left.localeCompare(right)),
            metadataFilesFound: [...subject.metadataFilesFound].sort((left, right) => left.localeCompare(right)),
            instanceCount: subject.instanceNames.size,
            instanceNames: [...subject.instanceNames].sort((left, right) => left.localeCompare(right)),
            totalFiles: subject.totalFiles,
            declaredSides: mapToSortedRecord(subject.declaredSides),
            parsingWarnings: subject.parsingWarnings,
            parsingErrors: subject.parsingErrors,
            filesWithWarnings: subject.filesWithWarnings,
            filesWithErrors: subject.filesWithErrors,
            clientEntrypointHits: subject.clientEntrypointHits,
            proposal
        };
    })
    .sort((left, right) => right.instanceCount - left.instanceCount || right.totalFiles - left.totalFiles || left.key.localeCompare(right.key));

const summary = {
    generatedAt: new Date().toISOString(),
    instancesRoot,
    instancesTotal: instances.length,
    instancesWithMods: instancesWithMods.length,
    totalJars,
    uniqueSubjects: subjectSummaries.length,
    averageJarsPerInstance: instancesWithMods.length > 0
        ? Number((totalJars / instancesWithMods.length).toFixed(1))
        : 0,
    loaders: mapToSortedRecord(loaderCounts),
    declaredSides: mapToSortedRecord(declaredSideCounts)
};

await writeJson(outputIndexPath, { generatedAt: new Date().toISOString(), instancesRoot, instances });
await writeJson(outputSummaryPath, summary);
await writeJson(outputSubjectsPath, {
    generatedAt: new Date().toISOString(),
    instancesRoot,
    subjects: subjectSummaries
});
await fsp.writeFile(outputModsPath, `${modLines.join('\n')}${modLines.length > 0 ? '\n' : ''}`, 'utf8');
console.log(`extract-corpus: ok (${summary.instancesWithMods}/${summary.instancesTotal} instances with mods, ${summary.totalJars} jars, ${summary.uniqueSubjects} subjects)`);
