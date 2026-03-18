import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const repoRoot = fileURLToPath(new URL('../', import.meta.url));
export const registryDirectories = [
    'registry/fabric',
    'registry/quilt',
    'registry/forge',
    'registry/neoforge',
    'registry/mixed',
    'registry/shared'
];

const validLoaders = new Set(['fabric', 'quilt', 'forge', 'neoforge', 'shared']);
const validSides = new Set(['client', 'server', 'both', 'unknown']);
const validConfidence = new Set(['high', 'medium', 'low', 'none']);

export async function ensureDir(dirPath) {
    await fsp.mkdir(dirPath, { recursive: true });
}

export async function readJson(filePath) {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
}

export async function writeJson(filePath, value) {
    await ensureDir(path.dirname(filePath));
    await fsp.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export function normalizeStringArray(value, { lowerCase = false } = {}) {
    const items = Array.isArray(value) ? value : [];
    const normalized = items
        .map((item) => String(item ?? '').trim())
        .filter(Boolean)
        .map((item) => (lowerCase ? item.toLowerCase() : item));
    return [...new Set(normalized)].sort((left, right) => left.localeCompare(right));
}

export function normalizeFileName(fileName) {
    return String(fileName ?? '').trim().toLowerCase();
}

export function pickPrimaryModId(modIds) {
    const normalized = normalizeStringArray(modIds, { lowerCase: true });
    return normalized[0] || null;
}

export function buildSubjectKey({ modIds, fileName, loader }) {
    const primaryModId = pickPrimaryModId(modIds);
    const normalizedLoader = String(loader ?? 'unknown').trim().toLowerCase() || 'unknown';

    if (primaryModId) {
        return `mod:${primaryModId}::${normalizedLoader}`;
    }

    return `file:${normalizeFileName(fileName)}::${normalizedLoader}`;
}

export function incrementCounter(map, key, amount = 1) {
    map.set(key, (map.get(key) || 0) + amount);
}

export function mapToSortedRecord(map) {
    return Object.fromEntries(
        [...map.entries()].sort((left, right) => String(left[0]).localeCompare(String(right[0])))
    );
}

export function normalizeRule(rule) {
    return {
        ruleId: String(rule.ruleId).trim(),
        modIds: normalizeStringArray(rule.modIds, { lowerCase: true }),
        aliases: normalizeStringArray(rule.aliases, { lowerCase: true }),
        fileNames: normalizeStringArray(rule.fileNames),
        loaders: normalizeStringArray(rule.loaders, { lowerCase: true }),
        side: String(rule.side).trim(),
        confidence: String(rule.confidence).trim(),
        reason: String(rule.reason).trim(),
        source: String(rule.source).trim(),
        priority: Number.isInteger(rule.priority) ? rule.priority : 100,
        updatedAt: typeof rule.updatedAt === 'string' ? rule.updatedAt : null,
        notes: typeof rule.notes === 'string' ? rule.notes : null
    };
}

export function validateRuleData(rule, sourcePath = '') {
    const errors = [];
    const normalized = normalizeRule(rule);

    if (!normalized.ruleId) {
        errors.push(`${sourcePath}: ruleId is required`);
    }
    if (normalized.modIds.length === 0 && normalized.aliases.length === 0 && normalized.fileNames.length === 0) {
        errors.push(`${sourcePath}: at least one matching identifier is required (modIds, aliases or fileNames)`);
    }
    if (normalized.loaders.length === 0) {
        errors.push(`${sourcePath}: loaders must contain at least one item`);
    }
    if (normalized.loaders.some((loader) => !validLoaders.has(loader))) {
        errors.push(`${sourcePath}: loaders contain unsupported values`);
    }
    if (!validSides.has(normalized.side)) {
        errors.push(`${sourcePath}: side must be one of client/server/both/unknown`);
    }
    if (!validConfidence.has(normalized.confidence)) {
        errors.push(`${sourcePath}: confidence must be one of high/medium/low/none`);
    }
    if (!normalized.reason) {
        errors.push(`${sourcePath}: reason is required`);
    }
    if (!normalized.source) {
        errors.push(`${sourcePath}: source is required`);
    }

    return { errors, normalized };
}

export async function listJsonFiles(relativeDir) {
    const absoluteDir = path.join(repoRoot, relativeDir);
    if (!fs.existsSync(absoluteDir)) {
        return [];
    }

    const entries = await fsp.readdir(absoluteDir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
        const absolutePath = path.join(absoluteDir, entry.name);
        if (entry.isDirectory()) {
            const nested = await listJsonFiles(path.join(relativeDir, entry.name));
            files.push(...nested);
            continue;
        }
        if (entry.isFile() && entry.name.endsWith('.json')) {
            files.push(absolutePath);
        }
    }

    return files;
}

export async function loadCuratedRules() {
    const filePaths = [];
    for (const relativeDir of registryDirectories) {
        const files = await listJsonFiles(relativeDir);
        filePaths.push(...files);
    }

    const loaded = [];
    for (const filePath of filePaths) {
        const document = await readJson(filePath);
        loaded.push({ filePath, document });
    }

    return loaded;
}

export function expandCuratedDocument(filePath, document) {
    if (Array.isArray(document?.rules)) {
        return document.rules.map((rule, index) => ({
            filePath,
            sourcePath: `${filePath}#rules[${index}]`,
            document: rule
        }));
    }

    return [{ filePath, sourcePath: filePath, document }];
}

export async function loadExpandedCuratedRules() {
    const loaded = await loadCuratedRules();
    return loaded.flatMap(({ filePath, document }) => expandCuratedDocument(filePath, document));
}

export function createRegistryVersion() {
    const now = new Date();
    const year = now.getUTCFullYear();
    const month = String(now.getUTCMonth() + 1).padStart(2, '0');
    const day = String(now.getUTCDate()).padStart(2, '0');
    const hours = String(now.getUTCHours()).padStart(2, '0');
    const minutes = String(now.getUTCMinutes()).padStart(2, '0');
    const seconds = String(now.getUTCSeconds()).padStart(2, '0');
    return `${year}.${month}.${day}-${hours}${minutes}${seconds}`;
}

export function sha256(buffer) {
    return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}
