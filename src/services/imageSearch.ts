import fs from 'fs/promises';
import path from 'path';
import { createCanvas } from 'canvas';
import { config } from '../core/config.js';
import { createLogger } from '../core/logger.js';
import type { ImageResult } from '../core/types.js';

const log = createLogger({ service: 'image-search' });

const PIXABAY_API_URL = 'https://pixabay.com/api/';
const PEXELS_API_URL = 'https://api.pexels.com/v1/search';
const BING_IMAGE_URL = 'https://api.bing.microsoft.com/v7.0/images/search';
const WIKIMEDIA_API_URL = 'https://commons.wikimedia.org/w/api.php';

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

  // Scenic multi-stop gradient background (looks good under Ken Burns zoom)
  const gradient = ctx.createLinearGradient(0, 0, width, height);
  gradient.addColorStop(0, '#0f2027');
  gradient.addColorStop(0.3, '#203a43');
  gradient.addColorStop(0.6, '#2c5364');
  gradient.addColorStop(1, '#1b3a4b');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, width, height);

  // Soft ambient glows for depth
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = '#4ecdc4';
  ctx.beginPath();
  ctx.arc(width * 0.75, height * 0.25, 350, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#556270';
  ctx.beginPath();
  ctx.arc(width * 0.2, height * 0.75, 280, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#c7ecee';
  ctx.beginPath();
  ctx.arc(width * 0.5, height * 0.5, 220, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  // Subtle diagonal lines for texture
  ctx.save();
  ctx.globalAlpha = 0.03;
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 1;
  for (let i = -height; i < width + height; i += 60) {
    ctx.beginPath();
    ctx.moveTo(i, 0);
    ctx.lineTo(i + height, height);
    ctx.stroke();
  }
  ctx.restore();

  // No query text — keep it clean and photographic for Ken Burns

  await fs.mkdir(outputDir, { recursive: true });
  const outPath = path.join(outputDir, `${filename}.png`);
  const buffer = canvas.toBuffer('image/png');
  await fs.writeFile(outPath, buffer);
  return outPath;
}

/**
 * Search for images across multiple providers.
 * Default order: Pexels → Pixabay → Bing → Wikimedia.
 * With preferDiagram: Wikimedia → Bing → Pexels → Pixabay (better for labeled diagrams).
 */
export async function searchImages(
  query: string,
  count: number = 5,
  options: { preferDiagram?: boolean } = {}
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

  // Try providers in priority order — diagram mode prefers Wikimedia/Bing
  const providers: Array<{ name: string; fn: () => Promise<ImageResult[]> }> = [];

  if (options.preferDiagram) {
    // Diagram mode: Wikimedia (labeled diagrams) → Bing → Pexels → Pixabay
    providers.push({ name: 'Wikimedia', fn: () => searchWikimedia(query, count) });
    if (config.bingSearchKey) {
      providers.push({ name: 'Bing', fn: () => searchBing(query, count) });
    }
    if (config.pexelsApiKey) {
      providers.push({ name: 'Pexels', fn: () => searchPexels(query, count) });
    }
    if (config.pixabayApiKey) {
      providers.push({ name: 'Pixabay', fn: () => searchPixabay(query, count) });
    }
  } else {
    // Default: Pexels (high quality photos) → Pixabay → Bing → Wikimedia
    if (config.pexelsApiKey) {
      providers.push({ name: 'Pexels', fn: () => searchPexels(query, count) });
    }
    if (config.pixabayApiKey) {
      providers.push({ name: 'Pixabay', fn: () => searchPixabay(query, count) });
    }
    if (config.bingSearchKey) {
      providers.push({ name: 'Bing', fn: () => searchBing(query, count) });
    }
    providers.push({ name: 'Wikimedia', fn: () => searchWikimedia(query, count) });
  }

  for (const provider of providers) {
    try {
      const results = await provider.fn();
      if (results.length > 0) {
        log.info({ provider: provider.name, query, count: results.length }, 'Image search succeeded');
        return results;
      }
      log.info({ provider: provider.name, query }, 'No results, trying next provider');
    } catch (err) {
      log.warn({ provider: provider.name, error: (err as Error).message }, 'Provider failed, trying next');
    }
  }

  log.warn({ query }, 'All image providers returned no results');
  return [];
}

/**
 * Search Pexels for high-quality stock photos (free, 200 req/hour).
 */
async function searchPexels(query: string, count: number): Promise<ImageResult[]> {
  const params = new URLSearchParams({
    query,
    per_page: String(Math.min(count, 15)),
    size: 'large',
  });

  log.info({ query, count }, 'Searching Pexels for images');

  const response = await fetch(`${PEXELS_API_URL}?${params}`, {
    headers: { Authorization: config.pexelsApiKey },
  });

  if (!response.ok) {
    log.error({ status: response.status }, 'Pexels search failed');
    return [];
  }

  const data = await response.json() as {
    photos: Array<{
      src: { large2x: string; medium: string };
      alt: string;
      width: number;
      height: number;
    }>;
  };

  return (data.photos || []).map((photo) => ({
    url: photo.src.large2x,
    title: photo.alt || query,
    thumbnailUrl: photo.src.medium,
    width: photo.width || 1920,
    height: photo.height || 1080,
  }));
}

/**
 * Search Pixabay for educational content images (free, 100 req/min).
 */
async function searchPixabay(query: string, count: number): Promise<ImageResult[]> {
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
    log.error({ status: response.status }, 'Pixabay search failed');
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
 * Search Bing for images (good for diagrams/infographics, needs Azure key).
 */
async function searchBing(query: string, count: number): Promise<ImageResult[]> {
  const params = new URLSearchParams({
    q: query,
    count: String(Math.min(count, 15)),
    safeSearch: 'Strict',
    imageType: 'Photo',
  });

  log.info({ query, count }, 'Searching Bing for images');

  const response = await fetch(`${BING_IMAGE_URL}?${params}`, {
    headers: { 'Ocp-Apim-Subscription-Key': config.bingSearchKey },
  });

  if (!response.ok) {
    log.error({ status: response.status }, 'Bing search failed');
    return [];
  }

  const data = await response.json() as {
    value?: Array<{
      contentUrl: string;
      name: string;
      thumbnailUrl: string;
      width: number;
      height: number;
    }>;
  };

  return (data.value || [])
    .filter(img => img.width >= 800 && img.height >= 500)
    .map((img) => ({
      url: img.contentUrl,
      title: img.name,
      thumbnailUrl: img.thumbnailUrl,
      width: img.width,
      height: img.height,
    }));
}

/**
 * Search Wikimedia Commons for free educational images (no API key needed).
 * Uses the MediaWiki API to search for images in the File namespace.
 */
async function searchWikimedia(query: string, count: number): Promise<ImageResult[]> {
  // Step 1: Search for image file pages
  const searchParams = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: `${query} filetype:bitmap`,
    gsrnamespace: '6', // File namespace
    gsrlimit: String(Math.min(count * 2, 20)), // fetch extra to filter
    prop: 'imageinfo',
    iiprop: 'url|size|mime',
    iiurlwidth: '1920',
    format: 'json',
    origin: '*',
  });

  log.info({ query, count }, 'Searching Wikimedia Commons for images');

  const response = await fetch(`${WIKIMEDIA_API_URL}?${searchParams}`);
  if (!response.ok) {
    log.error({ status: response.status }, 'Wikimedia search failed');
    return [];
  }

  const data = await response.json() as {
    query?: {
      pages?: Record<string, {
        title: string;
        imageinfo?: Array<{
          url: string;
          thumburl?: string;
          width: number;
          height: number;
          mime: string;
        }>;
      }>;
    };
  };

  if (!data.query?.pages) return [];

  const results: ImageResult[] = [];
  for (const page of Object.values(data.query.pages)) {
    const info = page.imageinfo?.[0];
    if (!info) continue;
    // Only include actual images (not SVGs which don't work well with Ken Burns)
    if (!info.mime?.startsWith('image/') || info.mime === 'image/svg+xml') continue;
    // Skip tiny images
    if (info.width < 800 || info.height < 500) continue;

    results.push({
      url: info.thumburl || info.url,
      title: page.title.replace(/^File:/, '').replace(/\.[^.]+$/, ''),
      thumbnailUrl: info.thumburl || info.url,
      width: info.width,
      height: info.height,
    });

    if (results.length >= count) break;
  }

  return results;
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
