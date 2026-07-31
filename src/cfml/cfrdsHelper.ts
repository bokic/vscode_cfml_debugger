import { Server, ServerContext } from "@bokic/cfrds";
import { sendRdsCommand } from "@bokic/cfrds/dist/transport";

export interface ExtendedServerContext extends ServerContext {
  timeout?: number;
  agent?: any;
}

export interface ServerWithCtx {
  ctx?: ExtendedServerContext;
}

/**
 * Safely sets the timeout on the underlying ServerContext socket.
 */
export function setServerTimeout(server: Server, timeoutMs: number): void {
  const internal = server as unknown as ServerWithCtx;
  if (internal.ctx) {
    internal.ctx.timeout = timeoutMs;
  }
}

/**
 * Safely destroys the underlying HTTP agent socket connections on the ServerContext.
 */
export function destroyServerAgent(server: Server): void {
  const internal = server as unknown as ServerWithCtx;
  try {
    if (internal.ctx?.agent) {
      internal.ctx.agent.destroy();
    }
  } catch {
    /* ignore agent destruction errors */
  }
}

/**
 * Safely replaces the HTTP agent on ServerContext with a non-keepAlive agent.
 */
export function resetServerAgent(server: Server): void {
  const internal = server as unknown as ServerWithCtx;
  if (internal.ctx) {
    const http = require("http");
    internal.ctx.agent = new http.Agent({ keepAlive: false });
  }
}

/**
 * Safely executes a raw RDS command using the server's ServerContext.
 */
export async function sendServerRdsCommand(
  server: Server,
  command: string,
  args: (string | Buffer)[],
): Promise<Buffer> {
  const internal = server as unknown as ServerWithCtx;
  if (!internal.ctx) {
    throw new Error("Server context is undefined");
  }
  return sendRdsCommand(internal.ctx, command, args);
}
