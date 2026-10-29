export type Action = <T = unknown>(method: string, params?: unknown, message?: string) => Promise<T | null>;
