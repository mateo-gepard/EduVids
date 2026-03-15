import fs from 'fs/promises';
import pdf from 'pdf-parse';
import { generateText } from '../services/llm.js';
import { recognizeText } from '../services/ocr.js';
import { createLogger } from '../core/logger.js';
import type { ContentBlock, ProjectInput } from '../core/types.js';

const log = createLogger({ module: 'input-parser' });

/**
 * Parse any user input (text, PDF, image, or topic) into structured ContentBlocks.
 */
export async function parseInput(input: ProjectInput): Promise<ContentBlock[]> {
  // 1. PDF upload — use LLM to analyze student booklet content
  if (input.pdfPath) {
    log.info({ path: input.pdfPath }, 'Parsing PDF input');
    return parsePdf(input.pdfPath, input.params.language);
  }

  // 2. Image of handwritten notes
  if (input.imagePath) {
    log.info({ path: input.imagePath }, 'Parsing image input via OCR');
    return parseImage(input.imagePath);
  }

  // 3. Text or topic string
  if (input.text) {
    // Detect whether it's a topic (short) or content (long)
    if (input.text.length < 200) {
      log.info('Generating content from topic string via LLM');
      return generateFromTopic(input.text, input.params.language);
    }
    log.info('Parsing raw text input');
    return parseRawText(input.text);
  }

  throw new Error('No valid input provided. Provide text, a PDF, or an image.');
}

// ── Private parsers ──────────────────────────────────────────────────────────

async function parsePdf(filePath: string, language: string): Promise<ContentBlock[]> {
  const buffer = await fs.readFile(filePath);
  const data = await pdf(buffer);
  const rawText = data.text?.trim();

  if (!rawText || rawText.length < 20) {
    throw new Error('PDF contains too little text to generate a video.');
  }

  // For short PDFs (< 500 chars), treat as topic + notes
  if (rawText.length < 500) {
    log.info('Short PDF detected — treating as topic input');
    return generateFromTopic(rawText, language);
  }

  // Use LLM to analyze the student booklet / notes and produce structured educational content.
  // This extracts the core topic, key concepts, example questions, formulas, and quotes —
  // then rewrites them into video-ready content blocks.
  log.info({ chars: rawText.length, pages: data.numpages }, 'Analyzing PDF with LLM');

  // Truncate to ~12k chars to stay within token limits
  const excerpt = rawText.length > 12_000 ? rawText.slice(0, 12_000) + '\n[...]' : rawText;

  const isGerman = language === 'de';
  const prompt = isGerman
    ? `Du bist ein erfahrener Lehrer. Analysiere den folgenden Hefteintrag / Lernmaterial eines Schülers und erstelle daraus einen umfassenden, strukturierten Lerninhalt für ein Erklärvideo.

AUFGABE:
1. Identifiziere das Hauptthema und die Unterthemen
2. Extrahiere alle Schlüsselkonzepte und erkläre sie verständlich
3. Finde vorhandene Übungsaufgaben / Beispielaufgaben und integriere sie als Quiz-Fragen (markiere mit "QUIZ:")
4. Übernimm wichtige Formeln (in LaTeX-Notation)
5. Füge relevante Zitate ein (mit „" markiert)
6. Ergänze fehlende Zusammenhänge und Erklärungen, damit der Inhalt als eigenständige Lektion funktioniert

FORMAT: Verwende Markdown mit # Überschriften, Aufzählungslisten, Formeln ($...$), und klaren Absätzen.
Das Ergebnis soll genug Material für ein vollständiges Erklärvideo liefern.

SCHÜLER-MATERIAL:
${excerpt}`
    : `You are an experienced teacher. Analyze the following student booklet / study material and create a comprehensive, structured educational text for an explainer video.

TASK:
1. Identify the main topic and subtopics
2. Extract all key concepts and explain them clearly
3. Find existing practice questions / example problems and integrate them as quiz questions (mark with "QUIZ:")
4. Include important formulas (in LaTeX notation)
5. Include relevant quotes (with quotation marks)
6. Fill in missing context and explanations so the content works as a standalone lesson

FORMAT: Use Markdown with # headings, bullet lists, formulas ($...$), and clear paragraphs.
The result should provide enough material for a complete explainer video.

STUDENT MATERIAL:
${excerpt}`;

  const systemPrompt = isGerman
    ? 'Du bist ein erfahrener Lehrer, der aus Schülernotizen strukturierte Lerninhalte erstellt.'
    : 'You are an experienced teacher who creates structured educational content from student notes.';

  const analyzed = await generateText(prompt, {
    systemPrompt,
    temperature: 0.5,
    maxTokens: 4000,
  });

  log.info('PDF LLM analysis complete');
  return parseRawText(analyzed);
}

async function parseImage(imagePath: string): Promise<ContentBlock[]> {
  const ocrResult = await recognizeText(imagePath);
  if (!ocrResult.fullText) {
    throw new Error('OCR found no text in the uploaded image');
  }
  return parseRawText(ocrResult.fullText);
}

/**
 * Parse raw text into structured ContentBlocks by detecting patterns.
 */
function parseRawText(text: string): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);

  let currentParagraph: string[] = [];

  const flushParagraph = () => {
    if (currentParagraph.length > 0) {
      blocks.push({ type: 'paragraph', content: currentParagraph.join(' ') });
      currentParagraph = [];
    }
  };

  for (const line of lines) {
    // Heading detection (markdown-style or ALL CAPS or numbered)
    const headingMatch = line.match(/^(#{1,3})\s+(.+)/) ||
      (line === line.toUpperCase() && line.length > 3 && line.length < 100 ? [null, '#', line] : null) ||
      line.match(/^(\d+\.?\s+)([A-ZÄÖÜ].{5,})$/);

    if (headingMatch) {
      flushParagraph();
      const level = typeof headingMatch[1] === 'string' && headingMatch[1].startsWith('#')
        ? headingMatch[1].length
        : 2;
      blocks.push({ type: 'heading', content: headingMatch[2] || line, level });
      continue;
    }

    // Formula detection (LaTeX-like)
    if (line.match(/\\[a-z]+\{/) || line.match(/^\$.*\$$/)) {
      flushParagraph();
      blocks.push({ type: 'formula', content: line });
      continue;
    }

    // Quote detection
    if (line.startsWith('"') || line.startsWith('„') || line.startsWith('>')) {
      flushParagraph();
      blocks.push({ type: 'quote', content: line.replace(/^[">„"]\s*/, '') });
      continue;
    }

    // List detection
    if (line.match(/^[-•*]\s+/) || line.match(/^\d+[.)]\s+.{3,}/)) {
      if (blocks.length > 0 && blocks[blocks.length - 1].type === 'list') {
        blocks[blocks.length - 1].items!.push(line.replace(/^[-•*\d.)\s]+/, ''));
      } else {
        flushParagraph();
        blocks.push({
          type: 'list',
          content: '',
          items: [line.replace(/^[-•*\d.)\s]+/, '')],
        });
      }
      continue;
    }

    // Regular paragraph text
    currentParagraph.push(line);
  }

  flushParagraph();
  return blocks;
}

/**
 * Generate educational content from a short topic description via LLM.
 */
async function generateFromTopic(topic: string, language: string): Promise<ContentBlock[]> {
  const isGerman = language === 'de';

  const prompt = isGerman
    ? `Du bist ein Experte für Bildungsinhalte. Erstelle einen umfassenden, strukturierten Überblick zum Thema:\n\n"${topic}"\n\nSchreibe den Inhalt auf Deutsch.\nStrukturiere den Text mit klaren Überschriften (mit # Markdown-Syntax), Absätzen, relevanten Formeln (in LaTeX), wichtigen Zitaten, und Aufzählungslisten.\nDer Text sollte genug Material für ein 5-10 Minuten Erklärvideo liefern.\nFüge am Ende 3-5 Quiz-Fragen mit Antworten hinzu, markiert mit "QUIZ:".`
    : `You are an expert in educational content. Create a comprehensive, structured overview of the topic:\n\n"${topic}"\n\nWrite the content in English.\nStructure the text with clear headings (using # Markdown syntax), paragraphs, relevant formulas (in LaTeX), important quotes, and bullet lists.\nThe text should provide enough material for a 5-10 minute explainer video.\nAdd 3-5 quiz questions with answers at the end, marked with "QUIZ:".`;

  const systemPrompt = isGerman
    ? 'Du bist ein erfahrener Lehrer und Bildungscontent-Ersteller.'
    : 'You are an experienced teacher and educational content creator.';

  const generatedText = await generateText(prompt, {
    systemPrompt,
    temperature: 0.7,
    maxTokens: 4000,
  });

  return parseRawText(generatedText);
}
