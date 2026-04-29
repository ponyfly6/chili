import { chiliDarkTheme } from "./palettes.js";
import type { TuiTheme } from "./types.js";

export interface SystemPaletteInput {
  palette?: readonly (string | null | undefined)[] | undefined;
  defaultForeground?: string | null | undefined;
  defaultBackground?: string | null | undefined;
}

export function generateSystemTheme(input: SystemPaletteInput | null | undefined): TuiTheme | undefined {
  if (!input) return undefined;

  const background = colorOr(input.defaultBackground, colorOr(input.palette?.[0], chiliDarkTheme.colors.background));
  const foreground = colorOr(input.defaultForeground, colorOr(input.palette?.[7], chiliDarkTheme.colors.text.primary));
  const accent = colorOr(input.palette?.[6], chiliDarkTheme.colors.accent.primary);
  const error = colorOr(input.palette?.[1], chiliDarkTheme.colors.status.error);
  const success = colorOr(input.palette?.[2], chiliDarkTheme.colors.status.success);
  const warning = colorOr(input.palette?.[3], chiliDarkTheme.colors.status.warning);
  const info = colorOr(input.palette?.[4], chiliDarkTheme.colors.status.info);

  const panel = mix(background, foreground, 0.06);
  const overlay = mix(background, foreground, 0.1);
  const muted = mix(foreground, background, 0.38);
  const disabled = mix(foreground, background, 0.55);
  const border = mix(background, foreground, 0.22);
  const subtleBorder = mix(background, foreground, 0.12);
  const selectedBackground = mix(background, accent, 0.2);

  return {
    id: "system",
    name: "System",
    colors: {
      background,
      panel,
      overlay,
      text: {
        primary: foreground,
        secondary: mix(foreground, background, 0.18),
        muted,
        disabled,
        inverse: background,
      },
      border: {
        subtle: subtleBorder,
        default: border,
        focus: accent,
        warning: mix(background, warning, 0.45),
        danger: mix(background, error, 0.45),
      },
      accent: {
        primary: accent,
        secondary: info,
        muted: mix(background, accent, 0.42),
      },
      status: {
        success,
        warning,
        error,
        info,
        pending: warning,
      },
      input: {
        background,
        text: foreground,
        placeholder: disabled,
        cursor: foreground,
        disabledText: muted,
        disabledBorder: subtleBorder,
      },
      menu: {
        background: overlay,
        selectedBackground,
        selectedText: foreground,
        text: muted,
        muted: disabled,
      },
    },
  };
}

function colorOr(value: string | null | undefined, fallback: string): string {
  return normalizeHexColor(value) ?? fallback;
}

export function normalizeHexColor(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const short = trimmed.match(/^#([0-9a-fA-F]{3})$/);
  const shortHex = short?.[1];
  if (shortHex) {
    return `#${shortHex.split("").map((char) => `${char}${char}`).join("").toLowerCase()}`;
  }
  const long = trimmed.match(/^#([0-9a-fA-F]{6})(?:[0-9a-fA-F]{2})?$/);
  const longHex = long?.[1];
  if (!longHex) return undefined;
  return `#${longHex.toLowerCase()}`;
}

function mix(left: string, right: string, rightWeight: number): string {
  const leftRgb = hexToRgb(left);
  const rightRgb = hexToRgb(right);
  const clampedWeight = Math.min(1, Math.max(0, rightWeight));
  const leftWeight = 1 - clampedWeight;
  return rgbToHex({
    r: Math.round(leftRgb.r * leftWeight + rightRgb.r * clampedWeight),
    g: Math.round(leftRgb.g * leftWeight + rightRgb.g * clampedWeight),
    b: Math.round(leftRgb.b * leftWeight + rightRgb.b * clampedWeight),
  });
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const normalized = normalizeHexColor(hex) ?? chiliDarkTheme.colors.background;
  return {
    r: Number.parseInt(normalized.slice(1, 3), 16),
    g: Number.parseInt(normalized.slice(3, 5), 16),
    b: Number.parseInt(normalized.slice(5, 7), 16),
  };
}

function rgbToHex(rgb: { r: number; g: number; b: number }): string {
  return `#${toHexByte(rgb.r)}${toHexByte(rgb.g)}${toHexByte(rgb.b)}`;
}

function toHexByte(value: number): string {
  return Math.min(255, Math.max(0, value)).toString(16).padStart(2, "0");
}
