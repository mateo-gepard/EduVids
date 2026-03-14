import multer from 'multer';
import path from 'path';
import { config } from '../../core/config.js';

// Allowed MIME types (validated by multer from Content-Type header, not filename).
// Checking the filename extension is bypassable — anyone can rename a file.
const ALLOWED_MIME_TYPES = new Set([
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, config.tmpDir);
  },
  filename: (_req, file, cb) => {
    // Use MIME type to derive extension, not the client-supplied filename
    const mimeToExt: Record<string, string> = {
      'application/pdf': '.pdf',
      'image/png': '.png',
      'image/jpeg': '.jpg',
      'image/webp': '.webp',
      'image/gif': '.gif',
    };
    const ext = mimeToExt[file.mimetype] || path.extname(file.originalname).toLowerCase();
    cb(null, `upload_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  },
});

export const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_MIME_TYPES.has(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(
        `File type "${file.mimetype}" is not allowed. ` +
        `Accepted types: PDF, PNG, JPEG, WebP.`
      ));
    }
  },
});
