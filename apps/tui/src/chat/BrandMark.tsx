interface PixelSegment {
  text: string;
  fg?: string;
  bg?: string;
}

const PALETTE: Record<string, string> = {
  R: "#ff3b1f",
  S: "#d92518",
  G: "#69b34c",
  E: "#24282d",
};

// Terminal pixel render generated from assets/brand/chili-icon.svg.
const BRAND_GRID = [
  "....................................",
  "....................................",
  "....................................",
  "....................................",
  ".........................EEEE.......",
  "........................EEEEEE......",
  ".......................EEEGEE.......",
  "......................EEEGEEE.......",
  ".....................EEEEGEE........",
  "...................EEEEEEEEE........",
  "...................EEESRSEEE........",
  "..................EEEEEEEEEEE.......",
  ".................EEEGGGEEEEEE.......",
  ".................EEEEEGGEEESEE......",
  "................EESSEEEEESRREE......",
  "................EERRRSSSRRRREE......",
  "...............EESRRRRRRRRRREE......",
  "...............EERRRRRRRRRRREE......",
  "..............EESRRRRRRRRRRSEE......",
  "..............EERRRRRRRRRRREE.......",
  ".............EESRRRRRRRRRRSEE.......",
  ".............EERRRRRRRRRRREEE.......",
  "............EESRRRRRRRRRRSEE........",
  "...........EEERRRRRRRRRRSEE.........",
  "..........EEERRRRRRRRRRSEEE.........",
  ".........EEESRRRRRRRRRSEEE..........",
  ".......EEEERRRRRRRRRSEEEE...........",
  ".......EESRRRRRRRRSEEEE.............",
  "......EESRRRRSSSEEEEEE..............",
  "......EEEEEEEEEEEEE.................",
  ".......EEEEEEEEE....................",
  "....................................",
  "....................................",
  "....................................",
  "....................................",
  "....................................",
] as const;

const COMPACT_BRAND_GRID = [
  "........................",
  "........................",
  "..................E.....",
  "................EEEE....",
  "...............EEGEE....",
  "..............EEGEE.....",
  ".............EEEEEE.....",
  "............EEEEEEE.....",
  "...........EEEGGEEEE....",
  "...........ESEEEESSE....",
  "..........EERRRSRRSE....",
  "..........ESRRRRRRSE....",
  ".........EERRRRRRREE....",
  ".........ESRRRRRRREE....",
  "........EERRRRRRREE.....",
  ".......EESRRRRRRSE......",
  "......EESRRRRRRSEE......",
  ".....EESRRRRRSEEE.......",
  "....EESRRRRSEEE.........",
  "....EEEEEEEEEE..........",
  ".....EEEEEE.............",
  "........................",
  "........................",
  "........................",
] as const;

function colorFor(key: string | undefined): string | undefined {
  if (!key || key === ".") {
    return undefined;
  }
  return PALETTE[key];
}

function pixelPair(top: string | undefined, bottom: string | undefined): PixelSegment {
  const fg = colorFor(top);
  const bg = colorFor(bottom);
  if (fg && bg) {
    return fg === bg ? { text: "█", fg } : { text: "▀", fg, bg };
  }
  if (fg) {
    return { text: "▀", fg };
  }
  if (bg) {
    return { text: "▄", fg: bg };
  }
  return { text: " " };
}

function mergeSegments(segments: readonly PixelSegment[]): PixelSegment[] {
  const merged: PixelSegment[] = [];
  for (const segment of segments) {
    const previous = merged.at(-1);
    if (previous && previous.fg === segment.fg && previous.bg === segment.bg && previous.text[0] === segment.text) {
      previous.text += segment.text;
    } else {
      merged.push({ ...segment });
    }
  }
  return merged;
}

function renderRows(grid: readonly string[]): readonly PixelSegment[][] {
  const rows: PixelSegment[][] = [];
  for (let y = 0; y < grid.length; y += 2) {
    const top = grid[y] ?? "";
    const bottom = grid[y + 1] ?? "";
    const width = Math.max(top.length, bottom.length);
    const segments: PixelSegment[] = [];
    for (let x = 0; x < width; x += 1) {
      segments.push(pixelPair(top[x], bottom[x]));
    }
    rows.push(mergeSegments(segments));
  }
  return rows;
}

const BRAND_ROWS = renderRows(BRAND_GRID);
const COMPACT_BRAND_ROWS = renderRows(COMPACT_BRAND_GRID);

export function BrandMark(props: { compact?: boolean }) {
  const rows = props.compact ? COMPACT_BRAND_ROWS : BRAND_ROWS;
  return (
    <box flexDirection="column" alignItems="center">
      {rows.map((row, rowIndex) => (
        <box key={rowIndex} flexDirection="row" height={1}>
          {row.map((segment, segmentIndex) => {
            const colorProps = {
              ...(segment.fg ? { fg: segment.fg } : {}),
              ...(segment.bg ? { bg: segment.bg } : {}),
            };
            return (
              <text key={`${rowIndex}:${segmentIndex}`} {...colorProps} wrapMode="none" truncate>
                {segment.text}
              </text>
            );
          })}
        </box>
      ))}
    </box>
  );
}
