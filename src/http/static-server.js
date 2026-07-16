import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
});

export class StaticServer {
  constructor(publicDirectory) {
    this.publicDirectory = path.resolve(publicDirectory);
  }

  async handle(request, response) {
    if (!['GET', 'HEAD'].includes(request.method)) {
      return false;
    }
    const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
    if (url.pathname === '/') {
      response.writeHead(302, { Location: '/admin/' });
      response.end();
      return true;
    }
    if (url.pathname === '/admin') {
      response.writeHead(308, { Location: '/admin/' });
      response.end();
      return true;
    }
    let relativePath;
    if (/^\/store\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) {
      relativePath = 'store.html';
    } else if (url.pathname.startsWith('/admin/')) {
      relativePath = url.pathname === '/admin/'
        ? 'index.html'
        : decodeURIComponent(url.pathname.slice('/admin/'.length));
    } else {
      return false;
    }
    const filePath = path.resolve(this.publicDirectory, relativePath);
    if (filePath !== this.publicDirectory && !filePath.startsWith(`${this.publicDirectory}${path.sep}`)) {
      return false;
    }
    try {
      const fileStats = await stat(filePath);
      if (!fileStats.isFile()) {
        return false;
      }
      const body = await readFile(filePath);
      const extension = path.extname(filePath).toLowerCase();
      response.setHeader('Content-Type', CONTENT_TYPES[extension] || 'application/octet-stream');
      response.setHeader('Content-Length', body.length);
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('X-Frame-Options', 'DENY');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'",
      );
      response.setHeader('Cache-Control', extension === '.html' ? 'no-store' : 'public, max-age=300');
      response.writeHead(200);
      response.end(request.method === 'HEAD' ? undefined : body);
      return true;
    } catch (error) {
      if (error.code === 'ENOENT' || error.code === 'EISDIR') {
        return false;
      }
      throw error;
    }
  }
}
