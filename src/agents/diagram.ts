// ═══════════════════════════════════════════════════════════════════════════
// EduVid AI — Diagram Agent v1
// Programmatic animated diagrams: flowcharts, mind maps, Venn, Gantt,
// org charts, cycle, fishbone, pyramid, tree, scatter, swimlane, DFD
// ═══════════════════════════════════════════════════════════════════════════

import { BaseAgent } from './base.js';
import {
  drawBackground, drawText, drawRoundedRect, drawCard,
  drawSceneTypeBadge, drawSegmentIndicator, drawConnectorArrow,
  type RenderContext,
} from '../rendering/renderer.js';
import {
  fontString, colors, layout, CANVAS_WIDTH, CANVAS_HEIGHT,
  sceneColors,
} from '../rendering/designSystem.js';
import { easing } from '../rendering/animations.js';
import { getActiveSegment, findSegmentsByCuePrefix } from '../rendering/narrationSegmenter.js';
import type { CueKeyword } from '../rendering/sttSync.js';
import type { SubAgentInput, SubAgentOutput, SceneType, NarrationSegment } from '../core/types.js';

// ── Diagram types ────────────────────────────────────────────────────────────

type DiagramKind =
  | 'flowchart' | 'swimlane' | 'dfd' | 'org-chart'
  | 'mind-map' | 'tree' | 'venn' | 'gantt'
  | 'scatter' | 'line-graph' | 'cycle' | 'fishbone' | 'pyramid';

// ── LLM Plan shapes ─────────────────────────────────────────────────────────

interface DiagramPlan {
  script: string;
  title: string;
  diagramType: DiagramKind;
  /** Each element is one visual item revealed in order */
  elements: DiagramElement[];
}

interface DiagramElement {
  id: string;
  label: string;
  /** For hierarchy/tree: parent id */
  parent?: string;
  /** Trigger phrase in the narration */
  triggerPhrase: string;
  /** Extra data depending on type */
  value?: number;
  group?: string;
  from?: string;
  to?: string;
  color?: string;
}

// ── Accent palette for diagram elements ──────────────────────────────────────

const PALETTE = [
  '#2563EB', '#16A34A', '#EA580C', '#7C3AED',
  '#D97706', '#0D9488', '#DC2626', '#4F46E5',
  '#0891B2', '#9333EA', '#C026D3', '#059669',
];

function pal(i: number): string { return PALETTE[i % PALETTE.length]; }
function palLight(i: number): string {
  const lights = [
    '#DBEAFE', '#DCFCE7', '#FFEDD5', '#EDE9FE',
    '#FEF3C7', '#CCFBF1', '#FEE2E2', '#E0E7FF',
    '#CFFAFE', '#F3E8FF', '#FCE7F3', '#D1FAE5',
  ];
  return lights[i % lights.length];
}

export class DiagramAgent extends BaseAgent {
  readonly type: SceneType = 'diagram';

  async execute(input: SubAgentInput): Promise<SubAgentOutput> {
    this.log.info({ scene: input.sceneSpec.title }, 'Starting diagram agent v1');

    // ── Step 1: LLM generates the diagram plan ──
    const directed = this.getDirectedScript(input);
    let plan = await this.generateDiagramPlan(input, undefined, directed);
    if (!plan.elements || plan.elements.length === 0) {
      throw new Error('Diagram plan has no elements');
    }
    this.log.info(
      { diagramType: plan.diagramType, elements: plan.elements.length },
      'Diagram plan generated'
    );

    // ── Step 2: TTS with duration-aware retry ──
    let audio: any;
    let finalScript: string;
    if (directed) {
      audio = await this.synthesizeSpeech(directed, input.workDir, 'diagram_audio', input.voiceId);
      finalScript = directed;
    } else {
      const result = await this.synthesizeSpeechForBudget(
        plan.script, input.sceneSpec.timeBudget, input.workDir, 'diagram_audio',
        async (targetWords) => {
          const replan = await this.generateDiagramPlan(input, targetWords);
          plan = replan;
          return replan.script;
        },
        input.voiceId,
      );
      audio = result.audio;
      finalScript = result.script;
    }
    plan.script = finalScript;
    const duration = audio.durationSeconds;

    // ── Step 3: STT-synced segmentation ──
    const cueKeywords: CueKeyword[] = [
      { visualCue: 'diagram_title', triggerPhrase: plan.title },
      ...plan.elements.map((el, i) => ({
        visualCue: `diagram_el:${i}`,
        triggerPhrase: el.triggerPhrase || el.label,
      })),
      { visualCue: 'fade_out', triggerPhrase: plan.script.split('.').pop()?.trim().split(' ').slice(0, 3).join(' ') || 'end' },
    ];
    const { segments } = await this.segmentScriptWithSTT(plan.script, audio.filePath, duration, cueKeywords);
    const timeline = this.buildTimelineFromSegments(segments, duration);

    // ── Step 4: Render diagram ──
    const capturedPlan = plan;
    const videoPath = await this.renderScene('diagram', duration, input.workDir, audio.filePath,
      (rc, anim) => {
        const globalAlpha = anim.opacity ?? 1;
        rc.ctx.save();
        rc.ctx.globalAlpha = globalAlpha;
        this.renderDiagram(rc, capturedPlan, segments);
        rc.ctx.restore();

        drawSceneTypeBadge(rc, '📊 Diagram');
        const { index, progress } = getActiveSegment(segments, rc.time);
        drawSegmentIndicator(rc, rc.height - 20, segments.length, index, progress);
      },
      timeline
    );

    return {
      sceneId: input.sceneSpec.id,
      sceneType: 'diagram',
      audio,
      visuals: [{ type: 'video', filePath: videoPath, durationSeconds: duration }],
      script: plan.script,
      durationSeconds: duration,
      segments,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Diagram Rendering Dispatcher
  // ═══════════════════════════════════════════════════════════════════════════

  private renderDiagram(
    rc: RenderContext,
    plan: DiagramPlan,
    segments: NarrationSegment[],
  ): void {
    drawBackground(rc);

    // Title
    const titleSeg = segments.find(s => s.visualCue === 'diagram_title');
    const titleVisible = titleSeg ? rc.time >= titleSeg.estimatedStart : rc.time > 0.5;
    if (titleVisible) {
      const titleAlpha = titleSeg
        ? Math.min(1, (rc.time - titleSeg.estimatedStart) / 0.6)
        : 1;
      rc.ctx.save();
      rc.ctx.globalAlpha = titleAlpha;
      drawText(rc, plan.title, layout.center.x, layout.margin.y, {
        font: fontString('heading', 'sm'),
        color: colors.text.primary,
        align: 'center',
        maxWidth: layout.contentWidth,
      });
      rc.ctx.restore();
    }

    // Get revealed element count for animation
    const revealedCount = this.getRevealedCount(plan.elements, segments, rc.time);

    switch (plan.diagramType) {
      case 'flowchart':
      case 'dfd':
        this.renderFlowchart(rc, plan, segments, revealedCount);
        break;
      case 'swimlane':
        this.renderSwimlane(rc, plan, segments, revealedCount);
        break;
      case 'org-chart':
      case 'tree':
        this.renderTree(rc, plan, segments, revealedCount);
        break;
      case 'mind-map':
        this.renderMindMap(rc, plan, segments, revealedCount);
        break;
      case 'venn':
        this.renderVenn(rc, plan, segments, revealedCount);
        break;
      case 'gantt':
        this.renderGantt(rc, plan, segments, revealedCount);
        break;
      case 'scatter':
      case 'line-graph':
        this.renderScatterOrLine(rc, plan, segments, revealedCount);
        break;
      case 'cycle':
        this.renderCycle(rc, plan, segments, revealedCount);
        break;
      case 'fishbone':
        this.renderFishbone(rc, plan, segments, revealedCount);
        break;
      case 'pyramid':
        this.renderPyramid(rc, plan, segments, revealedCount);
        break;
      default:
        // Fallback: card grid
        this.renderCardGrid(rc, plan, segments, revealedCount);
    }
  }

  /** How many elements are revealed at time t */
  private getRevealedCount(
    elements: DiagramElement[],
    segments: NarrationSegment[],
    time: number,
  ): number {
    let count = 0;
    for (let i = 0; i < elements.length; i++) {
      const seg = segments.find(s => s.visualCue === `diagram_el:${i}`);
      if (seg && time >= seg.estimatedStart) count++;
    }
    return count;
  }

  /** Ease-in factor for element i at time t (0→1 over 0.6s) */
  private elAlpha(i: number, segments: NarrationSegment[], time: number): number {
    const seg = segments.find(s => s.visualCue === `diagram_el:${i}`);
    if (!seg) return 0;
    const t = time - seg.estimatedStart;
    if (t < 0) return 0;
    return Math.min(1, t / 0.6);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Flowchart / DFD
  // ═══════════════════════════════════════════════════════════════════════════

  private renderFlowchart(
    rc: RenderContext, plan: DiagramPlan,
    segments: NarrationSegment[], revealedCount: number,
  ): void {
    const { ctx } = rc;
    const els = plan.elements;
    const n = els.length;
    if (n === 0) return;

    // Layout: vertical flow with 2 columns for many items
    const startY = layout.margin.y + 80;
    const availH = rc.height - startY - layout.margin.y - 40;
    const useCols = n > 5;
    const cols = useCols ? 2 : 1;
    const perCol = Math.ceil(n / cols);
    const boxW = useCols ? 340 : 520;
    const boxH = Math.min(80, Math.floor(availH / perCol) - 40);
    const gapY = boxH + 40;
    const colW = rc.width / (cols + 1);

    for (let i = 0; i < n; i++) {
      const alpha = this.elAlpha(i, segments, rc.time);
      if (alpha <= 0) continue;

      const col = useCols ? Math.floor(i / perCol) : 0;
      const row = useCols ? i % perCol : i;
      const cx = colW * (col + 1);
      const cy = startY + row * gapY;

      ctx.save();
      ctx.globalAlpha = alpha;

      // Decision diamond for elements containing "?" or "if"
      const isDecision = /\?|if |whether/i.test(els[i].label);

      if (isDecision) {
        // Diamond shape
        ctx.save();
        ctx.translate(cx, cy + boxH / 2);
        ctx.rotate(Math.PI / 4);
        const dSize = boxH * 0.5;
        drawRoundedRect(ctx, -dSize, -dSize, dSize * 2, dSize * 2, 6, pal(i));
        ctx.fillStyle = pal(i);
        ctx.fill();
        ctx.restore();
        // Label
        drawText(rc, els[i].label, cx, cy + boxH / 2 - 12, {
          font: fontString('bold', 'xs'),
          color: '#FFFFFF',
          align: 'center',
          maxWidth: boxW - 40,
        });
      } else {
        // Rounded box
        const x = cx - boxW / 2;
        drawCard(rc, x, cy, boxW, boxH, {
          fill: palLight(i),
          borderColor: pal(i),
          radius: 12,
        });
        // Colored left accent
        ctx.fillStyle = pal(i);
        drawRoundedRect(ctx, x, cy, 6, boxH, 3, pal(i));
        // Label
        drawText(rc, els[i].label, cx, cy + (boxH - 24) / 2, {
          font: fontString('bold', 'xs'),
          color: colors.text.primary,
          align: 'center',
          maxWidth: boxW - 30,
        });
      }

      // Connector arrow to next in same column
      const nextInCol = useCols ? i + 1 : i + 1;
      if (nextInCol < n && this.elAlpha(nextInCol, segments, rc.time) > 0) {
        const nextCol = useCols ? Math.floor(nextInCol / perCol) : 0;
        const nextRow = useCols ? nextInCol % perCol : nextInCol;
        if (nextCol === col) {
          const nextCy = startY + nextRow * gapY;
          drawConnectorArrow(rc, cx, cy + boxH + 4, cx, nextCy - 4, 1, {
            color: pal(i), lineWidth: 2,
          });
        }
      }

      ctx.restore();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Swimlane
  // ═══════════════════════════════════════════════════════════════════════════

  private renderSwimlane(
    rc: RenderContext, plan: DiagramPlan,
    segments: NarrationSegment[], revealedCount: number,
  ): void {
    const { ctx } = rc;
    const els = plan.elements;
    // Group by group name (lane)
    const lanes = new Map<string, DiagramElement[]>();
    for (const el of els) {
      const lane = el.group || 'Default';
      if (!lanes.has(lane)) lanes.set(lane, []);
      lanes.get(lane)!.push(el);
    }
    const laneNames = [...lanes.keys()];
    const nLanes = Math.max(laneNames.length, 1);

    const startY = layout.margin.y + 80;
    const laneW = (layout.contentWidth) / nLanes;
    const laneH = rc.height - startY - layout.margin.y - 40;
    const boxW = laneW - 50;
    const boxH = 60;

    // Draw lane headers + vertical dividers
    for (let li = 0; li < nLanes; li++) {
      const lx = layout.margin.x + li * laneW;

      // Lane background
      ctx.fillStyle = li % 2 === 0 ? 'rgba(37,99,235,0.03)' : 'rgba(22,163,74,0.03)';
      ctx.fillRect(lx, startY, laneW, laneH);

      // Lane header
      ctx.fillStyle = pal(li);
      drawRoundedRect(ctx, lx + 4, startY, laneW - 8, 40, 8, pal(li));
      drawText(rc, laneNames[li], lx + laneW / 2, startY + 8, {
        font: fontString('bold', 'xs'),
        color: '#FFFFFF',
        align: 'center',
        maxWidth: laneW - 20,
      });

      // Vertical divider
      if (li > 0) {
        ctx.strokeStyle = colors.bg.muted;
        ctx.lineWidth = 1;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(lx, startY);
        ctx.lineTo(lx, startY + laneH);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    // Draw elements within their lanes
    const laneIdx = new Map<string, number>();
    laneNames.forEach((name, i) => laneIdx.set(name, i));

    const elGlobalIdx = new Map<string, number>();
    els.forEach((el, i) => elGlobalIdx.set(el.id, i));

    for (let i = 0; i < els.length; i++) {
      const alpha = this.elAlpha(i, segments, rc.time);
      if (alpha <= 0) continue;

      const el = els[i];
      const li = laneIdx.get(el.group || 'Default') ?? 0;
      const laneEls = lanes.get(el.group || 'Default')!;
      const rowInLane = laneEls.indexOf(el);

      const lx = layout.margin.x + li * laneW;
      const cx = lx + laneW / 2;
      const cy = startY + 55 + rowInLane * (boxH + 20);

      ctx.save();
      ctx.globalAlpha = alpha;

      drawCard(rc, cx - boxW / 2, cy, boxW, boxH, {
        fill: palLight(i),
        borderColor: pal(i),
        radius: 10,
      });
      drawText(rc, el.label, cx, cy + (boxH - 22) / 2, {
        font: fontString('body', 'xs'),
        color: colors.text.primary,
        align: 'center',
        maxWidth: boxW - 20,
      });

      ctx.restore();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Tree / Org Chart
  // ═══════════════════════════════════════════════════════════════════════════

  private renderTree(
    rc: RenderContext, plan: DiagramPlan,
    segments: NarrationSegment[], revealedCount: number,
  ): void {
    const { ctx } = rc;
    const els = plan.elements;

    // Build parent → children map
    const childrenOf = new Map<string, DiagramElement[]>();
    const roots: DiagramElement[] = [];
    for (const el of els) {
      if (!el.parent) {
        roots.push(el);
      } else {
        if (!childrenOf.has(el.parent)) childrenOf.set(el.parent, []);
        childrenOf.get(el.parent)!.push(el);
      }
    }

    // BFS to compute positions
    interface NodePos { el: DiagramElement; x: number; y: number; depth: number; globalIdx: number }
    const positions: NodePos[] = [];
    const startY = layout.margin.y + 90;
    const levelH = 120;
    const idxMap = new Map<string, number>();
    els.forEach((el, i) => idxMap.set(el.id, i));

    // Count nodes at each depth for centering
    const depthNodes = new Map<number, DiagramElement[]>();
    const assignDepth = (node: DiagramElement, depth: number) => {
      if (!depthNodes.has(depth)) depthNodes.set(depth, []);
      depthNodes.get(depth)!.push(node);
      for (const child of childrenOf.get(node.id) || []) assignDepth(child, depth + 1);
    };
    for (const root of roots) assignDepth(root, 0);

    // Assign x positions: evenly space within each depth
    for (const [depth, nodes] of depthNodes) {
      const count = nodes.length;
      const spacing = layout.contentWidth / (count + 1);
      nodes.forEach((node, i) => {
        positions.push({
          el: node,
          x: layout.margin.x + spacing * (i + 1),
          y: startY + depth * levelH,
          depth,
          globalIdx: idxMap.get(node.id) ?? 0,
        });
      });
    }

    // Draw connectors first (below nodes)
    const posMap = new Map<string, NodePos>();
    for (const p of positions) posMap.set(p.el.id, p);

    for (const p of positions) {
      const parentAlpha = this.elAlpha(p.globalIdx, segments, rc.time);
      if (parentAlpha <= 0) continue;
      for (const child of childrenOf.get(p.el.id) || []) {
        const cp = posMap.get(child.id);
        if (!cp) continue;
        const childAlpha = this.elAlpha(cp.globalIdx, segments, rc.time);
        if (childAlpha <= 0) continue;
        drawConnectorArrow(rc, p.x, p.y + 44, cp.x, cp.y - 4, childAlpha, {
          color: pal(p.depth), lineWidth: 2, curvature: 0,
        });
      }
    }

    // Draw nodes
    const boxW = Math.min(280, layout.contentWidth / (Math.max(...[...depthNodes.values()].map(n => n.length)) + 1) - 20);
    const boxH = 44;

    for (const p of positions) {
      const alpha = this.elAlpha(p.globalIdx, segments, rc.time);
      if (alpha <= 0) continue;

      ctx.save();
      ctx.globalAlpha = alpha;

      const scale = 0.8 + alpha * 0.2;
      ctx.translate(p.x, p.y + boxH / 2);
      ctx.scale(scale, scale);
      ctx.translate(-p.x, -(p.y + boxH / 2));

      drawCard(rc, p.x - boxW / 2, p.y, boxW, boxH, {
        fill: p.depth === 0 ? pal(p.globalIdx) : palLight(p.globalIdx),
        borderColor: pal(p.globalIdx),
        radius: p.depth === 0 ? 22 : 10,
      });
      drawText(rc, p.el.label, p.x, p.y + (boxH - 22) / 2, {
        font: fontString(p.depth === 0 ? 'bold' : 'body', 'xs'),
        color: p.depth === 0 ? '#FFFFFF' : colors.text.primary,
        align: 'center',
        maxWidth: boxW - 20,
      });

      ctx.restore();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Mind Map
  // ═══════════════════════════════════════════════════════════════════════════

  private renderMindMap(
    rc: RenderContext, plan: DiagramPlan,
    segments: NarrationSegment[], revealedCount: number,
  ): void {
    const { ctx } = rc;
    const els = plan.elements;
    const cx = layout.center.x;
    const cy = layout.center.y + 20;
    const n = els.length;

    // First element is the central idea, rest are branches
    const centralLabel = els[0]?.label ?? plan.title;
    const branches = els.slice(1);

    // Central node — always visible once title segment starts
    const centralAlpha = this.elAlpha(0, segments, rc.time);
    if (centralAlpha > 0) {
      ctx.save();
      ctx.globalAlpha = centralAlpha;
      const r = 70;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = rc.scheme.accent;
      ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.08)';
      ctx.lineWidth = 2;
      ctx.stroke();
      drawText(rc, centralLabel, cx, cy - 14, {
        font: fontString('bold', 'xs'),
        color: '#FFFFFF',
        align: 'center',
        maxWidth: 120,
      });
      ctx.restore();
    }

    // Branch positions: radial
    const branchR = Math.min(320, rc.width / 3.2);
    for (let i = 0; i < branches.length; i++) {
      const globalIdx = i + 1;
      const alpha = this.elAlpha(globalIdx, segments, rc.time);
      if (alpha <= 0) continue;

      const angle = ((i / branches.length) * Math.PI * 2) - Math.PI / 2;
      const bx = cx + Math.cos(angle) * branchR;
      const by = cy + Math.sin(angle) * branchR;

      // Connector line
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = pal(i);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(bx, by);
      ctx.stroke();
      ctx.restore();

      // Branch bubble
      ctx.save();
      ctx.globalAlpha = alpha;
      const scale = 0.7 + alpha * 0.3;
      ctx.translate(bx, by);
      ctx.scale(scale, scale);

      const bw = Math.min(220, layout.contentWidth / (branches.length / 2 + 1));
      const bh = 52;
      drawCard(rc, -bw / 2, -bh / 2, bw, bh, {
        fill: palLight(i),
        borderColor: pal(i),
        radius: bh / 2,
      });
      drawText(rc, branches[i].label, 0, -10, {
        font: fontString('bold', 'xs'),
        color: pal(i),
        align: 'center',
        maxWidth: bw - 24,
      });

      ctx.restore();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Venn Diagram
  // ═══════════════════════════════════════════════════════════════════════════

  private renderVenn(
    rc: RenderContext, plan: DiagramPlan,
    segments: NarrationSegment[], revealedCount: number,
  ): void {
    const { ctx } = rc;
    const els = plan.elements;
    const cx = layout.center.x;
    const cy = layout.center.y + 20;

    // First 2–3 elements are the circles, rest are overlap descriptions
    const circleCount = Math.min(els.length, 3);
    const overlaps = els.slice(circleCount);
    const r = circleCount === 2 ? 220 : 180;
    const spread = r * 0.7;

    // Circle positions
    const circlePositions = circleCount === 2
      ? [{ x: cx - spread, y: cy }, { x: cx + spread, y: cy }]
      : [
          { x: cx, y: cy - spread * 0.7 },
          { x: cx - spread, y: cy + spread * 0.5 },
          { x: cx + spread, y: cy + spread * 0.5 },
        ];

    // Draw circles
    for (let i = 0; i < circleCount; i++) {
      const alpha = this.elAlpha(i, segments, rc.time);
      if (alpha <= 0) continue;

      const pos = circlePositions[i];
      ctx.save();
      ctx.globalAlpha = alpha * 0.2;
      ctx.fillStyle = pal(i);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r * (0.7 + alpha * 0.3), 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();

      // Circle border
      ctx.save();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = pal(i);
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();

      // Label outside ring
      const labelAngle = circleCount === 2
        ? (i === 0 ? Math.PI : 0)
        : ((i / circleCount) * Math.PI * 2 - Math.PI / 2);
      const lx = pos.x + Math.cos(labelAngle) * (r * 0.5);
      const ly = pos.y + Math.sin(labelAngle) * (r * 0.5);

      ctx.save();
      ctx.globalAlpha = alpha;
      drawText(rc, els[i].label, lx, ly - 12, {
        font: fontString('bold', 'sm'),
        color: pal(i),
        align: 'center',
        maxWidth: r,
      });
      ctx.restore();
    }

    // Draw overlap text in center
    for (let i = 0; i < overlaps.length; i++) {
      const globalIdx = circleCount + i;
      const alpha = this.elAlpha(globalIdx, segments, rc.time);
      if (alpha <= 0) continue;

      ctx.save();
      ctx.globalAlpha = alpha;
      drawText(rc, overlaps[i].label, cx, cy - 12 + i * 36, {
        font: fontString('bold', 'xs'),
        color: colors.text.primary,
        align: 'center',
        maxWidth: r,
      });
      ctx.restore();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Gantt Chart
  // ═══════════════════════════════════════════════════════════════════════════

  private renderGantt(
    rc: RenderContext, plan: DiagramPlan,
    segments: NarrationSegment[], revealedCount: number,
  ): void {
    const { ctx } = rc;
    const els = plan.elements;
    const n = els.length;

    const startY = layout.margin.y + 90;
    const labelW = 260;
    const chartX = layout.margin.x + labelW;
    const chartW = layout.contentWidth - labelW;
    const barH = Math.min(44, Math.floor((rc.height - startY - layout.margin.y - 40) / n) - 10);
    const gapY = barH + 10;

    // Determine time range from element values or use positions
    const maxVal = Math.max(...els.map(el => (el.value ?? 0)), n);

    // Grid lines
    ctx.strokeStyle = colors.bg.muted;
    ctx.lineWidth = 1;
    for (let g = 0; g <= 4; g++) {
      const gx = chartX + (g / 4) * chartW;
      ctx.beginPath();
      ctx.moveTo(gx, startY - 10);
      ctx.lineTo(gx, startY + n * gapY);
      ctx.stroke();
    }

    for (let i = 0; i < n; i++) {
      const alpha = this.elAlpha(i, segments, rc.time);
      if (alpha <= 0) continue;

      const y = startY + i * gapY;

      ctx.save();
      ctx.globalAlpha = alpha;

      // Row label
      drawText(rc, els[i].label, layout.margin.x, y + (barH - 22) / 2, {
        font: fontString('body', 'xs'),
        color: colors.text.primary,
        maxWidth: labelW - 20,
      });

      // Bar — use value for end position, or sequential
      const barStart = (i / n) * 0.3;
      const barEnd = barStart + Math.max(0.15, (els[i].value ?? (n - i)) / maxVal * 0.7);
      const bx = chartX + barStart * chartW;
      const bw = (barEnd - barStart) * chartW * alpha;

      drawRoundedRect(ctx, bx, y, bw, barH, 6, pal(i));
      ctx.fillStyle = pal(i);
      ctx.fill();

      // Value label on bar
      if (alpha > 0.5) {
        drawText(rc, els[i].value ? `${els[i].value}` : '', bx + bw - 10, y + (barH - 18) / 2, {
          font: fontString('label', 'md'),
          color: '#FFFFFF',
          align: 'right',
        });
      }

      ctx.restore();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Scatter Plot / Line Graph
  // ═══════════════════════════════════════════════════════════════════════════

  private renderScatterOrLine(
    rc: RenderContext, plan: DiagramPlan,
    segments: NarrationSegment[], revealedCount: number,
  ): void {
    const { ctx } = rc;
    const els = plan.elements;
    const isLine = plan.diagramType === 'line-graph';

    const chartX = layout.margin.x + 80;
    const chartY = layout.margin.y + 90;
    const chartW = layout.contentWidth - 120;
    const chartH = rc.height - chartY - layout.margin.y - 60;

    // Axes
    ctx.strokeStyle = colors.text.secondary;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(chartX, chartY);
    ctx.lineTo(chartX, chartY + chartH);
    ctx.lineTo(chartX + chartW, chartY + chartH);
    ctx.stroke();

    // Grid
    ctx.strokeStyle = colors.bg.muted;
    ctx.lineWidth = 1;
    for (let g = 1; g <= 4; g++) {
      const gy = chartY + chartH - (g / 4) * chartH;
      ctx.beginPath();
      ctx.moveTo(chartX, gy);
      ctx.lineTo(chartX + chartW, gy);
      ctx.stroke();
    }

    // Points
    const maxVal = Math.max(...els.map(el => el.value ?? 1), 1);
    const points: { x: number; y: number; alpha: number }[] = [];

    for (let i = 0; i < els.length; i++) {
      const alpha = this.elAlpha(i, segments, rc.time);
      const px = chartX + ((i + 0.5) / els.length) * chartW;
      const val = els[i].value ?? ((i + 1) / els.length) * maxVal;
      const py = chartY + chartH - (val / maxVal) * chartH * 0.85;
      points.push({ x: px, y: py, alpha });

      if (alpha <= 0) continue;

      ctx.save();
      ctx.globalAlpha = alpha;

      // Point dot
      ctx.fillStyle = pal(i);
      ctx.beginPath();
      ctx.arc(px, py, 8, 0, Math.PI * 2);
      ctx.fill();

      // Glow
      ctx.shadowColor = pal(i);
      ctx.shadowBlur = 12;
      ctx.beginPath();
      ctx.arc(px, py, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;

      // Label
      drawText(rc, els[i].label, px, py - 24, {
        font: fontString('label', 'md'),
        color: colors.text.primary,
        align: 'center',
        maxWidth: chartW / els.length - 10,
      });

      ctx.restore();
    }

    // Line connecting revealed points
    if (isLine && points.length > 1) {
      ctx.save();
      ctx.strokeStyle = rc.scheme.accent;
      ctx.lineWidth = 3;
      ctx.lineJoin = 'round';
      ctx.beginPath();
      let started = false;
      for (const pt of points) {
        if (pt.alpha <= 0) continue;
        ctx.globalAlpha = pt.alpha;
        if (!started) { ctx.moveTo(pt.x, pt.y); started = true; }
        else ctx.lineTo(pt.x, pt.y);
      }
      ctx.stroke();
      ctx.restore();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Cycle Diagram
  // ═══════════════════════════════════════════════════════════════════════════

  private renderCycle(
    rc: RenderContext, plan: DiagramPlan,
    segments: NarrationSegment[], revealedCount: number,
  ): void {
    const { ctx } = rc;
    const els = plan.elements;
    const n = els.length;
    const cx = layout.center.x;
    const cy = layout.center.y + 20;
    const R = Math.min(280, rc.width / 4);

    for (let i = 0; i < n; i++) {
      const alpha = this.elAlpha(i, segments, rc.time);
      if (alpha <= 0) continue;

      const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
      const nextAngle = ((i + 1) / n) * Math.PI * 2 - Math.PI / 2;
      const ex = cx + Math.cos(angle) * R;
      const ey = cy + Math.sin(angle) * R;

      ctx.save();
      ctx.globalAlpha = alpha;

      // Node circle
      const nodeR = 50;
      ctx.fillStyle = palLight(i);
      ctx.beginPath();
      ctx.arc(ex, ey, nodeR, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = pal(i);
      ctx.lineWidth = 3;
      ctx.stroke();

      // Number badge
      ctx.fillStyle = pal(i);
      ctx.beginPath();
      ctx.arc(ex - nodeR * 0.6, ey - nodeR * 0.6, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#FFFFFF';
      ctx.font = 'bold 14px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${i + 1}`, ex - nodeR * 0.6, ey - nodeR * 0.6);

      // Label
      drawText(rc, els[i].label, ex, ey - 10, {
        font: fontString('label', 'md'),
        color: colors.text.primary,
        align: 'center',
        maxWidth: nodeR * 2 - 10,
      });

      ctx.restore();

      // Arc arrow to next
      const nextAlpha = this.elAlpha((i + 1) % n, segments, rc.time);
      if (nextAlpha > 0 && alpha > 0.5) {
        const midAngle = (angle + nextAngle) / 2;
        const arcR = R * 0.75;
        const ax = cx + Math.cos(midAngle) * arcR;
        const ay = cy + Math.sin(midAngle) * arcR;
        const nx = cx + Math.cos(nextAngle) * R;
        const ny = cy + Math.sin(nextAngle) * R;

        ctx.save();
        ctx.globalAlpha = Math.min(alpha, nextAlpha) * 0.6;
        ctx.strokeStyle = pal(i);
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 4]);
        ctx.beginPath();
        ctx.moveTo(ex, ey);
        ctx.quadraticCurveTo(ax, ay, nx, ny);
        ctx.stroke();
        ctx.setLineDash([]);

        // Small arrowhead
        const aAngle = Math.atan2(ny - ay, nx - ax);
        ctx.fillStyle = pal(i);
        ctx.beginPath();
        ctx.moveTo(nx, ny);
        ctx.lineTo(nx - 10 * Math.cos(aAngle - 0.4), ny - 10 * Math.sin(aAngle - 0.4));
        ctx.lineTo(nx - 10 * Math.cos(aAngle + 0.4), ny - 10 * Math.sin(aAngle + 0.4));
        ctx.closePath();
        ctx.fill();

        ctx.restore();
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Fishbone / Ishikawa
  // ═══════════════════════════════════════════════════════════════════════════

  private renderFishbone(
    rc: RenderContext, plan: DiagramPlan,
    segments: NarrationSegment[], revealedCount: number,
  ): void {
    const { ctx } = rc;
    const els = plan.elements;
    const n = els.length;

    // Last element = effect (fish head), rest = causes (bones)
    const causes = els.slice(0, -1);
    const effect = els[n - 1] ?? { label: plan.title, id: 'effect' };

    const startY = layout.center.y;
    const spineX1 = layout.margin.x + 80;
    const spineX2 = rc.width - layout.margin.x - 80;

    // Spine line
    ctx.save();
    ctx.strokeStyle = rc.scheme.accent;
    ctx.lineWidth = 4;
    ctx.beginPath();
    ctx.moveTo(spineX1, startY);
    ctx.lineTo(spineX2, startY);
    ctx.stroke();
    ctx.restore();

    // Effect box (head)
    const effectAlpha = this.elAlpha(n - 1, segments, rc.time);
    if (effectAlpha > 0) {
      ctx.save();
      ctx.globalAlpha = effectAlpha;
      const headW = 200;
      const headH = 60;
      drawCard(rc, spineX2 - 10, startY - headH / 2, headW, headH, {
        fill: rc.scheme.accent,
        borderColor: rc.scheme.accent,
        radius: 12,
      });
      drawText(rc, effect.label, spineX2 + headW / 2 - 10, startY - 12, {
        font: fontString('bold', 'xs'),
        color: '#FFFFFF',
        align: 'center',
        maxWidth: headW - 20,
      });
      ctx.restore();
    }

    // Cause bones — alternating top/bottom
    const boneSpacing = (spineX2 - spineX1 - 100) / Math.max(causes.length, 1);
    for (let i = 0; i < causes.length; i++) {
      const alpha = this.elAlpha(i, segments, rc.time);
      if (alpha <= 0) continue;

      const bx = spineX1 + 50 + i * boneSpacing;
      const above = i % 2 === 0;
      const by = above ? startY - 120 : startY + 120;

      ctx.save();
      ctx.globalAlpha = alpha;

      // Bone line
      ctx.strokeStyle = pal(i);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(bx, startY);
      ctx.lineTo(bx, by);
      ctx.stroke();

      // Cause box
      const boxW = Math.min(180, boneSpacing - 10);
      const boxH = 44;
      drawCard(rc, bx - boxW / 2, by - (above ? boxH : 0), boxW, boxH, {
        fill: palLight(i),
        borderColor: pal(i),
        radius: 8,
      });
      drawText(rc, causes[i].label, bx, by - (above ? boxH / 2 + 10 : -boxH / 2 + 10), {
        font: fontString('label', 'md'),
        color: colors.text.primary,
        align: 'center',
        maxWidth: boxW - 16,
      });

      ctx.restore();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Pyramid
  // ═══════════════════════════════════════════════════════════════════════════

  private renderPyramid(
    rc: RenderContext, plan: DiagramPlan,
    segments: NarrationSegment[], revealedCount: number,
  ): void {
    const { ctx } = rc;
    const els = plan.elements;
    const n = els.length;

    const startY = layout.margin.y + 80;
    const baseW = layout.contentWidth * 0.8;
    const totalH = rc.height - startY - layout.margin.y - 40;
    const layerH = totalH / n;
    const cx = layout.center.x;

    for (let i = 0; i < n; i++) {
      const alpha = this.elAlpha(i, segments, rc.time);
      if (alpha <= 0) continue;

      // Pyramid layers: top is narrowest (index 0), bottom is widest
      const topFrac = i / n;
      const botFrac = (i + 1) / n;
      const topW = baseW * (1 - topFrac) * 0.8 + baseW * 0.15;
      const botW = baseW * (1 - botFrac) * 0.8 + baseW * 0.15;
      const y = startY + i * layerH;

      ctx.save();
      ctx.globalAlpha = alpha;

      // Trapezoid
      ctx.beginPath();
      ctx.moveTo(cx - topW / 2, y);
      ctx.lineTo(cx + topW / 2, y);
      ctx.lineTo(cx + botW / 2, y + layerH - 3);
      ctx.lineTo(cx - botW / 2, y + layerH - 3);
      ctx.closePath();
      ctx.fillStyle = pal(i);
      ctx.fill();

      // Subtle inner stroke
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Label centered in trapezoid
      drawText(rc, els[i].label, cx, y + (layerH - 22) / 2, {
        font: fontString('bold', 'xs'),
        color: '#FFFFFF',
        align: 'center',
        maxWidth: Math.min(topW, botW) - 30,
      });

      ctx.restore();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Fallback: Card Grid
  // ═══════════════════════════════════════════════════════════════════════════

  private renderCardGrid(
    rc: RenderContext, plan: DiagramPlan,
    segments: NarrationSegment[], revealedCount: number,
  ): void {
    const els = plan.elements;
    const startY = layout.margin.y + 80;
    const cols = els.length > 6 ? 3 : 2;
    const cardW = (layout.contentWidth - (cols - 1) * layout.gutter) / cols;
    const rows = Math.ceil(els.length / cols);
    const cardH = Math.min(100, Math.floor((rc.height - startY - layout.margin.y - 40) / rows) - 16);

    for (let i = 0; i < els.length; i++) {
      const alpha = this.elAlpha(i, segments, rc.time);
      if (alpha <= 0) continue;

      const col = i % cols;
      const row = Math.floor(i / cols);
      const cx = layout.margin.x + col * (cardW + layout.gutter);
      const cy = startY + row * (cardH + 16);

      rc.ctx.save();
      rc.ctx.globalAlpha = alpha;

      drawCard(rc, cx, cy, cardW, cardH, {
        fill: palLight(i),
        borderColor: pal(i),
        accentSide: 'left',
        accentColor: pal(i),
      });
      drawText(rc, els[i].label, cx + 20, cy + (cardH - 24) / 2, {
        font: fontString('bold', 'xs'),
        color: colors.text.primary,
        maxWidth: cardW - 40,
      });

      rc.ctx.restore();
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LLM Plan Generation
  // ═══════════════════════════════════════════════════════════════════════════

  private async generateDiagramPlan(input: SubAgentInput, wordCountOverride?: number, directedScript?: string): Promise<DiagramPlan> {
    const maxWords = wordCountOverride ?? this.estimateWordCount(input.sceneSpec.timeBudget);
    const isGerman = input.language === 'de';

    const diagramTypeList = [
      'flowchart', 'swimlane', 'dfd', 'org-chart', 'mind-map',
      'tree', 'venn', 'gantt', 'scatter', 'line-graph',
      'cycle', 'fishbone', 'pyramid',
    ].join(', ');

    let prompt = isGerman
        ? `Erstelle ein animiertes Diagramm für ein Erklärvideo.

Thema: ${input.sceneSpec.content}
Schwierigkeitsgrad: ${input.difficulty}
Zeitbudget: ${input.sceneSpec.timeBudget} Sekunden (ca. ${maxWords} Wörter)
Visueller Hinweis: ${input.sceneSpec.visualHints || 'keiner'}

Wähle den passendsten Diagrammtyp: ${diagramTypeList}

Respond as JSON:
{
  "script": "Narrations-Text der jedes Element einzeln erklärt...",
  "title": "Diagramm-Titel",
  "diagramType": "flowchart",
  "elements": [
    {"id": "e1", "label": "Element-Beschriftung", "triggerPhrase": "ein Wort/Phrase aus dem Script", "parent": "optionale parent ID für Bäume", "group": "optionaler Gruppen-/Lane-Name", "value": 0, "from": "optionale Quell-ID", "to": "optionale Ziel-ID"}
  ]
}

Regeln:
- 4-10 Elemente, jedes mit einer eindeutigen ID
- "triggerPhrase" muss EXAKT so im Script vorkommen und dieses Element einleiten
- Für mind-map: erstes Element = zentrale Idee, Rest = Äste
- Für tree/org-chart: nutze "parent" um die Hierarchie zu definieren
- Für swimlane: nutze "group" um Lanes zu definieren
- Für venn: erste 2-3 Elemente = Kreise, danach = Überschneidungs-Beschreibungen
- Für fishbone: letztes Element = Effekt (Fischkopf), Rest = Ursachen
- Für pyramid: Elemente von oben (schmalste) nach unten (breiteste) anordnen
- Für gantt/scatter: nutze "value" für numerische Werte
- Für cycle: Elemente in der richtigen Reihenfolge des Zyklus`
        : `Create an animated diagram for an educational explainer video.

Topic: ${input.sceneSpec.content}
Difficulty: ${input.difficulty}
Time budget: ${input.sceneSpec.timeBudget} seconds (approx. ${maxWords} words)
Visual hint: ${input.sceneSpec.visualHints || 'none'}

Choose the most appropriate diagram type: ${diagramTypeList}

Respond as JSON:
{
  "script": "Narration text that explains each element individually...",
  "title": "Diagram Title",
  "diagramType": "flowchart",
  "elements": [
    {"id": "e1", "label": "Element Label", "triggerPhrase": "a word/phrase from the script", "parent": "optional parent ID for trees", "group": "optional group/lane name", "value": 0, "from": "optional source ID", "to": "optional target ID"}
  ]
}

Rules:
- 4-10 elements, each with a unique ID
- "triggerPhrase" must appear EXACTLY in the script and introduce this element
- For mind-map: first element = central idea, rest = branches
- For tree/org-chart: use "parent" to define the hierarchy
- For swimlane: use "group" to define lanes
- For venn: first 2-3 elements = circles, remaining = overlap descriptions
- For fishbone: last element = effect (fish head), rest = causes
- For pyramid: elements ordered from top (narrowest) to bottom (widest)
- For gantt/scatter: use "value" for numeric data points
- For cycle: elements in the correct order of the cycle`;
    if (directedScript) prompt = this.withDirectedScript(prompt, directedScript, isGerman);
    return this.generatePlanJSON<DiagramPlan>(
      prompt,
      isGerman
        ? 'Du bist ein Experte für Datenvisualisierung und Diagramm-Design.'
        : 'You are an expert in data visualization and diagram design.',
    );
  }
}
