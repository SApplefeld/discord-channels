// Persistence for the inbox card's own thread, so a broker restart edits the card it already owns
// instead of opening a second "Fleet: Inbox" thread beside the first one.
//
// A thin caller over the shared binding module (`broker/card-binding.ts`), which owns the
// snapshot format, the write, and the failure handling; this file supplies only the inbox card's
// label and the type and function names its own tests and importers expect.
import {
  loadCardBinding,
  saveCardBinding,
  type CardBinding,
  type LoadCardBindingOptions,
} from "../card-binding.ts";

export type InboxCardBinding = CardBinding;
export type LoadInboxBindingOptions = LoadCardBindingOptions;

/** The thread this broker already owns, or null when there is none to rebind to. */
export function loadInboxBinding(
  file: string,
  options: LoadInboxBindingOptions = {},
): InboxCardBinding | null {
  return loadCardBinding(file, "inbox", options);
}

export function saveInboxBinding(file: string, binding: InboxCardBinding): void {
  saveCardBinding(file, binding);
}
