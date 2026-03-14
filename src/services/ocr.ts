import fs from 'fs/promises';
import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import type { OcrResult } from '../core/types.js';

const log = createLogger({ service: 'ocr' });

const VISION_URL = 'https://vision.googleapis.com/v1/images:annotate';

/**
 * Run OCR on an image using Google Cloud Vision API.
 * Returns detected text with bounding boxes.
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

  if (!config.googleVisionKey) {
    throw new Error('Google Cloud Vision API key not configured');
  }

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
