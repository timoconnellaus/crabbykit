/**
 * In-memory SqlStore mock for testing.
 * Uses a simple table/row model with proper SQL parsing for our use cases.
 */

import type { SqlResult, SqlStore } from "../storage/types.js";

interface Row {
  [key: string]: unknown;
}

interface Table {
  rows: Row[];
  columns: string[];
  defaults: Record<string, () => unknown>;
}

/**
 * @deprecated Use createMockSqlStore() instead.
 */
export function createMockSqlStorage(): SqlStore {
  return createMockSqlStore();
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
        const colDefs = trimmed.match(/\((.+)\)$/s);
        const defaults: Record<string, () => unknown> = {};
        const columns: string[] = [];

        if (colDefs) {
          const parts = colDefs[1].split(/,(?![^(]*\))/);
          for (const part of parts) {
            const p = part.trim();
            if (
              p.startsWith("FOREIGN") ||
              p.startsWith("CREATE") ||
              /^PRIMARY\s+KEY/i.test(p) ||
              p.startsWith("CHECK")
            )
              continue;
            const colName = p.split(/\s+/)[0];
            if (!colName || colName === "FOREIGN" || colName === "CHECK") continue;
            columns.push(colName);

            if (p.includes("DEFAULT")) {
              if (p.includes("datetime('now')") || p.includes("CURRENT_TIMESTAMP")) {
                defaults[colName] = () => new Date().toISOString();
              } else {
                const defMatch = p.match(/DEFAULT\s+'([^']+)'/);
                if (defMatch) {
                  defaults[colName] = () => defMatch[1];
                }
              }
            }
          }
        }

        tables.set(nameMatch[1], { rows: [], columns, defaults });
      }
      return createResult([]);
    }

    // PRAGMA table_info(tablename)
    const pragmaMatch = trimmed.match(/^PRAGMA\s+table_info\s*\(\s*(\w+)\s*\)$/i);
    if (pragmaMatch) {
      const table = tables.get(pragmaMatch[1]);
      if (!table) return createResult([]);
      return createResult(table.columns.map((name) => ({ name })));
    }

    // ALTER TABLE ... ADD COLUMN <name> <type...>
    const alterMatch = trimmed.match(/^ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)\b/i);
    if (alterMatch) {
      const table = tables.get(alterMatch[1]);
      if (table && !table.columns.includes(alterMatch[2])) {
        table.columns.push(alterMatch[2]);
      }
      return createResult([]);
    }

    // CREATE INDEX
    if (/^CREATE INDEX/i.test(trimmed)) {
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
        } else if (expr.includes("datetime('now')") || expr.includes("CURRENT_TIMESTAMP")) {
          row[cols[i]] = new Date().toISOString();
        } else if (expr.includes("randomblob")) {
          row[cols[i]] = crypto.randomUUID();
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

      table.rows.push(row);
      return createResult([]);
    }

    // SELECT with COALESCE/MAX aggregate
    if (/COALESCE\s*\(MAX/i.test(trimmed)) {
      const tableMatch = trimmed.match(/FROM\s+(\w+)/i);
      if (!tableMatch) return createResult([{ next_seq: 1 }]);
      const table = tables.get(tableMatch[1]);
      if (!table) return createResult([{ next_seq: 1 }]);

      const whereMatch = trimmed.match(/WHERE\s+(.+)$/i);
      let filtered = table.rows;
      if (whereMatch) {
        const sessionId = bindings[0];
        filtered = table.rows.filter((r) => r.session_id === sessionId);
      }
      const maxSeq = filtered.reduce((max, r) => Math.max(max, Number(r.seq) || 0), 0);
      return createResult([{ next_seq: maxSeq + 1 }]);
    }

    // SELECT
    if (/^SELECT/i.test(trimmed)) {
      const fromMatch = trimmed.match(/FROM\s+(\w+)/i);
      if (!fromMatch) return createResult([]);

      const table = tables.get(fromMatch[1]);
      if (!table) return createResult([]);

      let rows = [...table.rows];

      // WHERE clause
      const whereMatch = trimmed.match(/WHERE\s+(.+?)(?:\s+ORDER\s|$)/i);
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
          const gtMatch = cond.trim().match(/^(\w+)\s*>\s*\?$/);
          if (gtMatch) {
            const col = gtMatch[1];
            const val = bindings[bi++] as number;
            rows = rows.filter((r) => (r[col] as number) > val);
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
      const limitMatch = trimmed.match(/LIMIT\s+(\?|\d+)/i);
      if (limitMatch) {
        const limit =
          limitMatch[1] === "?" ? (bindings[bindings.length - 1] as number) : Number(limitMatch[1]);
        rows = rows.slice(0, limit);
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

      // Parse SET values
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

      // Parse WHERE
      const whereConds = whereClause.split(/\s+AND\s+/i);
      const whereBi = setBi;

      for (const row of table.rows) {
        let match = true;
        let wbi = whereBi;
        for (const cond of whereConds) {
          const cm = cond.trim().match(/^(\w+)\s*=\s*\?$/);
          if (cm) {
            if (row[cm[1]] !== bindings[wbi++]) {
              match = false;
              break;
            }
          }
        }
        if (match) {
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

      const tableName = match[1];
      const table = tables.get(tableName);
      if (!table) return createResult([]);

      const whereClause = match[2].trim();

      // Handle IN (...) clause: DELETE FROM t WHERE col IN (?, ?, ?)
      const inMatch = whereClause.match(/^(\w+)\s+IN\s*\(([^)]+)\)$/i);
      if (inMatch) {
        const col = inMatch[1];
        const inValues = new Set(bindings);
        const deleted: Row[] = [];
        table.rows = table.rows.filter((row) => {
          if (inValues.has(row[col])) {
            deleted.push(row);
            return false;
          }
          return true;
        });
        if (tableName === "sessions") {
          const entries = tables.get("session_entries");
          if (entries) {
            const deletedIds = new Set(deleted.map((r) => r.id));
            entries.rows = entries.rows.filter((e) => !deletedIds.has(e.session_id));
          }
        }
        return createResult([]);
      }

      const conditions = whereClause.split(/\s+AND\s+/i);
      const bi = 0;

      const deleted: Row[] = [];
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
        if (shouldDelete) {
          deleted.push(row);
          return false;
        }
        return true;
      });

      // CASCADE: if deleting from sessions, also delete from session_entries
      if (tableName === "sessions") {
        const entries = tables.get("session_entries");
        if (entries) {
          const deletedIds = new Set(deleted.map((r) => r.id));
          entries.rows = entries.rows.filter((e) => !deletedIds.has(e.session_id));
        }
      }

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
