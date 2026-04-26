"use client";

import { ThemeProvider as NextThemesProvider } from "next-themes";

/**
 * Provides class-based light/dark theming for the App Router tree.
 *
 * @param props - next-themes provider configuration and children.
 * @returns Theme context provider used by client theme controls.
 */
export function ThemeProvider(props: React.ComponentProps<typeof NextThemesProvider>) {
  return <NextThemesProvider {...props} />;
}
