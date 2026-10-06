export async function withTimeoutRetry<T> (
    fn: () => Promise<T>,
    opts: { timeoutMs?: number; retries?: number; label?: string } = {}
): Promise<T> {
    const { timeoutMs = 15000, retries = 2, label = "request" } = opts;
    let lastError: unknown;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            return await withTimeout(fn(), timeoutMs, label);
        } catch (err) {
            lastError = err;
            console.warn(`[retry] ${label} ${attempt + 1}th failed`);
        }
    }
    throw lastError;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout ${ms}ms`)), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
