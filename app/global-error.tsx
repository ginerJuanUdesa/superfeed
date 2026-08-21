"use client";

export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html lang="en">
      <body
        style={{
          fontFamily:
            "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
          padding: "2rem",
          maxWidth: "40rem",
          margin: "0 auto",
        }}
      >
        <h2 style={{ marginBottom: "0.5rem" }}>Something went wrong</h2>
        <p style={{ color: "#888", marginBottom: "1rem" }}>
          {error.message || "Unknown error"}
        </p>
        {error.digest ? (
          <p style={{ color: "#aaa", fontSize: "0.85rem", marginBottom: "1rem" }}>
            digest: <code>{error.digest}</code>
          </p>
        ) : null}
        <button
          onClick={() => unstable_retry()}
          style={{
            padding: "0.5rem 1rem",
            border: "1px solid #ccc",
            borderRadius: "0.375rem",
            background: "transparent",
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}
