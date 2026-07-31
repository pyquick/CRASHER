import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { randomBytes } from 'crypto';
import { join } from 'path';
import { unlinkSync, writeFileSync } from 'fs';
import { extractTarGz } from '../archive.js';
import { config } from '../config.js';
import * as store from '../store.js';
import {
  isTextSource,
  normalizeProjectName,
  normalizeRelease,
  normalizeSourcePath,
  sourceLanguage,
} from '../source.js';

const router = Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: config.maxSourceArchiveSize,
    files: 101,
  },
});

type SourceCandidate = { path: string; data: Buffer; language: string };

router.post(
  '/project-sources',
  upload.fields([{ name: 'files', maxCount: 100 }, { name: 'archive', maxCount: 1 }]),
  handleSourceUpload
);

function handleSourceUpload(req: Request, res: Response): void {
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
      for (const entry of extractTarGz(archive.buffer, config.maxSourceArchiveSize)) {
        addCandidate(candidates, skipped, entry.name, entry.data);
      }
    }

    if (candidates.length === 0) {
      res.status(400).json({ error: 'Bad Request', message: 'No supported text source files found', skipped });
      return;
    }
    if (candidates.length > config.maxSourceFiles) throw new Error(`Source upload exceeds ${config.maxSourceFiles} files`);
    const totalSize = candidates.reduce((total, file) => total + file.data.length, 0);
    if (totalSize > config.maxSourceArchiveSize) throw new Error('Expanded source upload is too large');

    const unique = new Map<string, SourceCandidate>();
    for (const candidate of candidates) unique.set(candidate.path.toLowerCase(), candidate);

    const now = new Date().toISOString();
    const project = store.getOrCreateProject(projectName, now);
    const snapshot = store.createSourceSnapshot(project.id, release, now);
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
  const language = sourceLanguage(path);
  if (!language) {
    skipped.push({ path, reason: 'unsupported extension' });
    return;
  }
  if (data.length > config.maxSourceFileSize) {
    skipped.push({ path, reason: 'file too large' });
    return;
  }
  if (!isTextSource(data)) {
    skipped.push({ path, reason: 'binary content' });
    return;
  }
  candidates.push({ path, data, language });
}

export default router;
