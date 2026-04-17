"use client";

export default function TenantError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[50vh] items-center justify-center">
      <div className="max-w-md text-center">
        <h2 className="text-lg font-semibold text-gray-900">Something went wrong</h2>
        <p className="mt-2 text-sm text-gray-600">
          {error.message || "An unexpected error occurred."}
        </p>
        <button
          onClick={reset}
          className="mt-4 rounded-md bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-500"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
