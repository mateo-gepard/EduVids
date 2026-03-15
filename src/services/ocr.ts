import fs from 'fs/promises';
import { createWorker } from 'tesseract.js';
import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import type { OcrResult } from '../core/types.js';

const log = createLogger({ service: 'ocr' });

const VISION_URL = 'https://vision.googleapis.com/v1/images:annotate';

/**
 * Run OCR on an image. Uses Google Cloud Vision when available,
 * otherwise falls back to local Tesseract.js (no API key needed).
 */
export async function recognizeText(imagePath: string): Promise<OcrResult> {
  if (config.mockMode) {
    log.info('Mock mode: returning placeholder OCR result');
    return {
      fullText: 'Photosynthese Chlorophyll Licht Wasser CO2 Glucose',
      words: [
        { text: 'Photosynthese', boundingBox: { x: 10, y: 10, width: 200, height: 30 }, confidence: 0.99 },
        { text: 'Chlorophyll', boundingBox: { x: 10, y: 50, width: 160, height: 30 }, confidence: 0.98 },
        { text: 'Licht', boundingBox: { x: 10, y: 90, width: 80, height: 30 }, confidence: 0.97 },
        { text: 'Wasser', boundingBox: { x: 200, y: 90, width: 100, height: 30 }, confidence: 0.96 },
        { text: 'CO2', boundingBox: { x: 10, y: 130, width: 60, height: 30 }, confidence: 0.95 },
        { text: 'Glucose', boundingBox: { x: 200, y: 130, width: 120, height: 30 }, confidence: 0.97 },
      ],
    };
  }

  if (config.googleVisionKey) {
    return recognizeTextGoogleVision(imagePath);
  }

  return recognizeTextTesseract(imagePath);
}

/**
 * Local OCR using Tesseract.js — no API key needed.
 * Returns word-level bounding boxes suitable for keyword overlay.
 */
async function recognizeTextTesseract(imagePath: string): Promise<OcrResult> {
  log.info({ imagePath }, 'Running local OCR with Tesseract.js');

  const worker = await createWorker('eng');
  try {
    const { data } = await worker.recognize(imagePath);

    // Words are nested: blocks → paragraphs → lines → words
    const words: OcrResult['words'] = [];
    for (const block of data.blocks || []) {
      for (const paragraph of block.paragraphs || []) {
        for (const line of paragraph.lines || []) {
          for (const word of line.words || []) {
            words.push({
              text: word.text,
              boundingBox: {
                x: word.bbox.x0,
                y: word.bbox.y0,
                width: word.bbox.x1 - word.bbox.x0,
                height: word.bbox.y1 - word.bbox.y0,
              },
              confidence: (word.confidence || 0) / 100,
            });
          }
        }
      }
    }

    log.info({ wordCount: words.length }, 'Tesseract OCR complete');

    return {
      fullText: data.text || '',
      words,
    };
  } finally {
    await worker.terminate();
  }
}

/**
 * OCR using Google Cloud Vision API (requires GOOGLE_CLOUD_VISION_KEY).
 */
async function recognizeTextGoogleVision(imagePath: string): Promise<OcrResult> {

  const imageBytes = await fs.readFile(imagePath);
  const base64 = imageBytes.toString('base64');

  log.info({ imagePath }, 'Running OCR on image');

  const response = await fetch(`${VISION_URL}?key=${config.googleVisionKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      requests: [
        {
          image: { content: base64 },
          features: [{ type: 'TEXT_DETECTION', maxResults: 100 }],
        },
      ],
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google Vision OCR error ${response.status}: ${error}`);
  }

  const data = await response.json();
  const annotations = data.responses?.[0]?.textAnnotations || [];

  if (annotations.length === 0) {
    return { fullText: '', words: [] };
  }

  // First annotation is the full text
  const fullText = annotations[0].description || '';

  // Remaining annotations are individual words
  const words = annotations.slice(1).map((annotation: any) => {
    const vertices = annotation.boundingPoly?.vertices || [];
    const xs = vertices.map((v: any) => v.x || 0);
    const ys = vertices.map((v: any) => v.y || 0);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    const maxX = Math.max(...xs);
    const maxY = Math.max(...ys);

    return {
      text: annotation.description || '',
      boundingBox: {
        x: minX,
        y: minY,
        width: maxX - minX,
        height: maxY - minY,
      },
      confidence: annotation.confidence || 0.9,
    };
  });

  log.info({ wordCount: words.length }, 'OCR complete');

  return { fullText, words };
}

/**
 * Check if a sufficient percentage of keywords are found in the OCR result.
 */
export function checkKeywordCoverage(
  ocrResult: OcrResult,
  keywords: string[],
  threshold: number = 0.8
): { passed: boolean; matchedCount: number; totalKeywords: number; matchedKeywords: string[] } {
  const ocrTextLower = ocrResult.fullText.toLowerCase();
  const matchedKeywords = keywords.filter((kw) =>
    ocrTextLower.includes(kw.toLowerCase())
  );

  const ratio = matchedKeywords.length / keywords.length;

  return {
    passed: ratio >= threshold,
    matchedCount: matchedKeywords.length,
    totalKeywords: keywords.length,
    matchedKeywords,
  };
}

/**
 * Find precise bounding boxes for keywords in OCR results.
 * Handles single-word and multi-word keyword matching.
 * Returns the keyword and its merged bounding box in original image coordinates.
 */
export function findKeywordBoundingBoxes(
  ocrResult: OcrResult,
  keywords: string[]
): Array<{ keyword: string; box: { x: number; y: number; width: number; height: number } }> {
  const results: Array<{ keyword: string; box: { x: number; y: number; width: number; height: number } }> = [];
  const words = ocrResult.words;

  for (const keyword of keywords) {
    const kwParts = keyword.toLowerCase().split(/\s+/);
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9äöüß]/gi, '');

    if (kwParts.length === 1) {
      // Single-word keyword — find best matching OCR word
      const target = normalize(kwParts[0]);
      const match = words.find(w => {
        const wNorm = normalize(w.text);
        return wNorm.includes(target) || target.includes(wNorm);
      });
      if (match) results.push({ keyword, box: { ...match.boundingBox } });
    } else {
      // Multi-word keyword — find consecutive OCR words nearby and merge boxes
      let found = false;
      for (let i = 0; i <= words.length - kwParts.length && !found; i++) {
        let allMatch = true;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

        for (let j = 0; j < kwParts.length; j++) {
          const ocrNorm = normalize(words[i + j].text);
          const kwNorm = normalize(kwParts[j]);
          if (!ocrNorm.includes(kwNorm) && !kwNorm.includes(ocrNorm)) {
            allMatch = false;
            break;
          }
          const bb = words[i + j].boundingBox;
          minX = Math.min(minX, bb.x);
          minY = Math.min(minY, bb.y);
          maxX = Math.max(maxX, bb.x + bb.width);
          maxY = Math.max(maxY, bb.y + bb.height);
        }

        if (allMatch) {
          results.push({ keyword, box: { x: minX, y: minY, width: maxX - minX, height: maxY - minY } });
          found = true;
        }
      }
    }
  }

  return results;
}
