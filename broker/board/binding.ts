// Persistence for the board card's own thread, so a broker restart edits the card it already owns
// instead of opening a second "Fleet: Board" thread beside the first one.
//
// A thin caller over the shared binding module (`broker/card-binding.ts`), which owns the
// snapshot format, the write, and the failure handling; this file supplies only the board card's
// label and the type and function names its own tests and importers expect.
import {
  loadCardBinding,
  saveCardBinding,
  type CardBinding,
  type LoadCardBindingOptions,
} from "../card-binding.ts";

export type BoardCardBinding = CardBinding;
export type LoadBoardBindingOptions = LoadCardBindingOptions;

/** The thread this broker already owns, or null when there is none to rebind to. */
export function loadBoardBinding(
  file: string,
  options: LoadBoardBindingOptions = {},
): BoardCardBinding | null {
  return loadCardBinding(file, "board", options);
}

export function saveBoardBinding(file: string, binding: BoardCardBinding): void {
  saveCardBinding(file, binding);
}
