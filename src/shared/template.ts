import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(__dirname, '..', '..');
const templatesDir = resolve(rootDir, 'web', 'templates');

const ROUTE_MAP: Record<string, string> = {
  'pages/app/dashboard.html': '/web/',
  'pages/app/crash_list.html': '/web/crashes',
  'pages/app/crash_detail.html': '/web/crashes',
  'pages/app/feedback_list.html': '/web/feedback',
  'pages/app/symbol_list.html': '/web/symbols',
  'pages/app/account_list.html': '/web/accounts',
  'pages/app/container_list.html': '/web/containers',
};

export function templateToRoute(name: string): string {
  return ROUTE_MAP[name] ?? '/web/';
}

/**
 * Load a partial template file.
 */
export function loadPartial(name: string): string {
  try {
    return readFileSync(resolve(templatesDir, 'partials', name), 'utf-8');
  } catch {
    return `<!-- partial not found: ${name} -->`;
  }
}

/**
 * Render a template with the layout shell.
 * Replaces {{HEAD}} with the head partial, {{TITLE}} for page title,
 * {{SUBTITLE}} for the header subtitle, {{CONTENT}} for nav active state,
 * and {{BODY}} for the page content.
 */
export function renderTemplate(templatePath: string, title: string): string {
  try {
    const layout = readFileSync(resolve(templatesDir, 'layout.html'), 'utf-8');
    const body = readFileSync(resolve(templatesDir, templatePath), 'utf-8');

    const headPartial = loadPartial('head.html').replace('__TITLE__', title);

    return layout
      .replace('{{HEAD}}', headPartial)
      .replace('{{TITLE}}', title)
      .replace('{{SUBTITLE}}', title)
      .replace('{{CONTENT}}', templateToRoute(templatePath))
      .replace('{{BODY}}', body);
  } catch (err) {
    return `<!DOCTYPE html><html><body><h1>Error: Template not found: ${templatePath}</h1><pre>${err}</pre></body></html>`;
  }
}

/**
 * Render a standalone page (no layout shell, for auth pages).
 * Replaces __TITLE__ in the head partial and {{BODY}} in the page template.
 */
export function renderStandalone(templatePath: string, title: string): string {
  try {
    const page = readFileSync(resolve(templatesDir, templatePath), 'utf-8');
    const headPartial = loadPartial('head.html').replace('__TITLE__', title);
    return page.replace('{{HEAD}}', headPartial);
  } catch {
    return `<!DOCTYPE html><html><body><h1>Error: Template not found: ${templatePath}</h1></body></html>`;
  }
}
