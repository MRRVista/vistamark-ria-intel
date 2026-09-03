import { drizzle } from "drizzle-orm/neon-http";
import { neon } from "@neondatabase/serverless";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL;

if (!connectionString) {
  console.warn(
    "[db] DATABASE_URL is not set. Database operations will fail until you connect Postgres."
  );
}

type Db = ReturnType<typeof drizzle<typeof schema>>;

/**
 * Production: Neon's HTTP driver (one round trip per statement, no
 * interactive transactions — every write path in lib/ is written for that).
 * Local dev/tests: set DATABASE_DRIVER=pg to talk to any plain Postgres over
 * node-postgres with the same schema and query builder.
 */
function connect(): Db | null {
  if (!connectionString) return null;
  if (process.env.DATABASE_DRIVER === "pg") {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { drizzle: drizzlePg } = require("drizzle-orm/node-postgres") as typeof import("drizzle-orm/node-postgres");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Pool } = require("pg") as typeof import("pg");
    return drizzlePg(new Pool({ connectionString }), { schema, logger: false }) as unknown as Db;
  }
  return drizzle(neon(connectionString), { schema, logger: false });
}

export const db = (connect() ?? (null as unknown as Db)) as Db;

export const isDbReady = () => connectionString != null;

export { schema };
