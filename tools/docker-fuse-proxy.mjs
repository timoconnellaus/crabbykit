/**
 * Docker socket proxy that injects SYS_ADMIN capability and /dev/fuse device
 * into container create requests. This enables FUSE mounts (e.g., tigrisfs for R2)
 * inside containers started by wrangler dev, which doesn't support --privileged.
 *
 * Usage:
 *   node tools/docker-fuse-proxy.mjs
 *   DOCKER_HOST=unix:///tmp/docker-fuse-proxy.sock npx wrangler dev
 */

import fs from "node:fs";
import net from "node:net";

const PROXY_SOCK = "/tmp/docker-fuse-proxy.sock";

function findDockerSocket() {
  const candidates = [
    process.env.REAL_DOCKER_HOST?.replace("unix://", ""),
    `${process.env.HOME}/.orbstack/run/docker.sock`,
    "/var/run/docker.sock",
    `${process.env.HOME}/.docker/run/docker.sock`,
    `${process.env.HOME}/.colima/default/docker.sock`,
  ].filter(Boolean);

  for (const sock of candidates) {
    try {
      if (fs.statSync(sock).isSocket?.() || fs.existsSync(sock)) return sock;
    } catch {}
  }

  try {
    const resolved = fs.realpathSync("/var/run/docker.sock");
    if (fs.existsSync(resolved)) return resolved;
  } catch {}

  console.error("Could not find Docker socket. Set REAL_DOCKER_HOST=unix:///path/to/docker.sock");
  process.exit(1);
}

const REAL_DOCKER_SOCK = findDockerSocket();

// Clean up stale socket
try {
  fs.unlinkSync(PROXY_SOCK);
} catch {}

let connId = 0;

const server = net.createServer((clientConn) => {
  const id = ++connId;
  const dockerConn = net.createConnection(REAL_DOCKER_SOCK);
  let buffering = true;
  let requestBuffer = Buffer.alloc(0);

  clientConn.on("data", (chunk) => {
    if (!buffering) {
      dockerConn.write(chunk);
      return;
    }

    requestBuffer = Buffer.concat([requestBuffer, chunk]);

    const headersEnd = requestBuffer.indexOf("\r\n\r\n");
    if (headersEnd === -1) return;

    const headersStr = requestBuffer.subarray(0, headersEnd).toString();
    const firstLine = headersStr.split("\r\n")[0];

    const isCreate = /^POST\s+.*\/containers\/create/i.test(firstLine);

    if (!isCreate) {
      buffering = false;
      dockerConn.write(requestBuffer);
      requestBuffer = Buffer.alloc(0);
      return;
    }

    // Container create — need full body
    const clMatch = headersStr.match(/content-length:\s*(\d+)/i);
    const contentLength = clMatch ? parseInt(clMatch[1], 10) : 0;
    const bodyStart = headersEnd + 4;
    const bodyReceived = requestBuffer.length - bodyStart;

    if (bodyReceived < contentLength) return;

    buffering = false;

    const body = requestBuffer.subarray(bodyStart, bodyStart + contentLength);
    const remainder = requestBuffer.subarray(bodyStart + contentLength);

    try {
      const config = JSON.parse(body.toString());

      config.HostConfig = config.HostConfig || {};
      config.HostConfig.CapAdd = config.HostConfig.CapAdd || [];
      if (!config.HostConfig.CapAdd.includes("SYS_ADMIN")) {
        config.HostConfig.CapAdd.push("SYS_ADMIN");
      }
      config.HostConfig.Devices = config.HostConfig.Devices || [];
      const hasFuse = config.HostConfig.Devices.some((d) => d.PathInContainer === "/dev/fuse");
      if (!hasFuse) {
        config.HostConfig.Devices.push({
          PathOnHost: "/dev/fuse",
          PathInContainer: "/dev/fuse",
          CgroupPermissions: "rwm",
        });
      }

      const newBody = Buffer.from(JSON.stringify(config));
      const newHeaders = headersStr.replace(
        /content-length:\s*\d+/i,
        `Content-Length: ${newBody.length}`,
      );

      console.log(`[fuse-proxy] Injected SYS_ADMIN + /dev/fuse → ${config.Image || "unknown"}`);
      dockerConn.write(newHeaders + "\r\n\r\n");
      dockerConn.write(newBody);
    } catch (err) {
      console.error(`[fuse-proxy] Failed to patch: ${err.message}`);
      dockerConn.write(requestBuffer.subarray(0, bodyStart + contentLength));
    }

    requestBuffer = Buffer.alloc(0);
    if (remainder.length > 0) dockerConn.write(remainder);
  });

  dockerConn.on("data", (chunk) => clientConn.write(chunk));
  dockerConn.on("end", () => clientConn.end());
  dockerConn.on("error", (err) => {
    clientConn.destroy();
  });
  clientConn.on("end", () => dockerConn.end());
  clientConn.on("error", (err) => {
    dockerConn.destroy();
  });
});

server.listen(PROXY_SOCK, () => {
  fs.chmodSync(PROXY_SOCK, 0o777);
  console.log(`[fuse-proxy] Listening on ${PROXY_SOCK}`);
  console.log(`[fuse-proxy] Forwarding to ${REAL_DOCKER_SOCK}`);
});

process.on("SIGINT", () => {
  try {
    fs.unlinkSync(PROXY_SOCK);
  } catch {}
  process.exit();
});
process.on("SIGTERM", () => {
  try {
    fs.unlinkSync(PROXY_SOCK);
  } catch {}
  process.exit();
});
