import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { ensureDir, readJson, repoRoot, writeJson } from './_common.mjs';

const mainProjectRoot = process.env.CLIENT_MOD_PACK_TO_SERVER_ROOT
    || path.resolve(repoRoot, '..', 'ClientModPackToServer');
const mainProjectEntry = path.join(mainProjectRoot, 'index.js');
const bundlePath = path.join(repoRoot, 'bundles', 'latest', 'registry.bundle.json');
const corpusIndexPath = path.join(repoRoot, 'fixtures', 'corpus-index.json');

const defaultInstanceNames = ['Better MC', 'Prominence II', 'FTB StoneBlock 4'];
const requestedTargets = process.argv.slice(2);

if (!fs.existsSync(mainProjectEntry)) {
    console.error(`dev-check: main project entry was not found: ${mainProjectEntry}`);
    process.exit(1);
}

if (!fs.existsSync(bundlePath)) {
    console.error(`dev-check: latest registry bundle was not found: ${bundlePath}`);
    process.exit(1);
}

const corpusIndex = await readJson(corpusIndexPath);
const indexedInstances = Array.isArray(corpusIndex?.instances) ? corpusIndex.instances : [];
const indexedByName = new Map(
    indexedInstances
        .filter((item) => item?.hasMods && typeof item.instanceName === 'string' && typeof item.modsDir === 'string')
        .map((item) => [
            item.instanceName.toLowerCase(),
            {
                instanceName: item.instanceName,
                instancePath: path.dirname(item.modsDir),
                modCount: Number(item.modCount || 0)
            }
        ])
);

function slugify(value) {
    return String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'instance';
}

function resolveInstanceTarget(rawValue) {
    const normalized = String(rawValue || '').trim();

    if (!normalized) {
        return null;
    }

    if (fs.existsSync(normalized)) {
        const resolved = path.resolve(normalized);
        const directMods = path.join(resolved, 'mods');
        const minecraftMods = path.join(resolved, 'minecraft', 'mods');

        if (fs.existsSync(directMods)) {
            return {
                instanceName: path.basename(resolved),
                instancePath: resolved,
                modCount: null
            };
        }

        if (fs.existsSync(minecraftMods)) {
            return {
                instanceName: path.basename(resolved),
                instancePath: path.join(resolved, 'minecraft'),
                modCount: null
            };
        }

        return {
            instanceName: path.basename(resolved),
            instancePath: resolved,
            modCount: null
        };
    }

    const exact = indexedByName.get(normalized.toLowerCase());
    if (exact) {
        return exact;
    }

    const partial = [...indexedByName.values()].find((item) => item.instanceName.toLowerCase().includes(normalized.toLowerCase()));
    return partial || null;
}

function getReviewCount(report) {
    const arbiterReview = report?.arbiter?.summary?.finalDecisions?.review;
    if (Number.isInteger(arbiterReview)) {
        return arbiterReview;
    }

    const decisions = Array.isArray(report?.decisions) ? report.decisions : [];
    return decisions.filter((decision) => decision?.finalSemanticDecision === 'review' || decision?.requiresReview === true).length;
}

async function findSingleRunReport(reportRoot) {
    const entries = await fsp.readdir(reportRoot, { withFileTypes: true });
    const directories = entries.filter((entry) => entry.isDirectory());

    if (directories.length === 0) {
        throw new Error(`No run directories were created in ${reportRoot}`);
    }

    const resolved = await Promise.all(
        directories.map(async (entry) => {
            const absolutePath = path.join(reportRoot, entry.name);
            const stat = await fsp.stat(absolutePath);
            return {
                name: entry.name,
                absolutePath,
                mtimeMs: stat.mtimeMs
            };
        })
    );

    resolved.sort((left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name));
    const selected = resolved[0];
    const reportPath = path.join(selected.absolutePath, 'report.json');
    return {
        runDir: selected.absolutePath,
        reportPath,
        report: await readJson(reportPath)
    };
}

function buildScenarioArgs({
    instancePath,
    outputRoot,
    reportRoot,
    runIdPrefix,
    serverDirName,
    registryFilePath = null
}) {
    const args = [
        mainProjectEntry,
        '--input', instancePath,
        '--output', outputRoot,
        '--server-dir-name', serverDirName,
        '--report-dir', reportRoot,
        '--run-id-prefix', runIdPrefix,
        '--dry-run',
        '--registry-mode', 'offline',
        '--validation', 'off'
    ];

    if (registryFilePath) {
        args.push('--registry-file', registryFilePath);
    }

    return args;
}

function executeScenario({
    scenarioKey,
    instanceName,
    instancePath,
    outputRoot,
    reportRoot,
    runIdPrefix,
    serverDirName,
    registryFilePath = null
}) {
    const args = buildScenarioArgs({
        instancePath,
        outputRoot,
        reportRoot,
        runIdPrefix,
        serverDirName,
        registryFilePath
    });

    const result = spawnSync(process.execPath, args, {
        cwd: mainProjectRoot,
        encoding: 'utf8',
        timeout: 30 * 60 * 1000,
        maxBuffer: 32 * 1024 * 1024
    });

    const log = {
        command: [process.execPath, ...args].join(' '),
        exitCode: result.status,
        signal: result.signal,
        stdout: result.stdout || '',
        stderr: result.stderr || ''
    };

    if (result.error) {
        const error = new Error(`Scenario ${scenarioKey} failed: ${result.error.message}`);
        error.cause = result.error;
        error.log = log;
        throw error;
    }

    if (result.status !== 0) {
        const error = new Error(`Scenario ${scenarioKey} exited with code ${result.status}`);
        error.log = log;
        throw error;
    }

    return log;
}

const selectedTargets = (requestedTargets.length > 0 ? requestedTargets : defaultInstanceNames)
    .map(resolveInstanceTarget)
    .filter(Boolean);

if (selectedTargets.length === 0) {
    console.error('dev-check: no valid instance targets were resolved');
    process.exit(1);
}

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const runRoot = path.join(repoRoot, '.tmp', 'dev-checks', timestamp);
await ensureDir(runRoot);

const summary = {
    generatedAt: new Date().toISOString(),
    mainProjectRoot,
    bundlePath,
    targets: [],
    aggregate: {
        instances: 0,
        baselineReview: 0,
        bundleReview: 0,
        reviewDelta: 0
    }
};

for (const target of selectedTargets) {
    const instanceSlug = slugify(target.instanceName);
    const instanceRoot = path.join(runRoot, instanceSlug);
    const baselineOutputRoot = path.join(instanceRoot, 'baseline', 'builds');
    const baselineReportRoot = path.join(instanceRoot, 'baseline', 'reports');
    const bundleOutputRoot = path.join(instanceRoot, 'bundle', 'builds');
    const bundleReportRoot = path.join(instanceRoot, 'bundle', 'reports');

    await Promise.all([
        ensureDir(baselineOutputRoot),
        ensureDir(baselineReportRoot),
        ensureDir(bundleOutputRoot),
        ensureDir(bundleReportRoot)
    ]);

    const baselineLog = executeScenario({
        scenarioKey: 'baseline',
        instanceName: target.instanceName,
        instancePath: target.instancePath,
        outputRoot: baselineOutputRoot,
        reportRoot: baselineReportRoot,
        runIdPrefix: `baseline-${instanceSlug}`,
        serverDirName: `${instanceSlug}-server`
    });
    const baselineResult = await findSingleRunReport(baselineReportRoot);

    const bundleLog = executeScenario({
        scenarioKey: 'bundle',
        instanceName: target.instanceName,
        instancePath: target.instancePath,
        outputRoot: bundleOutputRoot,
        reportRoot: bundleReportRoot,
        runIdPrefix: `bundle-${instanceSlug}`,
        serverDirName: `${instanceSlug}-server`,
        registryFilePath: bundlePath
    });
    const bundleResult = await findSingleRunReport(bundleReportRoot);

    const baselineReview = getReviewCount(baselineResult.report);
    const bundleReview = getReviewCount(bundleResult.report);

    const targetSummary = {
        instanceName: target.instanceName,
        instancePath: target.instancePath,
        modCount: target.modCount,
        baseline: {
            reviewCount: baselineReview,
            kept: baselineResult.report?.stats?.kept ?? 0,
            excluded: baselineResult.report?.stats?.excluded ?? 0,
            registryVersion: baselineResult.report?.registry?.registryVersion ?? 'unknown',
            effectiveRuleCount: baselineResult.report?.registry?.effectiveRuleCount ?? 0,
            reportDir: baselineResult.runDir,
            reportPath: baselineResult.reportPath,
            logPath: path.join(instanceRoot, 'baseline', 'command.log')
        },
        bundle: {
            reviewCount: bundleReview,
            kept: bundleResult.report?.stats?.kept ?? 0,
            excluded: bundleResult.report?.stats?.excluded ?? 0,
            registryVersion: bundleResult.report?.registry?.registryVersion ?? 'unknown',
            effectiveRuleCount: bundleResult.report?.registry?.effectiveRuleCount ?? 0,
            reportDir: bundleResult.runDir,
            reportPath: bundleResult.reportPath,
            logPath: path.join(instanceRoot, 'bundle', 'command.log')
        },
        delta: {
            review: bundleReview - baselineReview,
            kept: (bundleResult.report?.stats?.kept ?? 0) - (baselineResult.report?.stats?.kept ?? 0),
            excluded: (bundleResult.report?.stats?.excluded ?? 0) - (baselineResult.report?.stats?.excluded ?? 0)
        }
    };

    await Promise.all([
        fsp.writeFile(
            path.join(instanceRoot, 'baseline', 'command.log'),
            `${baselineLog.command}\n\n[stdout]\n${baselineLog.stdout}\n\n[stderr]\n${baselineLog.stderr}\n`,
            'utf8'
        ),
        fsp.writeFile(
            path.join(instanceRoot, 'bundle', 'command.log'),
            `${bundleLog.command}\n\n[stdout]\n${bundleLog.stdout}\n\n[stderr]\n${bundleLog.stderr}\n`,
            'utf8'
        )
    ]);

    summary.targets.push(targetSummary);
    summary.aggregate.instances += 1;
    summary.aggregate.baselineReview += baselineReview;
    summary.aggregate.bundleReview += bundleReview;
}

summary.aggregate.reviewDelta = summary.aggregate.bundleReview - summary.aggregate.baselineReview;

const markdownLines = [
    '# Dev Check Summary',
    '',
    `- Generated at: ${summary.generatedAt}`,
    `- Main project: ${summary.mainProjectRoot}`,
    `- Registry bundle: ${summary.bundlePath}`,
    `- Instances: ${summary.aggregate.instances}`,
    `- Baseline review: ${summary.aggregate.baselineReview}`,
    `- Bundle review: ${summary.aggregate.bundleReview}`,
    `- Review delta: ${summary.aggregate.reviewDelta}`,
    '',
    '| Instance | Mods | Baseline review | Bundle review | Delta |',
    '| --- | ---: | ---: | ---: | ---: |'
];

for (const target of summary.targets) {
    markdownLines.push(
        `| ${target.instanceName} | ${target.modCount ?? 'n/a'} | ${target.baseline.reviewCount} | ${target.bundle.reviewCount} | ${target.delta.review} |`
    );
}

const summaryJsonPath = path.join(runRoot, 'summary.json');
const summaryMarkdownPath = path.join(runRoot, 'summary.md');
await writeJson(summaryJsonPath, summary);
await fsp.writeFile(summaryMarkdownPath, `${markdownLines.join('\n')}\n`, 'utf8');

console.log(`dev-check: ok -> ${summaryJsonPath}`);
console.log(`dev-check: markdown -> ${summaryMarkdownPath}`);
