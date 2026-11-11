/**
 * The one place the running version comes from: package.json. The MCP
 * serverInfo, /api/catalog (and through it every stamp in the console) read
 * this, so a release is a single edit. Before v0.39 the same number was
 * hand-typed in five places and read 0.17.1, 0.18, 0.35 and 0.37.1 at once.
 */
import pkg from "../package.json";

export const VERSION: string = pkg.version;
