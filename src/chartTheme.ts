// Chart color roles (validated categorical palette on the white card surface).
// Status colors are reserved for state, never used as series colors.

export const SERIES_COLORS = ['#2a78d6', '#1baf7a', '#eda100', '#4a3aa7'] as const;

export const STATUS = {
  good: '#0ca30c',
  warning: '#b45309', // amber text-safe step for labels; fills use #fab219
  warningFill: '#fab219',
  critical: '#d03b3b',
} as const;
