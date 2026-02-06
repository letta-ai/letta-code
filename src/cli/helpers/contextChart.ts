import { brandColors, colors, hexToFgAnsi } from "../components/colors";
import { MAX_CONTEXT_HISTORY } from "./contextTracker";
import { formatCompact } from "./format";

export interface ContextWindowOverview {
  context_window_size_max: number;
  context_window_size_current: number;
  num_tokens_system: number;
  num_tokens_core_memory: number;
  num_tokens_external_memory_summary: number;
  num_tokens_summary_memory: number;
  num_tokens_functions_definitions: number;
  num_tokens_messages: number;
}

interface ContextChartOptions {
  usedTokens: number;
  contextWindow: number;
  model: string;
  history: Array<{
    timestamp: number;
    tokens: number;
    turnId: number;
    compacted?: boolean;
  }>;
  breakdown?: ContextWindowOverview;
}

/** Renders the /context command output with usage bar, legend, and braille chart. */
export function renderContextUsage(opts: ContextChartOptions): string {
  const { usedTokens, contextWindow, model, history, breakdown } = opts;

  if (usedTokens === 0) {
    return "Context data not available yet. Run a turn to see context usage.";
  }

  const reset = "\x1b[0m";
  const bold = "\x1b[1m";
  const dim = "\x1b[2m";
  const italic = "\x1b[3m";
  const termWidth = process.stdout?.columns ?? 80;

  const percentage =
    contextWindow > 0
      ? Math.min(100, Math.round((usedTokens / contextWindow) * 100))
      : 0;

  const totalSegments = Math.max(1, Math.floor(termWidth * 0.25));
  const filledFromUsage =
    contextWindow > 0
      ? Math.round(
          (Math.min(usedTokens, contextWindow) / contextWindow) * totalSegments,
        )
      : 0;

  let bar: string;
  let legend = "";

  if (breakdown && contextWindow > 0) {
    const categories: Array<{
      label: string;
      tokens: number;
      color: string;
      description?: string;
    }> = [
      {
        label: "System",
        tokens: breakdown.num_tokens_system,
        color: colors.contextBreakdown.system,
      },
      {
        label: "Core Memory",
        tokens: breakdown.num_tokens_core_memory,
        color: colors.contextBreakdown.coreMemory,
      },
      {
        label: "Tools",
        tokens: breakdown.num_tokens_functions_definitions,
        color: colors.contextBreakdown.tools,
      },
      {
        label: "Messages",
        tokens: breakdown.num_tokens_messages,
        color: colors.contextBreakdown.messages,
      },
      {
        label: "Summary",
        tokens: breakdown.num_tokens_summary_memory,
        color: colors.contextBreakdown.summaryMemory,
      },
      {
        label: "Other",
        tokens: breakdown.num_tokens_external_memory_summary,
        color: colors.contextBreakdown.other,
        description: "external memory, archival storage",
      },
    ];

    const filledTotal = filledFromUsage;
    const emptyTotal = totalSegments - filledTotal;
    const nonZeroCats = categories.filter((c) => c.tokens > 0);
    const totalUsed = breakdown.context_window_size_current;
    const segmentCounts: number[] = new Array(categories.length).fill(0);

    if (filledTotal > 0 && totalUsed > 0) {
      let remaining = filledTotal;
      for (let i = 0; i < categories.length; i++) {
        const cat = categories[i];
        if (cat && cat.tokens > 0 && remaining > 0) {
          segmentCounts[i] = 1;
          remaining--;
        }
      }

      if (remaining > 0) {
        const weights = categories.map((cat) =>
          cat.tokens > 0 ? cat.tokens / totalUsed : 0,
        );
        let distributed = 0;
        for (let i = 0; i < categories.length; i++) {
          const cat = categories[i];
          if (cat && cat.tokens > 0) {
            const extra = Math.round((weights[i] ?? 0) * remaining);
            segmentCounts[i] = (segmentCounts[i] ?? 0) + extra;
            distributed += extra;
          }
        }
        const diff = remaining - distributed;
        if (diff !== 0 && nonZeroCats.length > 0) {
          let maxIdx = 0;
          for (let i = 1; i < categories.length; i++) {
            const cat = categories[i];
            const maxCat = categories[maxIdx];
            if (cat && maxCat && cat.tokens > maxCat.tokens) maxIdx = i;
          }
          segmentCounts[maxIdx] = (segmentCounts[maxIdx] ?? 0) + diff;
        }
      }
    }

    let barStr = "";
    for (let i = 0; i < categories.length; i++) {
      const count = segmentCounts[i] ?? 0;
      if (count > 0) {
        const cat = categories[i];
        if (cat) {
          barStr += `${hexToFgAnsi(cat.color)}${"▰".repeat(count)}${reset}`;
        }
      }
    }
    barStr += "▱".repeat(Math.max(0, emptyTotal));
    bar = barStr;

    const indent = "  ";
    const legendLines: string[] = [
      `${indent}${italic}${dim}Estimated usage by category${reset}`,
    ];
    for (const cat of categories) {
      if (cat.tokens > 0) {
        const proportion = totalUsed > 0 ? cat.tokens / totalUsed : 0;
        const estimatedTokens = Math.round(proportion * usedTokens);
        const pct =
          contextWindow > 0
            ? ((estimatedTokens / contextWindow) * 100).toFixed(1)
            : "0.0";
        legendLines.push(
          `${indent}${hexToFgAnsi(cat.color)}■${reset} ${cat.label}: ${formatCompact(estimatedTokens)} tokens (${pct}%)`,
        );
        if (cat.description) {
          legendLines.push(`${indent}  ${dim}${cat.description}${reset}`);
        }
      }
    }
    legend = `\n${legendLines.join("\n")}`;
  } else {
    const barColor = hexToFgAnsi(brandColors.primaryAccent);
    bar = `${barColor}${"▰".repeat(filledFromUsage)}${reset}${"▱".repeat(totalSegments - filledFromUsage)}`;
    // Reserve same number of lines as the breakdown legend to avoid layout shift.
    // Legend has: title + up to 6 categories + 1 description = 8 lines max.
    const placeholderLines = [
      `${dim}  Fetching breakdown...${reset}`,
      ...new Array(7).fill(""),
    ];
    legend = `\n${placeholderLines.join("\n")}`;
  }

  let output = `${bold}Context Usage${reset}\n\n`;
  output += bar;
  output +=
    contextWindow > 0
      ? `\n${formatCompact(usedTokens)}/${formatCompact(contextWindow)} tokens (${percentage}%) · ${model}`
      : `\n${model} · ${formatCompact(usedTokens)} tokens used (context window unknown)`;
  output += `\n${legend}`;

  if (history.length > 1) {
    output += `\n\n\n${renderBrailleChart(history, contextWindow, termWidth)}`;
  }

  return output;
}

// White-to-purple spectrum with brand color (#8C8CF9) in the middle.
// Ordered lightest → brand → darkest, then bounced for smooth cycling.
const CHART_PALETTE = [
  "#B0B0B0", // grey
  "#BEBEEE", // light purple
  "#8C8CF9", // brand purple
  "#5B5BC8", // dark purple
  "#3D3D8F", // indigo
].map(hexToFgAnsi);

function bounceIndex(turnId: number): number {
  return (
    ((turnId % CHART_PALETTE.length) + CHART_PALETTE.length) %
    CHART_PALETTE.length
  );
}

function renderBrailleChart(
  history: Array<{
    timestamp: number;
    tokens: number;
    turnId: number;
    compacted?: boolean;
  }>,
  contextWindow: number,
  termWidth: number,
): string {
  const reset = "\x1b[0m";
  const chartHeight = 6; // rows of braille characters (4 dots each = 24 vertical resolution)
  const labelWidth = 5; // e.g. "100k "
  const steps = history.length;

  // Chart starts at ~25% of terminal, grows 1 char column per step,
  // caps at ~80% of terminal — then interpolates to fit all steps.
  const minChartWidth = Math.max(1, Math.floor(termWidth * 0.25) - labelWidth);
  const maxChartWidth = Math.max(
    minChartWidth,
    Math.floor(termWidth * 0.8) - labelWidth,
  );

  const allValues = history.map((h) => h.tokens);
  let chartWidth: number;
  let values: number[]; // one value per character column
  // Color index per character column (null = use default single color)
  let colColors: number[] | null;
  // Set of character-column indices where compaction occurred
  const compactedCols = new Set<number>();

  if (steps <= maxChartWidth) {
    // Each step gets its own character column; pad to at least minChartWidth
    chartWidth = Math.max(steps, minChartWidth);
    values = allValues.slice(); // 1:1 mapping

    // Assign color per turn using bounce pattern through the palette
    // turnId is incremented once per user turn, so all steps within a turn share the same color
    colColors = history.map((h) => bounceIndex(h.turnId));

    // Track compaction columns (1:1 mapping)
    history.forEach((h, i) => {
      if (h.compacted) compactedCols.add(i);
    });
  } else {
    // Interpolate to fit all steps into maxChartWidth columns — no color alternation
    chartWidth = maxChartWidth;
    values = [];
    for (let i = 0; i < chartWidth; i++) {
      const t = (i / (chartWidth - 1)) * (allValues.length - 1);
      const idx = Math.floor(t);
      const frac = t - idx;
      const v1 = allValues[idx] ?? 0;
      const v2 = allValues[Math.min(idx + 1, allValues.length - 1)] ?? v1;
      values.push(v1 + frac * (v2 - v1));

      // Mark column if any source entry in its range was compacted
      const idxEnd = Math.min(idx + 1, history.length - 1);
      if (history[idx]?.compacted || history[idxEnd]?.compacted) {
        compactedCols.add(i);
      }
    }
    colColors = null;
  }

  const dotsHeight = chartHeight * 4;
  const dotsWidth = chartWidth * 2;

  // Use context window as y-axis ceiling so the chart shows absolute scale
  const max = contextWindow > 0 ? contextWindow : Math.max(...values);
  const min = 0;
  const range = max - min || 1;

  // Create dot grid (row 0 is top)
  const dots: boolean[][] = Array.from({ length: dotsHeight }, () =>
    Array(dotsWidth).fill(false),
  );

  // Plot as filled area chart — each value fills both dot columns in its char column
  for (let charIdx = 0; charIdx < values.length; charIdx++) {
    const val = values[charIdx] ?? 0;
    const normalized = (val - min) / range;
    const y = Math.floor((1 - normalized) * (dotsHeight - 1));

    for (let dotCol = 0; dotCol < 2; dotCol++) {
      const x = charIdx * 2 + dotCol;
      for (let fillY = y; fillY < dotsHeight; fillY++) {
        const fillRow = dots[fillY];
        if (fillRow) fillRow[x] = true;
      }
    }
  }

  // Convert dot grid to braille characters
  const dotBits = [
    [0x01, 0x08], // row 0: dots 1, 4
    [0x02, 0x10], // row 1: dots 2, 5
    [0x04, 0x20], // row 2: dots 3, 6
    [0x40, 0x80], // row 3: dots 7, 8
  ];

  // Generate y-axis labels (top, middle, bottom)
  const yLabels: string[] = [];
  for (let row = 0; row < chartHeight; row++) {
    if (row === 0) {
      yLabels.push(`${formatCompact(max).padStart(labelWidth - 1)} `);
    } else if (row === chartHeight - 1) {
      yLabels.push(`${formatCompact(min).padStart(labelWidth - 1)} `);
    } else if (row === Math.floor(chartHeight / 2)) {
      const mid = min + range / 2;
      yLabels.push(`${formatCompact(mid).padStart(labelWidth - 1)} `);
    } else {
      yLabels.push(" ".repeat(labelWidth));
    }
  }

  // Default color when not alternating (brand color = middle of palette)
  const defaultColor: string =
    CHART_PALETTE[Math.floor(CHART_PALETTE.length / 2)] ?? "\x1b[36m";
  const white = "\x1b[97m";

  // Pre-compute braille codes per (charRow, charCol)
  const brailleCodes: number[][] = Array.from({ length: chartHeight }, () =>
    Array(chartWidth).fill(0x2800),
  );
  for (let charRow = 0; charRow < chartHeight; charRow++) {
    for (let charCol = 0; charCol < chartWidth; charCol++) {
      let code = 0x2800;
      for (let dotRow = 0; dotRow < 4; dotRow++) {
        for (let dotCol = 0; dotCol < 2; dotCol++) {
          const gridRow = charRow * 4 + dotRow;
          const gridCol = charCol * 2 + dotCol;
          const gridRowData = dots[gridRow];
          if (gridRowData?.[gridCol]) {
            const dotBitsRow = dotBits[dotRow];
            if (dotBitsRow) code += dotBitsRow[dotCol] ?? 0;
          }
        }
      }
      if (!brailleCodes[charRow]) {
        brailleCodes[charRow] = new Array<number>(
          Math.ceil(termWidth / 2),
        ).fill(0x2800);
      }
      // brailleCodes[charRow] initialized above if missing
      (brailleCodes[charRow] as number[])[charCol] = code;
    }
  }

  // For compacted columns, find where to place ↓:
  // - If topmost braille is full (0x28FF), ↓ goes in a marker row above
  // - Otherwise, ↓ replaces the topmost braille char in that column
  const FULL_BRAILLE = 0x28ff;
  let needsMarkerRow = false;
  // Track which compacted columns have ↓ placed inline (replacing top braille)
  const inlineMarkerRow = new Map<number, number>(); // charCol → charRow where ↓ is placed

  for (const col of compactedCols) {
    if (brailleCodes[0]?.[col] === FULL_BRAILLE) {
      needsMarkerRow = true;
    } else {
      // Find topmost non-empty row to replace, or use row 0
      let targetRow = 0;
      for (let r = 0; r < chartHeight; r++) {
        if (brailleCodes[r]?.[col] !== 0x2800) {
          targetRow = r;
          break;
        }
      }
      inlineMarkerRow.set(col, targetRow);
    }
  }

  const chartLines: string[] = [];

  // Optional marker row above the chart for compaction columns with full top braille
  if (needsMarkerRow) {
    let markerRow = " ".repeat(labelWidth);
    let markerCurrentColor = "";
    for (let charCol = 0; charCol < chartWidth; charCol++) {
      if (
        compactedCols.has(charCol) &&
        brailleCodes[0]?.[charCol] === FULL_BRAILLE
      ) {
        if (markerCurrentColor !== white) {
          markerRow += white;
          markerCurrentColor = white;
        }
        markerRow += "↓";
      } else {
        markerRow += " ";
      }
    }
    markerRow += reset;
    chartLines.push(markerRow);
  }

  for (let charRow = 0; charRow < chartHeight; charRow++) {
    let rowStr = yLabels[charRow] ?? "";

    // Build chart portion with per-column coloring
    let currentColor = "";
    for (let charCol = 0; charCol < chartWidth; charCol++) {
      // Check if this cell should be a ↓ marker
      if (inlineMarkerRow.get(charCol) === charRow) {
        if (currentColor !== white) {
          rowStr += white;
          currentColor = white;
        }
        rowStr += "↓";
        continue;
      }

      const brailleCode = brailleCodes[charRow]?.[charCol] ?? 0x2800;

      // Determine color for this column
      const targetColor =
        colColors && charCol < colColors.length
          ? (CHART_PALETTE[colColors[charCol] ?? 0] ?? defaultColor)
          : defaultColor;

      // Only emit escape code when color changes
      if (targetColor !== currentColor) {
        rowStr += targetColor;
        currentColor = targetColor;
      }

      rowStr += String.fromCharCode(brailleCode);
    }

    rowStr += reset;
    chartLines.push(rowStr);
  }

  const chartOutput = chartLines.join("\n");
  const stepsLabel =
    steps >= MAX_CONTEXT_HISTORY
      ? `last ${MAX_CONTEXT_HISTORY} steps`
      : `${steps} steps`;
  return `${chartOutput}\n${"─".repeat(labelWidth + chartWidth)} ${stepsLabel}`;
}
