export const BROWSER_HEADERS: RegExp;
export const UNREPLAYABLE_BODY: RegExp;
export function isSafeMethod(method: string): boolean;
export type ReplayRequest = { method: string; url: string; headers: Record<string, string>; body?: string | null };
export function applySets(template: ReplayRequest, sets: string[]): { template: ReplayRequest } | { error: string };
export function replayHeaders(headers: Record<string, string> | undefined): Record<string, string>;
export function redactHeadersForDaemon<T>(headers: T): T;
