import type { Locator } from "playwright";

/**
 * Fields that carry their own mask - `<input type="time">`, the date inputs,
 * and the segmented widgets that render as `--:--` - advance from one segment
 * to the next on their own. Typing the separator advances the caret a second
 * time, so "02:00" lands the hour and then throws the minutes away: the field
 * keeps `02:--` and stays invalid. Digits alone let the mask do the advancing.
 */
async function isMasked(field: Locator): Promise<boolean> {
  return field
    .evaluate((el) => {
      const input = el as HTMLInputElement;
      if (input.tagName !== "INPUT") return false;
      const type = (input.type || "").toLowerCase();
      const MASKED = ["time", "date", "datetime-local", "month", "week"];
      if (MASKED.includes(type)) return true;
      // A placeholder that is nothing but mask characters and separators -
      // `--:--`, `hh:mm`, `dd/mm/yyyy` - is the other tell.
      const hint = (input.placeholder || "").trim();
      return (
        hint.length > 0 &&
        hint.length <= 24 &&
        /[:/.]/.test(hint) &&
        /^[dmyhsDMYHS\-_:/.]+$/.test(hint)
      );
    })
    .catch(() => false);
}

const digitsOf = (text: string) => text.replace(/\D/g, "");

/**
 * Type into a field the way a person would.
 *
 * Outside cinematic mode the text is set in one go; nobody is watching. In
 * cinematic mode it is typed character by character, because the recording
 * shows the field filling up - `fill()` would make the whole string appear at
 * once. Masked fields get their digits only, and are read back afterwards:
 * when the mask has eaten a keystroke anyway, the value is set directly rather
 * than left half-entered.
 */
export async function typeInto(
  field: Locator,
  value: string,
  options: { cinematic?: boolean; timeout?: number } = {},
): Promise<void> {
  const timeout = options.timeout ?? 10_000;

  if (!options.cinematic) {
    await field.fill(value, { timeout });
    return;
  }

  await field.click({ timeout });

  const masked = await isMasked(field);

  // A mask refuses fill(""), so fall back to clearing it by hand.
  await field.fill("", { timeout }).catch(async () => {
    await field.press("ControlOrMeta+a").catch(() => undefined);
    await field.press("Delete").catch(() => undefined);
  });

  await field.pressSequentially(masked ? digitsOf(value) : value, { delay: 45 });

  if (!masked) return;

  // Read it back. A segmented widget that never exposed a value throws here,
  // and an empty read is itself a failure to land.
  const landed = await field.inputValue().catch(() => "");
  if (landed && digitsOf(landed) === digitsOf(value)) return;

  await field.fill(value, { timeout }).catch(() => undefined);
}
