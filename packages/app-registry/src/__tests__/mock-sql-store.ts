/**
 * Lightweight in-memory SqlStore mock for app-registry tests.
 * Supports CREATE TABLE, INSERT, SELECT, UPDATE, DELETE with basic WHERE clauses.
 */

import type { SqlResult, SqlStore } from "@claw-for-cloudflare/agent-runtime";

interface Row {
  [key: string]: unknown;
}

interface Table {
  rows: Row[];
  defaults: Record<string, () => unknown>;
  uniqueColumns: string[];
}

export function createMockSqlStore(): SqlStore {
  const tables = new Map<string, Table>();

  function getTable(name: string): Table {
    const t = tables.get(name);
    if (!t) throw new Error(`Table not found: ${name}`);
    return t;
  }

  function execSql(sql: string, ...bindings: unknown[]): SqlResult<Record<string, unknown>> {
    const trimmed = sql.replace(/\s+/g, " ").trim();

    // CREATE TABLE
    if (/^CREATE TABLE IF NOT EXISTS/i.test(trimmed)) {
      const nameMatch = trimmed.match(/CREATE TABLE IF NOT EXISTS (\w+)/i);
      if (nameMatch && !tables.has(nameMatch[1])) {
        const defaults: Record<string, () => unknown> = {};
        const uniqueColumns: string[] = [];
        const colDefs = trimmed.match(/\((.+)\)$/s);

        if (colDefs) {
          const parts = colDefs[1].split(/,(?![^(]*\))/);
          for (const part of parts) {
            const p = part.trim();
            if (p.startsWith("PRIMARY") || p.startsWith("FOREIGN")) continue;
            const colName = p.split(/\s+/)[0];
            if (!colName) continue;

            if (p.includes("UNIQUE")) {
              uniqueColumns.push(colName);
            }
            if (p.includes("DEFAULT")) {
              if (p.includes("datetime('now')")) {
                defaults[colName] = () => new Date().toISOString();
              } else {
                const numMatch = p.match(/DEFAULT\s+(-?\d+)/);
              if (numMatch) {
                const val = Number(numMatch[1]);
                defaults[colName] = () => val;
              } else {
                const strMatch = p.match(/DEFAULT\s+'([^']+)'/);
                if (strMatch) {
                  const val = strMatch[1];
                  defaults[colName] = () => val;
                }
              }
              }
            }
          }
        }

        tables.set(nameMatch[1], { rows: [], defaults, uniqueColumns });
      }
      return createResult([]);
    }

    // CREATE INDEX
    if (/^CREATE (?:UNIQUE )?INDEX/i.test(trimmed)) {
      // Parse UNIQUE INDEX to extract column for constraint checking
      if (/^CREATE UNIQUE INDEX/i.test(trimmed)) {
        const idxMatch = trimmed.match(/ON\s+(\w+)\s*\((\w+)\)/i);
        if (idxMatch) {
          const table = tables.get(idxMatch[1]);
          if (table && !table.uniqueColumns.includes(idxMatch[2])) {
            table.uniqueColumns.push(idxMatch[2]);
          }
        }
      }
      return createResult([]);
    }

    // INSERT
    if (/^INSERT INTO/i.test(trimmed)) {
      const match = trimmed.match(/INSERT INTO (\w+)\s*\(([^)]+)\)\s*VALUES\s*\((.+)\)$/i);
      if (!match) return createResult([]);

      const tableName = match[1];
      const table = getTable(tableName);
      const cols = match[2].split(",").map((c) => c.trim());
      const valExprs = match[3].split(",").map((v) => v.trim());

      const row: Row = {};
      let bi = 0;

      for (let i = 0; i < cols.length; i++) {
        const expr = valExprs[i];
        if (expr === "?") {
          row[cols[i]] = bindings[bi++];
        } else if (expr.includes("datetime('now')")) {
          row[cols[i]] = new Date().toISOString();
        } else {
          row[cols[i]] = expr.replace(/^'|'$/g, "");
        }
      }

      // Apply defaults for missing columns
      for (const [col, fn] of Object.entries(table.defaults)) {
        if (!(col in row)) {
          row[col] = fn();
        }
      }

      // Check unique constraints
      for (const col of table.uniqueColumns) {
        if (row[col] !== undefined) {
          const existing = table.rows.find((r) => r[col] === row[col]);
          if (existing) {
            throw new Error(`UNIQUE constraint failed: ${tableName}.${col}`);
          }
        }
      }

      table.rows.push(row);
      return createResult([]);
    }

    // SELECT with MIN aggregate
    if (/SELECT\s+MIN\(/i.test(trimmed)) {
      const tableMatch = trimmed.match(/FROM\s+(\w+)/i);
      if (!tableMatch) return createResult([{ earliest: null }]);
      const table = tables.get(tableMatch[1]);
      if (!table) return createResult([{ earliest: null }]);
      return createResult([{ earliest: null }]);
    }

    // SELECT
    if (/^SELECT/i.test(trimmed)) {
      const fromMatch = trimmed.match(/FROM\s+(\w+)/i);
      if (!fromMatch) return createResult([]);

      const table = tables.get(fromMatch[1]);
      if (!table) return createResult([]);

      let rows = [...table.rows];

      // WHERE clause
      const whereMatch = trimmed.match(/WHERE\s+(.+?)(?:\s+ORDER\s|\s+LIMIT\s|$)/i);
      if (whereMatch) {
        const conditions = whereMatch[1].split(/\s+AND\s+/i);
        let bi = 0;
        for (const cond of conditions) {
          const eqMatch = cond.trim().match(/^(\w+)\s*=\s*\?$/);
          if (eqMatch) {
            const col = eqMatch[1];
            const val = bindings[bi++];
            rows = rows.filter((r) => r[col] === val);
            continue;
          }
          const leMatch = cond.trim().match(/^(\w+)\s*<=\s*\?$/);
          if (leMatch) {
            const col = leMatch[1];
            const val = bindings[bi++];
            rows = rows.filter((r) => String(r[col] ?? "") <= String(val));
          }
        }
      }

      // ORDER BY
      const orderMatch = trimmed.match(/ORDER\s+BY\s+(\w+)(?:\s+(ASC|DESC))?/i);
      if (orderMatch) {
        const col = orderMatch[1];
        const desc = orderMatch[2]?.toUpperCase() === "DESC";
        rows.sort((a, b) => {
          const av = a[col];
          const bv = b[col];
          if (typeof av === "number" && typeof bv === "number") {
            return desc ? bv - av : av - bv;
          }
          const cmp = String(av ?? "").localeCompare(String(bv ?? ""));
          return desc ? -cmp : cmp;
        });
      }

      // LIMIT
      const limitMatch = trimmed.match(/LIMIT\s+(\d+)/i);
      if (limitMatch) {
        rows = rows.slice(0, Number(limitMatch[1]));
      }

      return createResult(rows);
    }

    // UPDATE
    if (/^UPDATE/i.test(trimmed)) {
      const match = trimmed.match(/UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+)$/i);
      if (!match) return createResult([]);

      const table = getTable(match[1]);
      const setParts = match[2].split(",").map((s) => s.trim());
      const whereClause = match[3].trim();

      const updates: Array<{ col: string; val: unknown | (() => unknown) }> = [];
      let setBi = 0;
      for (const part of setParts) {
        const eqMatch = part.match(/(\w+)\s*=\s*(.+)/);
        if (!eqMatch) continue;
        const col = eqMatch[1];
        const expr = eqMatch[2].trim();
        if (expr === "?") {
          updates.push({ col, val: bindings[setBi++] });
        } else if (expr.includes("datetime('now')")) {
          updates.push({ col, val: () => new Date().toISOString() });
        }
      }

      const whereConds = whereClause.split(/\s+AND\s+/i);
      const whereBi = setBi;

      for (const row of table.rows) {
        let isMatch = true;
        let wbi = whereBi;
        for (const cond of whereConds) {
          const cm = cond.trim().match(/^(\w+)\s*=\s*\?$/);
          if (cm) {
            if (row[cm[1]] !== bindings[wbi++]) {
              isMatch = false;
              break;
            }
          }
        }
        if (isMatch) {
          for (const u of updates) {
            row[u.col] = typeof u.val === "function" ? u.val() : u.val;
          }
        }
      }

      return createResult([]);
    }

    // DELETE
    if (/^DELETE FROM/i.test(trimmed)) {
      const match = trimmed.match(/DELETE FROM\s+(\w+)\s+WHERE\s+(.+)$/i);
      if (!match) return createResult([]);

      const table = tables.get(match[1]);
      if (!table) return createResult([]);

      const conditions = match[2].split(/\s+AND\s+/i);
      const bi = 0;

      table.rows = table.rows.filter((row) => {
        let shouldDelete = true;
        let cbi = bi;
        for (const cond of conditions) {
          const cm = cond.trim().match(/^(\w+)\s*=\s*\?$/);
          if (cm) {
            if (row[cm[1]] !== bindings[cbi++]) {
              shouldDelete = false;
            }
          }
        }
        return !shouldDelete;
      });

      return createResult([]);
    }

    return createResult([]);
  }

  function createResult(rows: Row[]): SqlResult<Record<string, unknown>> {
    return {
      toArray: () => [...rows],
      one: () => (rows.length > 0 ? rows[0] : null),
      [Symbol.iterator]() {
        return rows[Symbol.iterator]();
      },
    };
  }

  return {
    exec: <T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlResult<T> =>
      execSql(query, ...bindings) as SqlResult<T>,
  };
}
