import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FILE_SPECS } from "../../scripts/build_snapshot/spec.ts";

/** Tiny but complete CSV rows, one array per Rebrickable file (header added by writeFixtureCache). */
export const BASE_ROWS: Readonly<Record<string, readonly string[]>> = {
  colors: ["0,Black,05131D,False,100,200,1957,2025", "-1,[Unknown],0033B2,False,0,0,,"],
  part_categories: ["11,Bricks"],
  parts: ["3001,Brick 2 x 4,11,Plastic", '3002,"Brick 2 x 3, special",11,Plastic'],
  elements: ["300126,3001,5,3001", "9999999,3002,5,"],
  sets: ["75192-1,Millennium Falcon,2017,171,7541,https://img/1.jpg"],
  themes: ["171,Star Wars,"],
  inventories: ["1,1,75192-1", "2,2,75192-1", "3,1,fig-000001"],
  // inventory_id,part_num,color_id,quantity,is_spare,img_url
  inventory_parts: ["1,3001,5,2,False,https://img/a.jpg", "2,3001,5,3,False,https://img/a.jpg", "2,3002,5,1,True,"],
};

/** Writes a complete 12-file cache. `overrides` replaces a whole file (header included); `rows` replaces just the data rows. */
export function writeFixtureCache(
  dir: string,
  overrides: Record<string, string> = {},
  rows: Readonly<Record<string, readonly string[]>> = BASE_ROWS,
): void {
  mkdirSync(dir, { recursive: true });
  for (const s of FILE_SPECS) {
    const header = s.columns.map((c) => c.name).join(",");
    const body = rows[s.file] ?? [];
    writeFileSync(join(dir, `${s.file}.csv`), overrides[s.file] ?? [header, ...body].join("\n") + "\n");
  }
  writeFileSync(join(dir, "DOWNLOADED_AT.txt"), "downloaded_utc=2026-10-05T15:40:52Z\n");
}

const FILLER_PARTS = 130;
const fillerNum = (i: number): string => `9${String(i).padStart(4, "0")}`;

/**
 * Rows for the tool/HTTP test fixture: the base rows plus enough generated data to exercise what the tests rely on
 * (not just "a row exists"):
 *  - 121 colors (39 transparent), so list_colors paginates at limit 5 and at limit 100;
 *  - 132 parts, 130 of them "Brick Filler N", so search_parts("brick", limit 100) has more than one page;
 *  - part 3001 in 8 colors (inventory rows + elements), element 300126 = 3001 in Black (color 0);
 *  - set 75192-1 with two inventory versions; the latest (id 2) has 251 rows, so limit=200 paginates.
 * Generated numbers are deterministic. Nothing here is the real Rebrickable data; the names only imitate it.
 */
export function serverFixtureRows(): Record<string, readonly string[]> {
  const colors = [...(BASE_ROWS.colors ?? [])];
  for (let i = 1; i <= 119; i++) {
    const trans = i % 3 === 0;
    const rgb = String(i * 1000).padStart(6, "0").slice(-6);
    colors.push(`${i},${trans ? "Trans Color" : "Color"} ${i},${rgb},${trans ? "True" : "False"},${i},${i},2000,2025`);
  }

  const parts = [...(BASE_ROWS.parts ?? [])];
  for (let i = 0; i < FILLER_PARTS; i++) parts.push(`${fillerNum(i)},Brick Filler ${i},11,Plastic`);

  // The base row 300126 is color 5; real data has 300126 = 3001 in Black, which the lookup test asserts.
  const elements = ["300126,3001,0,3001", "9999999,3002,5,"];
  for (let c = 1; c <= 7; c++) elements.push(`55${c}3001,3001,${c},3001`);

  const inventoryParts = [...(BASE_ROWS.inventory_parts ?? [])];
  for (let c = 0; c <= 7; c++) if (c !== 5) inventoryParts.push(`1,3001,${c},1,False,`);
  for (let i = 0; i < 249; i++) {
    inventoryParts.push(`2,${fillerNum(i % FILLER_PARTS)},${1 + Math.floor(i / FILLER_PARTS)},${(i % 4) + 1},False,`);
  }

  return { ...BASE_ROWS, colors, parts, elements, inventory_parts: inventoryParts };
}
