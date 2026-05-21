import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    "[db] DATABASE_URL is not set. Database operations will fail until you connect Postgres."
  );
}

const sql = connectionString ? neon(connectionString) : null;

export const db = sql
  ? drizzle(sql, { schema, logger: false })
  : (null as unknown as ReturnType<typeof drizzle>);

export const isDbReady = () => connectionString != null;

export { schema };
