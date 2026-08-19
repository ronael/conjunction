import { Box, Text, useInput } from "ink";
import React from "react";

/**
 * Robust single/multiline text field. Uses Ink's useInput so:
 * - printable characters insert at the cursor (paste including \n works);
 * - backspace/delete, left/right arrows, home/end;
 * - a visible block cursor that never shifts the text;
 * - keys like q stay letters — no global shortcut leaks into the field.
 *
 * Multiline is supported by letting `\n` land in the value; Enter is reserved
 * for "continue" (passed to onContinue).
 */
export function TextField({
  value,
  cursor,
  onChange,
  onContinue,
  onEscape,
  placeholder,
  multiline = false,
  active = true,
}: {
  value: string;
  cursor: number;
  onChange: (value: string, cursor: number) => void;
  onContinue: () => void;
  onEscape?: () => void;
  placeholder?: string | undefined;
  multiline?: boolean;
  active?: boolean;
}): React.JSX.Element {
  useInput(
    (input, key) => {
      if (key.escape || (key.ctrl && input === "c")) {
        onEscape?.();
      } else if (key.leftArrow) {
        onChange(value, Math.max(0, cursor - 1));
      } else if (key.rightArrow) {
        onChange(value, Math.min(value.length, cursor + 1));
      } else if (key.backspace) {
        const next = Math.max(0, cursor - 1);
        onChange(value.slice(0, next) + value.slice(cursor), next);
      } else if (key.delete) {
        onChange(value.slice(0, cursor) + value.slice(cursor + 1), cursor);
      } else if (key.home) {
        onChange(value, 0);
      } else if (key.end) {
        onChange(value, value.length);
      } else if (key.return) {
        if (multiline) {
          onChange(value.slice(0, cursor) + "\n" + value.slice(cursor), cursor + 1);
        } else {
          onContinue();
        }
      } else if (input) {
        onChange(value.slice(0, cursor) + input + value.slice(cursor), cursor + input.length);
      }
    },
    { isActive: active },
  );

  const before = value.slice(0, cursor);
  const after = value.slice(cursor);
  return (
    <Box flexDirection="column">
      {value.length === 0 && placeholder !== undefined && (
        <Box>
          <Text dimColor wrap="wrap">
            {placeholder}
          </Text>
          <Text backgroundColor="cyan" color="black">
            {" "}
          </Text>
        </Box>
      )}
      {value.length > 0 && (
        <Text wrap="wrap">
          {before}
          <Text backgroundColor="cyan" color="black">
            {" "}
          </Text>
          {after}
        </Text>
      )}
    </Box>
  );
}
