// The permission half of the channel protocol: the prompt Claude Code pushes at this server, and
// the verdict this server pushes back.
//
// Claude Code routes a permission prompt only at a channel server that declares **both**
// `claude/channel` and `claude/channel/permission`, and it registers the verdict handler on the
// same condition. So the capability and this file arrive together: declaring it without a working
// handler aims prompts at a server that drops them, and a dropped prompt is a session parked on a
// question nobody is being asked.
//
// The prompt is delivered to every connected channel server at once and is answered by whichever
// one replies first. Nothing about the request is a secret, and nothing in it is authorization:
// what makes an answer the operator's is the sender gate the broker applies to the Discord message
// the verdict was typed in.
import { z } from "zod";

export const PERMISSION_CAPABILITY = "claude/channel/permission";

/** The capability that makes this server a channel at all. */
export const CHANNEL_CAPABILITY = "claude/channel";

/**
 * What the relay declares. The permission capability is claimed only by a relay that can reach the
 * broker, because a prompt is fanned out to every server declaring it and answered by whichever
 * one answers: a relay with no process token would be one more server the prompt is aimed at and
 * nobody reads, and the operator would never see it.
 */
export function channelCapabilities(watched: boolean): Record<string, object> {
  return watched
    ? { [CHANNEL_CAPABILITY]: {}, [PERMISSION_CAPABILITY]: {} }
    : { [CHANNEL_CAPABILITY]: {} };
}

/** Claude Code to this server: one tool call is waiting on a yes or a no. */
export const PERMISSION_REQUEST_METHOD = "notifications/claude/channel/permission_request";

/** This server to Claude Code: the answer, naming the request it answers. */
export const PERMISSION_METHOD = "notifications/claude/channel/permission";

/**
 * `request_id` and `tool_name` are always sent. The two descriptive fields are optional here
 * because a prompt missing one is still a prompt the session is parked on: a schema that refused
 * it would turn a cosmetic gap into a hung turn, and the broker renders an absent field as such.
 */
export const PermissionRequestNotificationSchema = z.object({
  method: z.literal(PERMISSION_REQUEST_METHOD),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string().optional(),
    input_preview: z.string().optional(),
  }),
});

export type PermissionVerdict = { requestId: string; behavior: "allow" | "deny" };

export type PermissionNotification = {
  method: typeof PERMISSION_METHOD;
  params: { request_id: string; behavior: "allow" | "deny" };
};

/** The verdict, in the shape Claude Code validates it in. */
export function permissionNotification(verdict: PermissionVerdict): PermissionNotification {
  return {
    method: PERMISSION_METHOD,
    params: { request_id: verdict.requestId, behavior: verdict.behavior },
  };
}
