import type { Response } from 'express';

export function success<T>(data: T) {
  return { success: true as const, data };
}

export function error(message: string, code?: string) {
  return { success: false as const, error: message, ...(code ? { code } : {}) };
}

export function paginated<T>(items: T[], total: number, page: number, pageSize: number) {
  return {
    success: true as const,
    data: items,
    total,
    page,
    page_size: pageSize,
    total_pages: Math.ceil(total / pageSize),
  };
}

export function sendSuccess<T>(res: Response, data: T, status = 200): void {
  res.status(status).json(success(data));
}

export function sendError(res: Response, status: number, message: string, code?: string): void {
  res.status(status).json(error(message, code));
}

export function sendPaginated<T>(res: Response, items: T[], total: number, page: number, pageSize: number): void {
  res.json(paginated(items, total, page, pageSize));
}
