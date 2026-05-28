/**
 * Single source of truth for the published package version inside the MCP
 * server's own code. Mirrors package.json — the package-drift test asserts
 * the two stay in sync at publish time.
 */
export const PACKAGE_NAME    = "@quackai/q402-mcp";
export const PACKAGE_VERSION = "0.6.2";
