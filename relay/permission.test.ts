// The permission half of the channel protocol, driven against a real MCP server rather than a
// hand-built frame. The wire shape is Claude Code's, not this project's: a field renamed on either
// side produces a relay that connects, declares its capability, and silently answers nothing.
//
// A linked in-memory transport pair stands in for the stdio pipe. That is the same server class,
// the same notification dispatch, and the same capability assertions; only the bytes are skipped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  PERMISSION_CAPABILITY,
  PERMISSION_METHOD,
  PERMISSION_REQUEST_METHOD,
  PermissionRequestNotificationSchema,
  channelCapabilities,
  permissionNotification,
} from "./permission.ts";

/** Claude Code registers a channel's permission handler on the declared capability alone. */
function relayServer(watched = true) {
  return new Server(
    { name: "channel-relay", version: "0.1.0" },
    { capabilities: { experimental: channelCapabilities(watched), tools: {} } },
  );
}

async function linked(server: Server) {
  const client = new Client({ name: "claude-code-stand-in", version: "0.0.0" }, { capabilities: {} });
  const notifications: Array<{ method: string; params?: unknown }> = [];
  client.fallbackNotificationHandler = async (notification) => {
    notifications.push(notification);
  };
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return { client, notifications };
}

test("the method names are the ones Claude Code speaks", () => {
  // Read out of the shipped binary rather than from documentation. Nothing at runtime reports a
  // mismatch: a prompt goes to a handler that is not registered, and the session parks.
  assert.equal(PERMISSION_REQUEST_METHOD, "notifications/claude/channel/permission_request");
  assert.equal(PERMISSION_METHOD, "notifications/claude/channel/permission");
  assert.equal(PERMISSION_CAPABILITY, "claude/channel/permission");
});

test("a permission prompt reaches the handler with all four fields", async () => {
  const server = relayServer();
  const seen: Array<Record<string, unknown>> = [];
  server.setNotificationHandler(PermissionRequestNotificationSchema, (notification) => {
    seen.push(notification.params);
  });
  const { client } = await linked(server);

  await client.notification({
    method: PERMISSION_REQUEST_METHOD,
    params: {
      request_id: "abcde",
      tool_name: "Bash",
      description: "run the migration",
      input_preview: "{ command: npm run migrate }",
    },
  });
  await client.close();
  await server.close();

  assert.deepEqual(seen, [
    {
      request_id: "abcde",
      tool_name: "Bash",
      description: "run the migration",
      input_preview: "{ command: npm run migrate }",
    },
  ]);
});

test("a prompt with no description still reaches the handler", async () => {
  const server = relayServer();
  const seen: Array<Record<string, unknown>> = [];
  server.setNotificationHandler(PermissionRequestNotificationSchema, (notification) => {
    seen.push(notification.params);
  });
  const { client } = await linked(server);

  await client.notification({
    method: PERMISSION_REQUEST_METHOD,
    params: { request_id: "abcde", tool_name: "Bash" },
  });
  await client.close();
  await server.close();

  assert.equal(seen.length, 1, "a schema that refused this would park the session it came from");
  assert.equal(seen[0].request_id, "abcde");
});

test("a verdict leaves the server in the shape Claude Code validates", async () => {
  const server = relayServer();
  const { client, notifications } = await linked(server);

  await server.notification(permissionNotification({ requestId: "abcde", behavior: "allow" }));
  await server.notification(permissionNotification({ requestId: "qrstu", behavior: "deny" }));
  await client.close();
  await server.close();

  assert.deepEqual(
    notifications.map((notification) => notification.params),
    [
      { request_id: "abcde", behavior: "allow" },
      { request_id: "qrstu", behavior: "deny" },
    ],
  );
  for (const notification of notifications) {
    assert.equal(notification.method, PERMISSION_METHOD);
  }
});

test("the relay declares the permission capability alongside the channel one", async () => {
  // Claude Code registers the verdict handler only for a server declaring this, and routes a
  // prompt only at one declaring both. Read from the negotiated handshake, not from the literal.
  const server = relayServer();
  const { client } = await linked(server);
  const experimental = client.getServerCapabilities()?.experimental;
  await client.close();
  await server.close();

  assert.deepEqual(experimental, { "claude/channel": {}, "claude/channel/permission": {} });
});

test("a relay that cannot reach the broker claims no permission capability", async () => {
  // A session started outside the launch wrapper carries no process token, so it has no thread and
  // no operator. Declaring the capability there would aim prompts at a server nobody reads.
  const server = relayServer(false);
  const { client } = await linked(server);
  const experimental = client.getServerCapabilities()?.experimental;
  await client.close();
  await server.close();

  assert.deepEqual(experimental, { "claude/channel": {} });
});
