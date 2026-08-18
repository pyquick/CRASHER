import { Router, type Request, type Response, type NextFunction } from 'express';
import multer from 'multer';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { unlinkSync, writeFileSync } from 'fs';
import { extractTarGz } from '../archive.js';
import { config } from '../config.js';
import { getContainerById } from '../auth/container.js';
import { CONTAINER_SOURCE_LIMITS, type ContainerTier, type SourceUploadLimits } from '../model.js';
import * as store from '../store.js';
import {
  isTextSource,
  normalizeProjectName,
  normalizeRelease,
  normalizeSourcePath,
  sourceLanguage,
} from '../source.js';

const router = Router();

type SourceCandidate = { path: string; data: Buffer; language: string };

interface ResolvedSourceLimits extends SourceUploadLimits {
  tier: ContainerTier | null; // null = no tier-level limit (T4/T5 or no container)
}

function resolveSourceLimits(req: Request): ResolvedSourceLimits {
  const containerId = req.authUser?.container_id ?? null;
  const container = containerId !== null ? getContainerById(containerId) : undefined;
  const tier = (container?.tier as ContainerTier | undefined) ?? null;
  const tierLimits = tier !== null ? CONTAINER_SOURCE_LIMITS[tier] : null;
  return tierLimits
    ? { ...tierLimits, tier }
    : { maxFiles: config.maxSourceFiles, maxBytes: config.maxSourceArchiveSize, tier: null };
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024 && bytes % (1024 * 1024 * 1024) === 0) return `${bytes / (1024 * 1024 * 1024)}GB`;
  if (bytes >= 1024 * 1024 && bytes % (1024 * 1024) === 0) return `${bytes / (1024 * 1024)}MB`;
  return `${bytes} bytes`;
}

function limitLabel(limits: ResolvedSourceLimits): string {
  return limits.tier !== null ? `container tier T${limits.tier}` : 'server';
}

router.post(
  '/project-sources',
  (req: Request, res: Response, next: NextFunction): void => {
    const limits = resolveSourceLimits(req);
    res.locals.sourceLimits = limits;
    const upload = multer({
      storage: multer.memoryStorage(),
      limits: { fileSize: limits.maxBytes, files: limits.maxFiles + 1 },
    });
    upload.fields([
      { name: 'files', maxCount: limits.maxFiles },
      { name: 'archive', maxCount: 1 },
    ])(req, res, (err: unknown) => {
      if (err) {
        if (err instanceof multer.MulterError) {
          res.status(400).json({
            error: 'Bad Request',
            message: `Source upload exceeds the ${limitLabel(limits)} limit: ${err.message}`,
          });
          return;
        }
        next(err);
        return;
      }
      next();
    });
  },
  handleSourceUpload
);

function handleSourceUpload(req: Request, res: Response): void {
  const limits = res.locals.sourceLimits as ResolvedSourceLimits;
  const storedPaths: string[] = [];
  let snapshotId: number | null = null;
  try {
    const projectName = normalizeProjectName(req.body?.project_name);
    const release = normalizeRelease(req.body?.release);
    const fields = ((req as any).files ?? {}) as Record<string, Express.Multer.File[]>;
    const looseFiles = fields.files ?? [];
    const archives = fields.archive ?? [];
    if (looseFiles.length === 0 && archives.length === 0) {
      res.status(400).json({ error: 'Bad Request', message: 'Upload at least one files or archive field' });
      return;
    }

    const candidates: SourceCandidate[] = [];
    const skipped: Array<{ path: string; reason: string }> = [];

    for (const file of looseFiles) {
      addCandidate(candidates, skipped, file.originalname, file.buffer);
    }
    for (const archive of archives) {
      if (!/\.(?:tar\.gz|tgz)$/i.test(archive.originalname)) {
        throw new Error('archive must be a .tar.gz or .tgz file');
      }
      for (const entry of extractTarGz(archive.buffer, limits.maxBytes, limits.maxFiles)) {
        addCandidate(candidates, skipped, entry.name, entry.data);
      }
    }

    if (candidates.length === 0) {
      res.status(400).json({ error: 'Bad Request', message: 'No text source files found', skipped });
      return;
    }
    if (candidates.length > limits.maxFiles) {
      throw new Error(`Source upload exceeds the ${limitLabel(limits)} limit of ${limits.maxFiles} files`);
    }
    const totalSize = candidates.reduce((total, file) => total + file.data.length, 0);
    if (totalSize > limits.maxBytes) {
      throw new Error(`Expanded source upload exceeds the ${limitLabel(limits)} limit of ${formatBytes(limits.maxBytes)}`);
    }

    const unique = new Map<string, SourceCandidate>();
    for (const candidate of candidates) unique.set(candidate.path.toLowerCase(), candidate);

    const now = new Date().toISOString();
    const containerId = req.authUser?.container_id ?? null;
    const project = store.getOrCreateProject(projectName, now, containerId);
    const snapshot = store.createSourceSnapshot(project.id, release, now, containerId);
    snapshotId = snapshot.id;

    const accepted: Array<{ path: string; file_size: number; language: string }> = [];
    for (const candidate of unique.values()) {
      const storagePath = join(config.sourcesDir, `${randomBytes(16).toString('hex')}.src`);
      writeFileSync(storagePath, candidate.data, { flag: 'wx' });
      storedPaths.push(storagePath);
      store.createSourceFile(snapshot.id, candidate.path, storagePath, candidate.data.length, candidate.language);
      accepted.push({ path: candidate.path, file_size: candidate.data.length, language: candidate.language });
    }

    res.status(201).json({
      project: { id: project.id, name: project.name },
      release,
      snapshot_id: snapshot.id,
      accepted,
      skipped,
    });
  } catch (err: any) {
    for (const filePath of storedPaths) {
      try { unlinkSync(filePath); } catch {}
    }
    if (snapshotId !== null) store.deleteSourceSnapshot(snapshotId);
    res.status(400).json({ error: 'Bad Request', message: err.message || 'Could not upload source files' });
  }
}

function addCandidate(
  candidates: SourceCandidate[],
  skipped: Array<{ path: string; reason: string }>,
  originalPath: string,
  data: Buffer
): void {
  let path: string;
  try {
    path = normalizeSourcePath(originalPath);
  } catch (err: any) {
    throw new Error(`${originalPath}: ${err.message}`);
  }
  if (data.length > config.maxSourceFileSize) {
    skipped.push({ path, reason: 'file too large' });
    return;
  }
  if (!isTextSource(data)) {
    skipped.push({ path, reason: 'binary content' });
    return;
  }
  // Any text file is accepted (non-Unity projects included); unknown
  // extensions are stored with a generic 'text' language label.
  candidates.push({ path, data, language: sourceLanguage(path) ?? 'text' });
}

export default router;
