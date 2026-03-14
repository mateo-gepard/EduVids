import fs from 'fs/promises';
import path from 'path';
import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import type { ImageResult } from '../core/types.js';

const log = createLogger({ service: 'image-search' });

const GOOGLE_SEARCH_URL = 'https://www.googleapis.com/customsearch/v1';

/**
 * Search Google Images for educational content images.
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

  if (!config.googleSearchKey || !config.googleSearchCx) {
    throw new Error('Google Custom Search API key or CX not configured');
  }

  const params = new URLSearchParams({
    key: config.googleSearchKey,
    cx: config.googleSearchCx,
    q: query,
    searchType: 'image',
    num: String(Math.min(count, 10)),
    imgSize: 'large',
    safe: 'active',
    rights: 'cc_publicdomain|cc_attribute', // prefer open-license images
  });

  log.info({ query, count }, 'Searching Google Images');

  const response = await fetch(`${GOOGLE_SEARCH_URL}?${params}`);
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Google Image Search error ${response.status}: ${error}`);
  }

  const data = await response.json();

  return (data.items || []).map((item: any) => ({
    url: item.link,
    title: item.title,
    thumbnailUrl: item.image?.thumbnailLink || item.link,
    width: item.image?.width || 800,
    height: item.image?.height || 600,
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
