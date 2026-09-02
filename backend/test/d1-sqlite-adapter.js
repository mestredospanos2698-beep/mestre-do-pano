/**
 * Mestre do Pano — backend/test/d1-sqlite-adapter.js
 *
 * Adaptador de teste que imita a API do Cloudflare D1
 * (`db.prepare(sql).bind(...).run()/.first()/.all()`) usando
 * `node:sqlite` (built-in a partir do Node 22, o mesmo motor SQLite usado
 * pelo D1). Isto permite testar backend/src/db.js e backend/src/orders.js
 * sem rede e sem depender do `wrangler d1` local.
 *
 * NÃO é uma implementação completa do D1 — só o suficiente (bind + run +
 * first + all + meta.changes + meta.last_row_id) para os usos existentes
 * em src/db.js.
 */

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, '..', 'schema.sql');

class D1BoundStatement {
  constructor(stmt, params = []) {
    this.stmt = stmt;
    this.params = params;
  }

  /** Imita PreparedStatement#bind do D1 — devolve uma NOVA statement ligada aos parâmetros. */
  bind(...params) {
    return new D1BoundStatement(this.stmt, params);
  }

  /** Imita PreparedStatement#run do D1 — para INSERT/UPDATE/DELETE. */
  async run() {
    const info = this.stmt.run(...this.params);
    return {
      success: true,
      results: [],
      meta: {
        changes: info.changes,
        last_row_id: info.lastInsertRowid,
        duration: 0,
      },
    };
  }

  /** Imita PreparedStatement#first do D1 — devolve uma linha ou null. */
  async first() {
    const row = this.stmt.get(...this.params);
    return row === undefined ? null : row;
  }

  /** Imita PreparedStatement#all do D1 — devolve { results: [...] }. */
  async all() {
    const rows = this.stmt.all(...this.params);
    return { success: true, results: rows, meta: {} };
  }
}

class D1SqliteAdapter {
  constructor(filename = ':memory:') {
    this.sqlite = new DatabaseSync(filename);
  }

  /** Imita Database#prepare do D1. */
  prepare(sql) {
    const stmt = this.sqlite.prepare(sql);
    return new D1BoundStatement(stmt, []);
  }

  /** Não existe na API pública do D1 — utilitário só para aplicar o schema nos testes. */
  exec(sql) {
    this.sqlite.exec(sql);
  }

  close() {
    this.sqlite.close();
  }
}

/**
 * Cria uma base de dados D1-compatível em memória, já com o schema.sql
 * aplicado — pronta para usar em testes (`env.DB = createTestDb()`).
 */
export function createTestDb() {
  const db = new D1SqliteAdapter(':memory:');
  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);
  return db;
}

export { D1SqliteAdapter };
