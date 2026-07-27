import { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { extname } from 'path';
import { randomBytes } from 'crypto';
import { config } from '../config.js';
import * as store from '../store.js';
import { unlink } from 'fs';

const router = Router();

const symbolStorage = multer.diskStorage({
  destination: config.symbolsDir,
  filename: (_req, file, cb) => {
    const unique = randomBytes(12).toString('hex');
    const ext = extname(file.originalname);
    cb(null, `${unique}${ext}`);
  },
});

const upload = multer({
  storage: symbolStorage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB max for symbol files
});

/**
 * POST /api/v1/symbols
 * Upload a symbol file.
 * Form fields: file (required), platform, build_guid
 */
router.post(
  '/symbols',
  upload.single('file'),
  (req: Request, res: Response): void => {
    void (async () => {
      try {
        const file = req.file as Express.Multer.File | undefined;
        if (!file) {
          res.status(400).json({
            error: 'Bad Request',
            message: 'No file uploaded. Use field name "file".',
          });
          return;
        }

        const platform = req.body?.platform ?? 'unknown';
        const buildGuid = req.body?.build_guid ?? '';

        if (!buildGuid) {
          res.status(400).json({
            error: 'Bad Request',
            message: 'build_guid is required',
          });
          return;
        }

        const symbol = store.createSymbol(
          String(platform),
          String(buildGuid),
          file.originalname,
          file.size,
          file.path
        );

        res.status(201).json(symbol);
      } catch (err: any) {
        console.error('Error uploading symbol:', err);
        res.status(500).json({
          error: 'Internal Server Error',
          message: err.message,
        });
      }
    })();
  }
);

/**
 * GET /api/v1/symbols
 * List symbol files.
 */
router.get('/symbols', (req: Request, res: Response): void => {
  const q = req.query;
  const result = store.listSymbols({
    page: parseInt(String(q.page), 10) || 1,
    page_size: Math.min(parseInt(String(q.page_size), 10) || 50, 200),
    platform: q.platform as string | undefined,
    build_guid: q.build_guid as string | undefined,
  });
  res.json(result);
});

/**
 * DELETE /api/v1/symbols/:id
 * Delete a symbol file.
 */
router.delete('/symbols/:id', (req: Request, res: Response): void => {
  const id = parseInt(String(req.params.id), 10);
  if (isNaN(id)) {
    res.status(400).json({ error: 'Invalid ID' });
    return;
  }

  const symbol = store.getSymbolById(id);
  if (!symbol) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  // Delete file from disk
  unlink(symbol.file_path, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.error('Error deleting symbol file:', err);
    }
  });

  store.deleteSymbol(id);
  res.json({ success: true });
});

export default router;
