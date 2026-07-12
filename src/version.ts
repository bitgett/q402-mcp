/**
 * Single source of truth for the published package version inside the MCP
 * server's own code - DERIVED from package.json so the runtime banner can
 * never drift from the published version again. (0.8.16 shipped with a
 * stale hardcoded "0.8.15" banner because a manual constant wasn't bumped;
 * importing the manifest removes that whole class of mistake.)
 *
 * resolveJsonModule + esModuleInterop are enabled in tsconfig, and tsup
 * inlines the import at build time.
 */
import pkg from "../package.json";

export const PACKAGE_NAME = pkg.name as string;
export const PACKAGE_VERSION = pkg.version as string;
