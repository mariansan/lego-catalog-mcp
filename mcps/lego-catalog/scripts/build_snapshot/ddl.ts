/**
 * Static DDL (no interpolated input). Tables are created empty, bulk-loaded, then secondary indexes
 * and FTS are built afterwards because that is much faster than maintaining them per insert.
 */
export const CREATE_TABLES = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID;

CREATE TABLE colors (
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, rgb TEXT NOT NULL, is_trans INTEGER NOT NULL,
  num_parts INTEGER NOT NULL, num_sets INTEGER NOT NULL, y1 INTEGER, y2 INTEGER
);
CREATE TABLE part_categories (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE parts (
  part_num TEXT PRIMARY KEY, name TEXT NOT NULL, part_cat_id INTEGER NOT NULL, part_material TEXT NOT NULL
) WITHOUT ROWID;
CREATE TABLE sets (
  set_num TEXT PRIMARY KEY, name TEXT NOT NULL, year INTEGER NOT NULL, theme_id INTEGER NOT NULL,
  num_parts INTEGER NOT NULL
) WITHOUT ROWID;
CREATE TABLE themes (id INTEGER PRIMARY KEY, name TEXT NOT NULL, parent_id INTEGER);
CREATE TABLE inventories (
  id INTEGER PRIMARY KEY, version INTEGER NOT NULL, set_num TEXT NOT NULL,
  is_minifig INTEGER NOT NULL DEFAULT 0  -- set to 1 after load when set_num is a fig-* id (minifig inventory), not in sets
);
-- Primary key doubles as the lookup index "all parts of inventory N" (clustered, no rowid, no img_url).
CREATE TABLE inventory_parts (
  inventory_id INTEGER NOT NULL, part_num TEXT NOT NULL, color_id INTEGER NOT NULL,
  is_spare INTEGER NOT NULL, quantity INTEGER NOT NULL,
  PRIMARY KEY (inventory_id, part_num, color_id, is_spare)
) WITHOUT ROWID;
CREATE TABLE elements (
  element_id TEXT PRIMARY KEY, part_num TEXT NOT NULL, color_id INTEGER NOT NULL,
  design_id TEXT  -- nullable: empty in the source for ~21.7k rows; often != part_num
) WITHOUT ROWID;
`;

export const CREATE_PART_COLORS = `
-- Every (part, color) combination known to exist: seen in any inventory and/or listed as an element.
CREATE TABLE part_colors (
  part_num TEXT NOT NULL, color_id INTEGER NOT NULL,
  num_inventories INTEGER NOT NULL,  -- distinct inventories containing it (0 = elements-only)
  in_elements INTEGER NOT NULL,
  PRIMARY KEY (part_num, color_id)
) WITHOUT ROWID;
INSERT INTO part_colors (part_num, color_id, num_inventories, in_elements)
SELECT part_num, color_id, SUM(inv), MAX(el) FROM (
  SELECT part_num, color_id, COUNT(DISTINCT inventory_id) AS inv, 0 AS el
    FROM inventory_parts GROUP BY part_num, color_id
  UNION ALL
  SELECT part_num, color_id, 0 AS inv, 1 AS el FROM elements GROUP BY part_num, color_id
) GROUP BY part_num, color_id;
`;

export const CREATE_INDEXES_AND_FTS = `
-- Tool queries: latest inventory version per set_num (highest version wins).
CREATE INDEX idx_inventories_set_version ON inventories (set_num, version DESC);
-- elements by part and color; element_id is the primary key.
CREATE INDEX idx_elements_part_color ON elements (part_num, color_id);
CREATE INDEX idx_parts_category ON parts (part_cat_id);
CREATE INDEX idx_sets_theme ON sets (theme_id);
-- Own copy of the searchable text (not external-content: VACUUM may renumber rowids of keyed tables).
CREATE VIRTUAL TABLE parts_fts USING fts5(part_num, name, tokenize = 'unicode61 remove_diacritics 2');
INSERT INTO parts_fts (part_num, name) SELECT part_num, name FROM parts;
INSERT INTO parts_fts (parts_fts) VALUES ('optimize');
`;
