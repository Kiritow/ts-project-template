import { PoolConfig, Pool, PoolClient, DatabaseError, QueryResult } from "pg";
import { Logger as ILogger } from "./base-logger.mjs";

export function isDatabaseError(err: unknown): err is DatabaseError {
  return err instanceof DatabaseError;
}

export interface QueryOptions {
  disableLogger?: boolean;
  logger?: ILogger;
}

class QueryMethods<TBase extends QueryMethods<TBase>> {
  queryEx(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    sql: string,
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    params?: unknown[],
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    options?: QueryOptions
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<QueryResult<any>> {
    throw new Error("Method not implemented.");
  }

  async insert(table: string, data: Record<string, unknown>) {
    const keys = Object.keys(data);
    const placeholders = keys.map((_, index) => `$${index + 1}`).join(", ");

    const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${placeholders})`;
    const params = keys.map((key) => data[key]);
    return await this.queryEx(sql, params);
  }

  async upsert(
    table: string,
    constraint: string,
    data: Record<string, unknown>,
    upsertKeys: string[],
    updateTimeFieldName?: string
  ) {
    const keys = Object.keys(data);
    const insertPlaceholders = keys.map((_, index) => `$${index + 1}`);

    // EXCLUDED is used to refer to the values that were attempted to be inserted
    // See: https://www.postgresql.org/docs/current/sql-insert.html
    const updatePlaceholders = upsertKeys.map(
      (key) => `${key} = EXCLUDED.${key}`
    );

    const params = keys.map((key) => data[key]);
    if (updateTimeFieldName !== undefined) {
      keys.push(updateTimeFieldName);
      insertPlaceholders.push("NOW()");
      updatePlaceholders.push(`${updateTimeFieldName} = NOW()`);
    }

    const sql = `INSERT INTO ${table} (${keys.join(", ")}) VALUES (${insertPlaceholders.join(", ")}) ON CONFLICT (${constraint}) DO UPDATE SET ${updatePlaceholders.join(", ")}`;
    return await this.queryEx(sql, params);
  }

  async simpleUpdate(
    table: string,
    data: Record<string, unknown>,
    where: Record<string, unknown>,
    updateTimeFieldName?: string
  ) {
    const sqlParts: string[] = [];
    const params: unknown[] = [];
    const pushParams = (value: unknown) => {
      const idx = params.length + 1;
      params.push(value);
      return `$${idx}`;
    };

    const keys = Object.keys(data);
    keys.forEach((key) => {
      if (data[key] === undefined) {
        return;
      }

      sqlParts.push(`${key} = ${pushParams(data[key])}`);
    });

    if (sqlParts.length === 0) {
      return;
    }

    if (updateTimeFieldName !== undefined) {
      sqlParts.push(`${updateTimeFieldName} = NOW()`);
    }

    const whereParts: string[] = [];
    const whereKeys = Object.keys(where);
    whereKeys.forEach((key) => {
      if (where[key] === undefined) {
        return;
      }

      whereParts.push(`${key} = ${pushParams(where[key])}`);
    });

    if (whereParts.length === 0) {
      throw new Error(
        `No where condition provided for update to table: ${table}`
      );
    }

    const sql = `UPDATE ${table} SET ${sqlParts.join(", ")} WHERE ${whereParts.join(" AND ")}`;
    return await this.queryEx(sql, params);
  }
}

export class BasePostgresConnection extends QueryMethods<BasePostgresConnection> {
  constructor(
    private conn: PoolClient,
    private logger?: ILogger
  ) {
    super();
  }

  async queryEx(sql: string, params?: unknown[]) {
    if (this.logger === undefined) {
      return this.conn.query(sql, params);
    }

    const startTime = Date.now();
    try {
      const queryResult = await this.conn.query(sql, params);
      this.logger.debug(`${sql} %j cost ${Date.now() - startTime}ms`, params);
      return queryResult;
    } catch (e) {
      if (isDatabaseError(e)) {
        this.logger.error(
          `${sql} %j cost=${Date.now() - startTime}ms dberror=%j`,
          params,
          e
        );
      } else {
        this.logger.error(
          `${sql} %j cost=${Date.now() - startTime}ms error=%s`,
          params,
          e instanceof Error ? e.message : `${e}`
        );
      }

      throw e;
    }
  }

  async query(sql: string, params?: unknown[]) {
    return (await this.queryEx(sql, params)).rows;
  }

  async run(sql: string, params?: unknown[]) {
    return (await this.queryEx(sql, params)).rowCount;
  }

  async begin() {
    await this.run("BEGIN");
  }

  async beginReadOnly() {
    await this.run("BEGIN TRANSACTION READ ONLY");
  }

  async commit() {
    await this.run("COMMIT");
  }

  async rollback() {
    await this.run("ROLLBACK");
  }

  finally() {
    this.rollback()
      .then(() => {
        this.conn.release();
      })
      .catch((err) => {
        this.logger?.error("Error during rollback: %s", err);
        this.conn.release(true);
      });
  }
}

export class BasePostgresPool extends QueryMethods<BasePostgresPool> {
  private pool: Pool;
  private logger?: ILogger;

  constructor(config: PoolConfig, logger?: ILogger) {
    super();
    this.pool = new Pool(config);
    this.logger = logger;
  }

  async queryEx(sql: string, params?: unknown[]) {
    if (this.logger === undefined) {
      return this.pool.query(sql, params);
    }

    const startTime = Date.now();
    try {
      const queryResult = await this.pool.query(sql, params);
      this.logger.debug(`${sql} %j cost ${Date.now() - startTime}ms`, params);
      return queryResult;
    } catch (e) {
      if (isDatabaseError(e)) {
        this.logger.error(
          `${sql} %j cost=${Date.now() - startTime}ms dberror=[${e.code}] ${e.message}`,
          params
        );
      } else {
        this.logger.error(
          `${sql} %j cost=${Date.now() - startTime}ms error=${e instanceof Error ? e.message : `${e}`}`,
          params
        );
      }

      throw e;
    }
  }

  async query(sql: string, params?: unknown[]) {
    return (await this.queryEx(sql, params)).rows;
  }

  async run(sql: string, params?: unknown[]) {
    return (await this.queryEx(sql, params)).rowCount;
  }

  async getConnection(): Promise<BasePostgresConnection> {
    const client = await this.pool.connect();
    return new BasePostgresConnection(client, this.logger);
  }

  finally() {
    this.pool.end();
  }
}
