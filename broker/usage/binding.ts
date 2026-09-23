// Persistence for the fleet card's own thread, so a broker restart edits the card it already owns
// instead of opening a second "Fleet: Usage" thread beside the first one.
//
// A thin caller over the shared binding module (`broker/card-binding.ts`), which owns the
// snapshot format, the write, and the failure handling; this file supplies only the usage card's
// label and the type and function names its own tests and importers expect.
//
// Its own file rather than a record inside `discord-threads.json`, because that file belongs to the
// session surface: every binding in it whose session is absent from the registry's view set is
// retired and deleted on the next pass, and no registry record will ever name this thread.
import {
  loadCardBinding,
  saveCardBinding,
  type CardBinding,
  type LoadCardBindingOptions,
} from "../card-binding.ts";

export type UsageCardBinding = CardBinding;
export type LoadUsageBindingOptions = LoadCardBindingOptions;

/** The thread this broker already owns, or null when there is none to rebind to. */
export function loadUsageBinding(
  file: string,
  options: LoadUsageBindingOptions = {},
): UsageCardBinding | null {
  return loadCardBinding(file, "usage", options);
}

export function saveUsageBinding(file: string, binding: UsageCardBinding): void {
  saveCardBinding(file, binding);
}
