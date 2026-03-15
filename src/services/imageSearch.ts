import fs from 'fs/promises';
import path from 'path';
import { createCanvas } from 'canvas';
import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import type { ImageResult } from '../core/types.js';

const log = createLogger({ service: 'image-search' });

const PIXABAY_API_URL = 'https://pixabay.com/api/';

/**
 * Generate a canvas-based placeholder image when no image search API is available.
 * Returns a visually consistent gradient image with the query text.
 */
export async function generatePlaceholderImage(
  query: string,
  outputDir: string,
  filename: string
): Promise<string> {
  const width = 1920;
  const height = 1080;
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  // Dark gradient background
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#1a1a2e');
  gradient.addColorStop(0.5, '#16213e');
  gradient.addColorStop(1, '#0f3460');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Subtle decorative circles
  ctx.globalAlpha = 0.08;
  ctx.fillStyle = '#e94560';
  ctx.beginPath();
  ctx.arc(width * 0.8, height * 0.3, 200, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#533483';
  ctx.beginPath();
  ctx.arc(width * 0.2, height * 0.7, 150, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Query text centered
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 48px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Wrap text if too long
  const words = query.split(' ');
  const lines: string[] = [];
  let currentLine = '';
  for (const word of words) {
    const testLine = currentLine ? `${currentLine} ${word}` : word;
    if (ctx.measureText(testLine).width > width * 0.7) {
      lines.push(currentLine);
      currentLine = word;
    } else {
      currentLine = testLine;
    }
  }
  if (currentLine) lines.push(currentLine);

  const lineHeight = 60;
  const startY = height / 2 - ((lines.length - 1) * lineHeight) / 2;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], width / 2, startY + i * lineHeight);
  }

  await fs.mkdir(outputDir, { recursive: true });
  const outPath = path.join(outputDir, `${filename}.png`);
  const buffer = canvas.toBuffer('image/png');
  await fs.writeFile(outPath, buffer);
  return outPath;
}

/**
 * Search Pixabay for educational content images (free, 100 req/min).
 * Falls back to empty results when no API key is configured.
 */
export async function searchImages(
  query: string,
  count: number = 5
): Promise<ImageResult[]> {
  if (config.mockMode) {
    log.info({ query }, 'Mock mode: returning placeholder images');
    return Array.from({ length: count }, (_, i) => ({
      url: `https://via.placeholder.com/800x600?text=${encodeURIComponent(query)}+${i + 1}`,
      title: `${query} - Image ${i + 1}`,
      thumbnailUrl: `https://via.placeholder.com/200x150?text=${i + 1}`,
      width: 800,
      height: 600,
    }));
  }

  if (!config.pixabayApiKey) {
    log.warn({ query }, 'PIXABAY_API_KEY not set — returning empty results (placeholder images will be generated)');
    return [];
  }

  const params = new URLSearchParams({
    key: config.pixabayApiKey,
    q: query,
    image_type: 'photo',
    safesearch: 'true',
    per_page: String(Math.min(count, 20)),
    lang: 'en',
    min_width: '800',
  });

  log.info({ query, count }, 'Searching Pixabay for images');

  const response = await fetch(`${PIXABAY_API_URL}?${params}`);
  if (!response.ok) {
    log.error({ status: response.status }, 'Pixabay search failed — returning empty results');
    return [];
  }

  const data = await response.json() as {
    hits: Array<{
      largeImageURL: string;
      webformatURL: string;
      tags: string;
      imageWidth: number;
      imageHeight: number;
    }>;
  };

  return (data.hits || []).map((hit) => ({
    url: hit.largeImageURL,
    title: hit.tags,
    thumbnailUrl: hit.webformatURL,
    width: hit.imageWidth || 800,
    height: hit.imageHeight || 600,
  }));
}

/**
 * Download an image to a local path.
 */
export async function downloadImage(
  url: string,
  outputDir: string,
  filename: string
): Promise<string> {
  await fs.mkdir(outputDir, { recursive: true });
  const ext = path.extname(new URL(url).pathname) || '.jpg';
  const outPath = path.join(outputDir, `${filename}${ext}`);

  if (config.mockMode) {
    await fs.writeFile(outPath, Buffer.alloc(1024));
    return outPath;
  }

  log.info({ url, outPath }, 'Downloading image');
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Image download failed: ${response.status}`);

  const buffer = Buffer.from(await response.arrayBuffer());
  await fs.writeFile(outPath, buffer);
  return outPath;
}
