/** Current A2A protocol version implemented by this package. */
export const A2A_PROTOCOL_VERSION = "1.0";

/** All A2A protocol versions this server supports. */
export const SUPPORTED_VERSIONS: ReadonlySet<string> = new Set(["1.0"]);

/** Default version assumed when A2A-Version header is missing. */
export const DEFAULT_VERSION = "1.0";
