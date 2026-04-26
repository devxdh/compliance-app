"use client";

import { Toaster as SonnerToaster } from "sonner";

/**
 * Global toast host for server-action feedback.
 *
 * @returns Sonner toaster configured for the neutral Avantii theme.
 */
export function Toaster() {
  return (
    <SonnerToaster
      closeButton
      position="bottom-right"
      toastOptions={{
        classNames: {
          toast: "border bg-background text-foreground shadow-sm",
          description: "text-muted-foreground",
          actionButton: "bg-primary text-primary-foreground",
          cancelButton: "bg-muted text-muted-foreground",
        },
      }}
    />
  );
}
